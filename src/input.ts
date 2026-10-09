import readline from "node:readline/promises";
import { once } from "node:events";
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import { dirname, join } from "node:path";
import os from "node:os";
import type { AssistantContent, Tool } from "ai";
import { assertAtBuildtime } from "./assert.ts";
import {
  isAbortError,
  isReadlineClosedError,
  tryCatchAsync,
  getMessageFromError,
  normalizeNewline,
  getTempFileName,
  isExisty,
  shellQuote,
  listSessionFiles,
  stringify,
  getStrFromAssistantContent,
  markdownFence,
  isNullish,
  safeStringify,
  getPrettyDate,
  sleep,
} from "./utils.ts";
import { truncate } from "./text.ts";
import {
  errorWithSpacing,
  print,
  printNewline,
  printSessionStartDate,
  startLoadingState,
  stopLoadingState,
  successWithSpacing,
  wrapInColor,
} from "./print.ts";
import { fencePrint, wrapInFence } from "./fence.ts";
import {
  getPrettyContextWindowUsage,
  getPrettyMoney,
  getPrettyTokenUsage,
  getUsageMoneyForModel,
  sumUsageTokens,
} from "./usage-format.ts";
import {
  getApproxPromptTokens,
  getPrettyTokensByArea,
  getTokensByArea,
  isUsageLimitDisabled,
  warnOnLargePromptOverhead,
} from "./usage.ts";
import { actions, getState } from "./state.ts";
import { initStateRepeatable } from "./config.ts";
import { isSameKey, type Key } from "./config-types.ts";
import { aiDeps, childProcessDeps, fsDeps, processDeps } from "./deps.ts";
import { getGlobalConfigPath, getLocalConfigPath } from "./paths.ts";
import { contextFileSkillNamePrefix } from "./context.ts";
import { execGitDiff } from "./differ.ts";
import { formatMarkdown, openWithPager } from "./terminal.ts";
import {
  builtinSlashCommands,
  getAvailableCommandsStr,
  getCustomSlashCommandsStr,
  type BuiltinSlashCommand,
} from "./slash-commands.ts";
import {
  getAppendedTranscript,
  resumeFromSessionFile,
  syncSessionFile,
} from "./log.ts";
import { harnessTools } from "./tools.ts";
import { getTranscriptionProvider } from "./model.ts";

// https://stackoverflow.com/a/33500118
export const mutedStdout = new Writable({
  write(
    out: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    if (shouldMuteStdout()) return callback();

    processDeps.stdout.write(out);
    callback();
  },
});

Object.defineProperties(mutedStdout, {
  columns: {
    get: () => stdout.columns,
    enumerable: true,
    configurable: true,
  },
  rows: {
    get: () => stdout.rows,
    enumerable: true,
    configurable: true,
  },
});

export function shouldMuteStdout() {
  const { loadingStateTimeout, isNonBlockingProcessOngoing } =
    getState().terminal;
  return loadingStateTimeout !== null || isNonBlockingProcessOngoing;
}

export function initStdin() {
  if (stdin.isTTY) {
    // switch the terminal out of cooked mode:
    // - deliver each keystroke to the process as it is typed instead of after enter
    // - stop the kernel from echoing input
    // - stop ctrl+c from generating SIGINT so it arrives as a regular keypress
    // after readline is initialized:
    // - rl echos input, which is selectively muted via mutedStdout
    // - rl has its own SIGINT handler
    stdin.setRawMode(true);
  }

  // decode raw stdin bytes into "keypress" events so the listener below receives structured keys
  emitKeypressEvents(stdin);

  stdin.on("keypress", (char: string, key: Key) => {
    if (!getState().terminal.isInitializing) return;

    if (key.ctrl === true && key.name === "c") process.exit(130);
    if (key.name === "return" || key.name === "enter") return;
    if (!isTypeableKey(key)) return;
    if (typeof char !== "string") return;
    actions.appendBufferedInputWhileInitializing(char);
  });
}

export function initStdout() {
  if (stdout.isTTY) {
    stdout.on("resize", () => {
      mutedStdout.emit("resize");
    });
  }
}

export function initReadline() {
  const rl = readline.createInterface({
    input: stdin,
    output: mutedStdout,
    terminal: true,
  });
  actions.setRl(rl);

  initKeypress(rl);
  initSigInt(rl);
}

export function initKeypress(rl: readline.Interface) {
  function typeCommand(command: string) {
    const output = `/${command}\n`;
    rl.write(output);
    actions.appendStdoutTail(output);
  }

  // Reprints the readline prompt line and any half-typed input after pager
  // commands so the pending question and its input stay visible and editable
  function redrawPendingQuestion() {
    if (getState().abortControllers.question === null) return;
    rl.prompt(true);
    actions.appendStdoutTail(getState().config.promptPrefix);
  }

  async function wrapToOpenNonBlockingProcess(
    cb: () => Promise<string | null>,
    { pauseStdin = true }: { pauseStdin?: boolean } = {},
  ) {
    actions.setIsNonBlockingProcessOngoing(true);
    stopLoadingState();
    if (pauseStdin) stdin.pause();
    const ret = await cb();
    stdin.resume();
    actions.setIsNonBlockingProcessOngoing(false);
    const bufferedStdout = getState().terminal.bufferedStdoutWhileEditorOpen;
    if (bufferedStdout.length > 0) {
      processDeps.stdout.write(bufferedStdout);
      actions.resetBufferedStdoutWhileEditorOpen();
    }
    if (getState().abortControllers.apiStream !== null) {
      startLoadingState();
    }
    return ret;
  }

  stdin.on("keypress", (_char, key: Key) => {
    void (async () => {
      if (key.ctrl === true && key.name === "d") {
        await exitSession();
        return;
      }

      if (getState().terminal.isNonBlockingProcessOngoing) return;
      if (getState().terminal.isRecording) return;

      const keymaps = getState().config.keymaps;

      for (const command of builtinSlashCommands) {
        const keymap = keymaps[command];
        if (keymap === undefined) continue;
        if (!isSameKey(key, keymap)) continue;

        switch (command) {
          case "edit": {
            const editorContent = await wrapToOpenNonBlockingProcess(
              spawnAndReadEditorContent,
            );

            if (editorContent === null) {
              redrawPendingQuestion();
            } else {
              abortRlQuestionForEditorIfActive(editorContent);
            }

            return;
          }
          case "record": {
            if (getState().abortControllers.question !== null) {
              typeCommand(command);
              return;
            }

            actions.setIsRecording(true);
            const transcriptionInput = await wrapToOpenNonBlockingProcess(
              recordAndTranscribeInput,
              { pauseStdin: false },
            );
            actions.setIsRecording(false);

            if (transcriptionInput !== null) {
              actions.appendEditorInputValue(
                `\n${getState().config.messageQueueDelimiter}${transcriptionInput}`,
              );
            }
            return;
          }
          case "editpage": {
            await pageEditStr();
            redrawPendingQuestion();
            return;
          }
          case "paste": {
            const editorContent = await wrapToOpenNonBlockingProcess(() =>
              spawnAndReadEditorContent({ includeClipboardSuffix: true }),
            );

            if (editorContent === null) {
              redrawPendingQuestion();
            } else {
              abortRlQuestionForEditorIfActive(editorContent);
            }
            return;
          }
          case "history": {
            await pageHistory();
            redrawPendingQuestion();
            return;
          }
          case "config": {
            const initialContentStr = getAllPrettyConfig();

            await openWithPager({
              initialContentStr,
              contentType: "markdown",
            });
            redrawPendingQuestion();

            return;
          }
          case "lastresponse": {
            await pageLastResponse();
            redrawPendingQuestion();
            return;
          }
          case "lastmessage": {
            await pageLastMessage();
            redrawPendingQuestion();
            return;
          }
          case "lastdiff": {
            await pageLastDiff();
            redrawPendingQuestion();
            return;
          }
          case "summaries": {
            await pageSummaries();
            redrawPendingQuestion();
            return;
          }
          case "reload": {
            await reload();
            redrawPendingQuestion();
            return;
          }
          case "commands": {
            await pageCommands();
            redrawPendingQuestion();
            return;
          }
          case "tools": {
            await pageTools();
            redrawPendingQuestion();
            return;
          }
          case "initlocal":
          case "initglobal":
          case "model":
          case "skills":
          case "context":
          case "keymaps":
          case "usage":
          case "tokens":
          case "resume":
          case "clear": {
            if (getState().abortControllers.question !== null) {
              typeCommand(command);
            }
            return;
          }
          default: {
            command satisfies never;
          }
        }
      }

      for (const slashCommand of getState().content.slashCommands) {
        const keymap = keymaps[slashCommand.name];
        if (keymap === undefined) continue;
        if (!isSameKey(key, keymap)) continue;

        if (getState().abortControllers.question !== null) {
          typeCommand(slashCommand.name);
        }
        return;
      }

      // mutedStdout prevents echoing, but readline's internal state still needs to be cleared
      if (getState().terminal.loadingStateTimeout !== null) {
        rl.write(null, { ctrl: true, name: "u" });
      }
    })();
  });
}

function getDefaultPasteCmd() {
  if (os.platform() === "darwin") return "pbpaste";
  if (os.platform() === "linux") return "xclip -selection clipboard -o";
  return "";
}

function getPrefilledEditorContent() {
  const editorInputValue = getState().terminal.editorInputValue;
  if (editorInputValue !== null) return normalizeNewline(editorInputValue);
  return "";
}

function getReadlineContent(rl: readline.Interface) {
  if (rl.line.length > 0) return rl.line;
  return "";
}

async function getEditorInitialContent(opts: {
  includeClipboardSuffix: boolean;
}) {
  const rl = getState().terminal.rl;
  assertAtBuildtime(rl !== null);

  const prefilledEditorContent = getPrefilledEditorContent();

  const readlineContent = getReadlineContent(rl);

  let clipboardContent = "";
  if (opts.includeClipboardSuffix) {
    const pasteCmd =
      processDeps.env.get("LASSO_CLIPBOARD_PASTE") ?? getDefaultPasteCmd();

    const pasteResult = await tryCatchAsync(childProcessDeps.exec(pasteCmd));
    if (pasteResult.ok) {
      clipboardContent = normalizeNewline(pasteResult.value.stdout);
    } else {
      clipboardContent = `[Error executing ${pasteCmd}: ${getMessageFromError(pasteResult.error)}]`;
    }
  }

  return `${prefilledEditorContent}${readlineContent}${clipboardContent}`;
}

function abortRlQuestionForEditorIfActive(editorContent: string) {
  const abortController = getState().abortControllers.question;
  if (abortController !== null) {
    const rl = clearRlLine();
    assertAtBuildtime(rl !== null);

    const truncatedFirstLine = truncate(editorContent);
    rl.write(truncatedFirstLine);
    actions.appendStdoutTail(truncatedFirstLine);

    abortController.abort();
  }
}

export function isTypeableKey(key: Key) {
  const isNotTypeable = key.ctrl === true || key.meta === true;
  return !isNotTypeable;
}

export function initSigInt(rl: readline.Interface) {
  rl.on("SIGINT", () => {
    const apiStream = getState().abortControllers.apiStream;
    const interruptWithEditorContent =
      getState().abortControllers.interruptWithEditorContent;
    const question = getState().abortControllers.question;
    const recordProcess = getState().abortControllers.recordProcess;
    const transcription = getState().abortControllers.transcription;
    const controllers = [
      apiStream,
      interruptWithEditorContent,
      question,
      transcription,
    ];
    assertAtBuildtime(controllers.filter((c) => c !== null).length <= 1);

    if (recordProcess !== null) {
      recordProcess.abort();
      return;
    }

    if (apiStream !== null) {
      apiStream.abort();
      return;
    }

    if (transcription !== null) {
      transcription.abort();
      return;
    }

    if (question !== null) {
      if (rl.line.length > 0) {
        clearRlLine();
        return;
      }
      question.abort();
    }

    if (interruptWithEditorContent !== null) {
      interruptWithEditorContent.abort();
    }
  });
}

function filterIfLength(str: string) {
  return str.length > 0;
}

export async function parseInputFromEditor() {
  const editorInputValue = getState().terminal.editorInputValue;
  assertAtBuildtime(editorInputValue !== null);
  const splitByDelimiterEditorInputValue = editorInputValue
    .split(getState().config.messageQueueDelimiter)
    .filter(filterIfLength);

  const splitByCommandEditorInputValue =
    splitByDelimiterEditorInputValue.flatMap((editorChunk) => {
      const lineElements = editorChunk.split(/(?<=\n)/);

      const smallerChunks: string[] = [];
      let tempBuffer: string[] = [];

      for (const lineElement of lineElements) {
        if (
          shouldResolveSlashCommand(lineElement, { forceKnownCommand: true })
        ) {
          if (tempBuffer.length > 0) {
            smallerChunks.push(tempBuffer.join(""));
            tempBuffer = [];
          }

          smallerChunks.push(lineElement);
        } else {
          tempBuffer.push(lineElement);
        }
      }
      if (tempBuffer.length > 0) smallerChunks.push(tempBuffer.join(""));

      return smallerChunks.filter(filterIfLength);
    });

  const [firstMessage, ...rest] = splitByCommandEditorInputValue;

  if (firstMessage === undefined) {
    actions.setEditorInputValue(null);
    return null;
  }

  if (rest.length === 0) {
    actions.setEditorInputValue(null);
  } else {
    actions.setEditorInputValue(
      rest.join(getState().config.messageQueueDelimiter),
    );
  }

  await syncSessionFile({
    transcript: getAppendedTranscript({
      message: firstMessage,
      role: "user",
      timestamp: Date.now(),
    }),
  });
  return firstMessage;
}

export async function pollUntilNonBlockingProcessClosed() {
  while (getState().terminal.isNonBlockingProcessOngoing) {
    await sleep(100);
  }
}

export async function resolveUserInput({
  isFirstInput,
}: {
  isFirstInput: boolean;
}) {
  const rl = getState().terminal.rl;
  assertAtBuildtime(rl !== null);

  if (getState().terminal.editorInputValue !== null) {
    const editorInput = await parseInputFromEditor();
    if (
      editorInput !== null &&
      shouldResolveSlashCommand(editorInput, { forceKnownCommand: true })
    ) {
      return await resolveSlashCommand(editorInput);
    }
    return editorInput;
  }

  if (!isFirstInput) {
    printNewline();
  }
  fencePrint("Input", { color: "yellow" });
  actions.resetStdout();

  actions.setQuestionAbortController(new AbortController());
  const abortController = getState().abortControllers.question;
  assertAtBuildtime(abortController !== null);
  const bufferedInputWhileInitializing =
    getState().terminal.bufferedInputWhileInitializing;
  const questionResult = tryCatchAsync(
    rl.question(getState().config.promptPrefix, {
      signal: abortController.signal,
    }),
  );
  if (bufferedInputWhileInitializing.length > 0) {
    rl.write(bufferedInputWhileInitializing);
    actions.resetBufferedInputWhileInitializing();
  }
  const inputResult = await questionResult;
  actions.setQuestionAbortController(null);

  if (!inputResult.ok) {
    if (isReadlineClosedError(inputResult.error)) {
      await exitSession();
    }

    if (!isAbortError(inputResult.error)) {
      print.error(getMessageFromError(inputResult.error));
      return null;
    }

    const abortedByEditor = getState().terminal.editorInputValue !== null;
    if (abortedByEditor) {
      const editorInput = await parseInputFromEditor();
      if (
        editorInput !== null &&
        shouldResolveSlashCommand(editorInput, { forceKnownCommand: true })
      ) {
        return await resolveSlashCommand(editorInput);
      }
      return editorInput;
    }

    await resolveExitConfirmation();
    return null;
  }

  actions.appendStdoutTail(
    `${getState().config.promptPrefix}${inputResult.value}\n`,
  );
  await syncSessionFile({
    transcript: getAppendedTranscript({
      message: inputResult.value,
      role: "user",
      timestamp: Date.now(),
    }),
  });

  const rawInput = inputResult.value;
  if (shouldResolveSlashCommand(rawInput, { forceKnownCommand: false })) {
    return await resolveSlashCommand(rawInput);
  }

  return rawInput.trim();
}

export function shouldResolveSlashCommand(
  rawInput: string | null,
  { forceKnownCommand }: { forceKnownCommand: boolean },
): boolean {
  if (rawInput === null) return false;

  const trimmed = rawInput.trim();
  if (trimmed.includes("\n")) return false;
  if (trimmed.at(0) !== "/") return false;

  const spaceIdx = trimmed.search(/\s+/);
  if (forceKnownCommand) {
    const command =
      spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
    const customSlashCommands = getState().content.slashCommands.map(
      (c) => c.name,
    );
    return [...builtinSlashCommands, ...customSlashCommands].includes(command);
  }

  return true;
}

async function exitSession({ isTyped = false }: SpacingOpts = {}) {
  stopLoadingState();
  const rl = getState().terminal.rl;
  assertAtBuildtime(rl !== null);
  rl.close();
  streamingSupportedWithSpacing(isTyped, () => printSessionStartDate());
  await getState().mcp.close();
  process.exit(0);
}

async function resolveExitConfirmation() {
  const rl = getState().terminal.rl;
  assertAtBuildtime(rl !== null);

  actions.setQuestionAbortController(new AbortController());
  const abortController = getState().abortControllers.question;
  assertAtBuildtime(abortController !== null);
  const exitResult = await tryCatchAsync(
    rl.question("y(es) or <C-c> to exit: ", {
      signal: abortController.signal,
    }),
  );
  actions.setQuestionAbortController(null);

  if (!exitResult.ok) {
    if (
      isAbortError(exitResult.error) ||
      isReadlineClosedError(exitResult.error)
    ) {
      await exitSession({ isTyped: true });
    }

    print.error(getMessageFromError(exitResult.error));
    return;
  }

  if (/^y(es)?$/i.exec(exitResult.value) !== null) {
    actions.appendStdoutTail(
      `${getState().config.promptPrefix}${exitResult.value}\n`,
    );

    await exitSession({ isTyped: true });
  }

  return;
}

export async function resolveInterruptWithEditor() {
  const rl = getState().terminal.rl;
  assertAtBuildtime(rl !== null);

  actions.setInterruptWithEditorAbortController(new AbortController());
  const abortController =
    getState().abortControllers.interruptWithEditorContent;
  assertAtBuildtime(abortController !== null);
  print.warning("You have queued messages!");
  const continueResult = await tryCatchAsync(
    rl.question(
      `Edit (${safeStringify(getState().config.keymaps.edit)}), c(lear), or <CR> to continue: `,
      {
        signal: abortController.signal,
      },
    ),
  );
  actions.setInterruptWithEditorAbortController(null);

  if (!continueResult.ok) {
    if (isAbortError(continueResult.error)) return;
    print.error(getMessageFromError(continueResult.error));
    return;
  }

  if (/^c(lear)?$/i.exec(continueResult.value) !== null) {
    actions.setEditorInputValue(null);
  }
}

type ParameterizedBuiltinSlashCommand = "resume" | "model";

interface SlashCommandOutcome {
  handled: boolean;
  inputFromCommand: string | null;
}

async function resolveBuiltinSlashCommand(
  command: BuiltinSlashCommand,
): Promise<SlashCommandOutcome> {
  switch (command) {
    case "edit": {
      actions.setIsNonBlockingProcessOngoing(true);
      const content = await spawnAndReadEditorContent();
      actions.setIsNonBlockingProcessOngoing(false);

      if (content !== null) {
        await syncSessionFile({
          transcript: getAppendedTranscript({
            message: content,
            role: "user",
            timestamp: Date.now(),
          }),
        });
      }
      return { handled: true, inputFromCommand: content };
    }
    case "editpage": {
      await pageEditStr({ isTyped: true });
      return { handled: true, inputFromCommand: null };
    }
    case "paste": {
      actions.setIsNonBlockingProcessOngoing(true);
      const content = await spawnAndReadEditorContent({
        includeClipboardSuffix: true,
      });
      actions.setIsNonBlockingProcessOngoing(false);

      if (content !== null)
        await syncSessionFile({
          transcript: getAppendedTranscript({
            message: content,
            role: "user",
            timestamp: Date.now(),
          }),
        });
      return { handled: true, inputFromCommand: content };
    }
    case "clear": {
      await clearCommand();
      return { handled: true, inputFromCommand: null };
    }
    case "history": {
      await pageHistory({ isTyped: true });
      return { handled: true, inputFromCommand: null };
    }
    case "model": {
      getModel();
      return { handled: true, inputFromCommand: null };
    }
    case "skills": {
      await pageSkills();
      return { handled: true, inputFromCommand: null };
    }
    case "context": {
      await pageAvailableContextFiles();
      return { handled: true, inputFromCommand: null };
    }
    case "commands": {
      await pageCommands();
      return { handled: true, inputFromCommand: null };
    }
    case "keymaps": {
      printKeymaps();
      return { handled: true, inputFromCommand: null };
    }
    case "usage": {
      printUsage();
      return { handled: true, inputFromCommand: null };
    }
    case "tokens": {
      printTokens();
      return { handled: true, inputFromCommand: null };
    }
    case "config": {
      const initialContentStr = getAllPrettyConfig();

      await openWithPager({
        initialContentStr,
        contentType: "markdown",
      });

      return { handled: true, inputFromCommand: null };
    }
    case "resume": {
      const inputFromCommand = await resumeWithNoArgs();
      if (inputFromCommand !== null) {
        await syncSessionFile({
          transcript: getAppendedTranscript({
            message: inputFromCommand,
            role: "user",
            timestamp: Date.now(),
          }),
        });
      }
      return { handled: true, inputFromCommand };
    }
    case "reload": {
      await reload();
      return { handled: true, inputFromCommand: null };
    }
    case "initlocal": {
      await initLocalConfig();
      return { handled: true, inputFromCommand: null };
    }
    case "initglobal": {
      await initGlobalConfig();
      return { handled: true, inputFromCommand: null };
    }
    case "lastresponse": {
      await pageLastResponse({ isTyped: true });
      return { handled: true, inputFromCommand: null };
    }
    case "lastmessage": {
      await pageLastMessage({ isTyped: true });
      return { handled: true, inputFromCommand: null };
    }
    case "lastdiff": {
      await pageLastDiff({ isTyped: true });
      return { handled: true, inputFromCommand: null };
    }
    case "summaries": {
      await pageSummaries({ isTyped: true });
      return { handled: true, inputFromCommand: null };
    }
    case "tools": {
      await pageTools();
      return { handled: true, inputFromCommand: null };
    }
    case "record": {
      actions.setIsRecording(true);
      const inputFromCommand = await recordAndTranscribeInput({
        isTyped: true,
      });
      actions.setIsRecording(false);

      if (inputFromCommand !== null) {
        await syncSessionFile({
          transcript: getAppendedTranscript({
            message: inputFromCommand,
            role: "user",
            timestamp: Date.now(),
          }),
        });
      }
      return { handled: true, inputFromCommand };
    }
    default: {
      command satisfies never;
      return { handled: false, inputFromCommand: null };
    }
  }
}

async function resolveParameterizedBuiltinSlashCommand(
  commandWithArgs: string,
): Promise<SlashCommandOutcome> {
  const parts = commandWithArgs.split(/\s+/);
  const command = parts[0] as ParameterizedBuiltinSlashCommand | undefined;
  if (command === undefined) return { handled: false, inputFromCommand: null };

  switch (command) {
    case "model": {
      setModelCommand(commandWithArgs);
      return { handled: true, inputFromCommand: null };
    }
    case "resume": {
      const inputFromCommand = await resume(commandWithArgs);
      if (inputFromCommand !== null) {
        await syncSessionFile({
          transcript: getAppendedTranscript({
            message: inputFromCommand,
            role: "user",
            timestamp: Date.now(),
          }),
        });
      }
      return { handled: true, inputFromCommand: inputFromCommand };
    }
    default: {
      command satisfies never;
      return { handled: false, inputFromCommand: null };
    }
  }
}

function resolveCustomSlashCommand(commandStr: string): SlashCommandOutcome {
  if (commandStr === "") {
    return { handled: false, inputFromCommand: null };
  }

  const spaceIdx = commandStr.search(/\s+/);

  const command = (() => {
    if (spaceIdx === -1) {
      return commandStr;
    }
    return commandStr.slice(0, spaceIdx);
  })();

  const commandContext = (() => {
    if (spaceIdx === -1) return null;
    return commandStr.slice(spaceIdx).trimStart();
  })();

  const slashCommands = getState().content.slashCommands;
  const matchedCommand = slashCommands.find((c) => c.name === command);

  if (matchedCommand === undefined) {
    return { handled: false, inputFromCommand: null };
  }

  print.infoSubtle(`Executing custom slash command: ${command}`);

  if (commandContext === null || commandContext === "") {
    return {
      handled: true,
      inputFromCommand: normalizeNewline(matchedCommand.content, { count: 0 }),
    };
  }

  const contentWithCommandContext = `# [lasso] Follow the instructions below along with the provided context:

## [lasso] Context
${normalizeNewline(commandContext, { count: 0 })}

## [lasso] Instructions
${normalizeNewline(matchedCommand.content, { count: 0 })}`;

  return { handled: true, inputFromCommand: contentWithCommandContext };
}

export async function resolveSlashCommand(rawInput: string) {
  const commandWithoutSlash = rawInput.trim().slice(1);

  const builtinSlashCommandOutcome = await resolveBuiltinSlashCommand(
    commandWithoutSlash as BuiltinSlashCommand,
  );
  if (builtinSlashCommandOutcome.handled) {
    return builtinSlashCommandOutcome.inputFromCommand;
  }

  const parameterizedBuiltinSlashCommandOutcome =
    await resolveParameterizedBuiltinSlashCommand(commandWithoutSlash);
  if (parameterizedBuiltinSlashCommandOutcome.handled) {
    return parameterizedBuiltinSlashCommandOutcome.inputFromCommand;
  }

  const customSlashCommandOutcome =
    resolveCustomSlashCommand(commandWithoutSlash);
  if (customSlashCommandOutcome.handled) {
    return customSlashCommandOutcome.inputFromCommand;
  }

  printNewline();
  print.error(`Invalid command: ${rawInput}, valid commands:`);
  print.plain(getAvailableCommandsStr());
  return null;
}

export async function clearCommand() {
  print.infoSubtle(`Context cleared (${getPrettyTokenUsage()})`);
  await syncSessionFile({
    messages: [],
    summaries: [],
    transcript: [],
  });
  // the next api call only reports its token usage after it completes, so seeding with the
  // system prompt approx keeps the context window percent from displaying 0% in the meantime
  actions.setPromptTokens(getApproxPromptTokens());
  actions.setModelUsageForSession({});
}

export function printUsage() {
  const { model } = getState().config;
  const pricing = getState().config.pricingPerModel[model];
  const tokenUsageForSession = sumUsageTokens(
    getState().usage.modelUsageForSession[model] ?? [],
  );
  const tokenUsageForLimitWindow = sumUsageTokens(
    getState().usage.modelUsageForLimitWindow[model] ?? [],
  );
  const { usageLimit } = getState().config;

  const usedInSession = (() => {
    const tokensInSession = `${(tokenUsageForSession.inputTokens + tokenUsageForSession.outputTokens).toLocaleString()} tokens`;
    if (pricing === undefined) {
      return tokensInSession;
    }
    const dollarsInSession = `$${getPrettyMoney(getUsageMoneyForModel(tokenUsageForSession, model))}`;
    return `${tokensInSession}, ${dollarsInSession}`;
  })();

  successWithSpacing(() => {
    print.doing("Usage:");
    print.plain(`- Session: ${usedInSession}`);

    if (!isUsageLimitDisabled()) {
      assertAtBuildtime(usageLimit !== undefined);
      const costForLimitWindow = getUsageMoneyForModel(
        tokenUsageForLimitWindow,
        model,
      );

      print.plain(
        `- ${usageLimit.duration} window: $${getPrettyMoney(costForLimitWindow)} of $${getPrettyMoney(usageLimit.dollarAmount)} limit`,
      );
    }
  });
}

export function printTokens() {
  const tokensByArea = getTokensByArea();
  const total =
    tokensByArea.messages +
    tokensByArea.context +
    tokensByArea.tools +
    tokensByArea.basePrompt +
    tokensByArea.skills;

  const prettyContextWindowUsageRaw = getPrettyContextWindowUsage();
  const contextWindowUsage = ` (${prettyContextWindowUsageRaw})`;

  successWithSpacing(() => {
    print.doing(`Token count: ${total.toLocaleString()}${contextWindowUsage}`);
    print.plain(getPrettyTokensByArea());
    printNewline();
  });
}

function getEditCommand(tempFile: string) {
  const quotedTempFile = shellQuote(tempFile);

  const lassoEditEnvValue = processDeps.env.get("LASSO_EDIT");
  if (isExisty(lassoEditEnvValue)) {
    return lassoEditEnvValue.replace("__FILE__", tempFile);
  }

  const editorEnvValue = processDeps.env.get("EDITOR");
  if (isNullish(editorEnvValue) || editorEnvValue.trim() === "") {
    return `vi ${quotedTempFile}`;
  }

  if (editorEnvValue.includes("__FILE__")) {
    return editorEnvValue.replace("__FILE__", tempFile);
  }

  return `${editorEnvValue} ${quotedTempFile}`;
}

export async function spawnAndReadEditorContent(opts?: {
  includeClipboardSuffix?: boolean;
}) {
  const includeClipboardSuffix = opts?.includeClipboardSuffix ?? false;

  const initialContent = await getEditorInitialContent({
    includeClipboardSuffix,
  });

  const tempFile = await getTempFileName();
  if (tempFile === null) {
    print.error("Failed to create a temp file");
    return null;
  }

  const editCommand = getEditCommand(tempFile);

  const writeResult = await tryCatchAsync(
    fsDeps.writeFile(tempFile, initialContent),
  );
  if (!writeResult.ok) {
    print.error("Failed to write to temp file");
    return null;
  }

  const statBefore = await tryCatchAsync(fsDeps.stat(tempFile));

  const editorProcess = childProcessDeps.spawn(editCommand, {
    shell: true,
    stdio: "inherit",
  });
  const onceResult = await tryCatchAsync(once(editorProcess, "exit"));
  if (!onceResult.ok) {
    print.error(
      `Error while spawning the editor: ${getMessageFromError(onceResult.error)}`,
    );
    await tryCatchAsync(fsDeps.unlink(tempFile));
    return null;
  }

  const statAfter = await tryCatchAsync(fsDeps.stat(tempFile));

  const readResult = await tryCatchAsync(fsDeps.readFile(tempFile, "utf8"));
  if (!readResult.ok) {
    print.error("Failed to read from temp file");
    await tryCatchAsync(fsDeps.unlink(tempFile));
    return null;
  }
  await tryCatchAsync(fsDeps.unlink(tempFile));

  if (
    statBefore.ok &&
    statAfter.ok &&
    statBefore.value.mtimeMs === statAfter.value.mtimeMs
  ) {
    return null;
  }

  const trimmedBefore = initialContent.trim();
  const trimmedAfter = readResult.value.trim();

  if (trimmedAfter === "") {
    if (trimmedBefore !== "") {
      actions.setEditorInputValue(null);
    }
    return null;
  }

  actions.setEditorInputValue(readResult.value);
  return normalizeNewline(readResult.value);
}

export function getModel() {
  print.doing(getState().config.model);
  return;
}

export function setModelCommand(rawInput: string) {
  const parts = rawInput.split(/\s+/);

  if (parts.length !== 2) {
    print.error("Usage: /model [model]?");
    return;
  }
  const model = parts[1];
  assertAtBuildtime(model !== undefined);

  const prevModel = getState().config.model;
  actions.setModel(model);
  print.doing(`Model updated from \`${prevModel}\` to \`${model}\``);
  actions.setPromptTokensDirty(true);

  warnOnLargePromptOverhead();
}

export interface SpacingOpts {
  isTyped?: boolean;
}

function streamingSupportedWithSpacing(isTyped: boolean, cb: () => void) {
  if (getState().abortControllers.apiStream !== null) {
    cb();
    return;
  }

  if (isTyped) {
    cb();
    printNewline();
    return;
  }

  printNewline();
  cb();
  printNewline();
}

export async function pageEditStr({ isTyped = false }: SpacingOpts = {}) {
  const { editorInputValue } = getState().terminal;
  if (editorInputValue === null) {
    streamingSupportedWithSpacing(isTyped, () =>
      print.warning("Editor is empty"),
    );
    return;
  }

  const initialContentStr = `# [lasso] Editor content

${editorInputValue}`;

  await openWithPager({
    initialContentStr,
    contentType: "markdown",
  });
}

export async function pageCommands() {
  const initialContentStr = `# Available commands:

${getAvailableCommandsStr()}`;

  await openWithPager({
    initialContentStr,
    contentType: "markdown",
  });
}

export async function pageSkills({ isTyped = false }: SpacingOpts = {}) {
  if (getState().content.skills.length === 0) {
    streamingSupportedWithSpacing(isTyped, () =>
      print.warning("No available skills"),
    );
    return;
  }

  const skillsList = getState()
    .content.skills.filter(
      (skill) => !skill.name.startsWith(contextFileSkillNamePrefix),
    )
    .map(
      (skill) => `- **${skill.name}**: ${skill.description}
  ${skill.dir}`,
    )
    .join("\n");

  const initialContentStr = `# Available skills:

${skillsList}`;

  await openWithPager({ contentType: "markdown", initialContentStr });
}

export async function pageAvailableContextFiles({
  isTyped = false,
}: SpacingOpts = {}) {
  if (getState().content.contextEntries.length === 0) {
    streamingSupportedWithSpacing(isTyped, () =>
      print.warning("No available context files"),
    );
    return;
  }

  const contextFiles = getState().content.contextEntries.map(
    (context) => `- ${context.filePath}`,
  );

  const contextSkillFiles = getState()
    .content.skills.filter((skill) =>
      skill.name.startsWith(contextFileSkillNamePrefix),
    )
    .map((skill) => `- ${join(skill.dir, "AGENTS.md")} (as a skill)`);

  const formatted = contextFiles.concat(contextSkillFiles).join("\n");

  const initialContentStr = `# Available context files:

${formatted}`;
  await openWithPager({ contentType: "markdown", initialContentStr });
}

export async function resumeWithNoArgs() {
  const sessionFiles = (await listSessionFiles()).filter(
    ({ absolutePath }) => getState().session.sessionFilePath !== absolutePath,
  );
  if (sessionFiles.length === 0) {
    errorWithSpacing(() => print.error("No sessions to resume"));
    return null;
  }

  const sortedSessionFiles = sessionFiles.toSorted(
    (a, b) => b.timestampMs - a.timestampMs,
  );
  const sessionFile = sortedSessionFiles[0];
  assertAtBuildtime(sessionFile !== undefined);

  const success = await resumeFromSessionFile(sessionFile.absolutePath);
  if (success) return "Continue";
  return null;
}

export async function resume(rawInput: string) {
  const parts = rawInput.split(/\s+/);

  if (parts.length !== 2) {
    print.error("Usage: /resume [session start date]");
    return null;
  }
  const sessionStartDate = parts[1];
  assertAtBuildtime(sessionStartDate !== undefined);

  if (Number.isNaN(Number(sessionStartDate))) {
    print.error("Usage: /resume [session start date]");
    return null;
  }

  const sessionFiles = await listSessionFiles();
  for (const { absolutePath, timestampMs } of sessionFiles) {
    if (timestampMs !== Number(sessionStartDate)) continue;
    const success = await resumeFromSessionFile(absolutePath);
    if (success) {
      return "Continue";
    }
    return null;
  }

  errorWithSpacing(() => {
    print.error(
      `No conversation found with session start date: ${sessionStartDate}`,
    );
  });
  return null;
}

export function printKeymaps() {
  successWithSpacing(() => {
    print.doing("Keymaps:");
    for (const [command, keymap] of Object.entries(getState().config.keymaps)) {
      print.plain(`- ${command}: ${JSON.stringify(keymap)}`);
    }
  });
}

function getAllPrettyConfig() {
  const globalConfigTitle = `Global config from path: ${getGlobalConfigPath()}`;
  const localConfigTitle = `Local config from path: ${getLocalConfigPath()}`;

  return `# ${globalConfigTitle}

${markdownFence("yaml", getState().content.globalConfigStr)}

# ${localConfigTitle}

${markdownFence("yaml", getState().content.localConfigStr)}

# Applied config

${markdownFence("json", stringify(getState().config))}`;
}

const reloadTempFilePrefixes = [
  "global",
  "local",
  "applied",
  "context",
  "skills",
  "commands",
] as const;

type ReloadTempFilePrefixes = (typeof reloadTempFilePrefixes)[number];
const getReloadTempFileDiffTitle = (): Record<
  ReloadTempFilePrefixes,
  string
> => ({
  global: `Global config from path: ${getGlobalConfigPath()}`,
  local: `Local config from path: ${getLocalConfigPath()}`,
  applied: "Applied config:",
  commands: "Custom slash commands:",
  context: "Agent context:",
  skills: "Agent skills:",
});

const getReloadTempFileStr = (): Record<ReloadTempFilePrefixes, string> => ({
  global: markdownFence("yaml", getState().content.globalConfigStr),
  local: markdownFence("yaml", getState().content.localConfigStr),
  applied: markdownFence("json", stringify(getState().config)),
  context: getState().content.contextStr,
  commands: getCustomSlashCommandsStr(),
  skills: getState().content.skillsStr,
});

function resetConfigMessages() {
  actions.resetConfigErrorMessages();
  actions.resetConfigWarningMessages();
  actions.setIncludeConfigInitMessage(false);
}

async function reload() {
  resetConfigMessages();

  const beforeFiles = await Promise.all(
    reloadTempFilePrefixes.map((prefix) =>
      getTempFileName({
        pathPrefix: `lasso-${prefix}-before`,
        initialContentStr: getReloadTempFileStr()[prefix],
      }),
    ),
  );

  await initStateRepeatable();

  const afterFiles = await Promise.all(
    reloadTempFilePrefixes.map((prefix) =>
      getTempFileName({
        pathPrefix: `lasso-${prefix}-after`,
        initialContentStr: getReloadTempFileStr()[prefix],
      }),
    ),
  );
  const diffResults = [];
  for (let i = 0; i < reloadTempFilePrefixes.length; i++) {
    const prefix = reloadTempFilePrefixes[i];
    assertAtBuildtime(prefix !== undefined);

    const beforeFile = beforeFiles[i];
    if (beforeFile === null || beforeFile === undefined) {
      print.error(
        `Failed to create a before temp file for the reload diff of ${prefix}`,
      );
      continue;
    }

    const afterFile = afterFiles[i];
    if (afterFile === null || afterFile === undefined) {
      await tryCatchAsync(fsDeps.unlink(beforeFile));
      print.warning(
        `Failed to create an after temp file for the reload diff of ${prefix}`,
      );
      continue;
    }

    const diffResult = await tryCatchAsync(
      execGitDiff({
        tempFileBeforePath: beforeFile,
        tempFileAfterPath: afterFile,
      }),
    );

    if (!diffResult.ok) {
      for (const path of beforeFiles
        .concat(afterFiles)
        .filter((p) => p !== null)) {
        await tryCatchAsync(fsDeps.unlink(path));
      }
      print.error(
        `An error occurred when getting the diff: ${getMessageFromError(diffResult.error)}`,
      );
      return;
    }

    if (diffResult.value.stdout.length > 0) {
      diffResults.push(
        `${getReloadTempFileDiffTitle()[prefix]}
${normalizeNewline(diffResult.value.stdout)}`,
      );
    }
  }
  for (const path of beforeFiles.concat(afterFiles).filter((p) => p !== null)) {
    await tryCatchAsync(fsDeps.unlink(path));
  }

  const diff = diffResults.join("\n");
  if (diff.length === 0) {
    print.info("No diff from reload");
  } else {
    await openWithPager({
      initialContentStr: diff,
      contentType: "diff",
    });
  }
  warnOnLargePromptOverhead();
}

const getDefaultConfig = (
  command: "initlocal" | "initglobal",
) => `# This config was auto-generated by the /${command} command
model: deepseek-v4-pro
baseURL: https://opencode.ai/zen/v1\n`;

export async function initLocalConfig() {
  const path = getLocalConfigPath();

  if (fsDeps.existsSync(path)) {
    print.warning(`The local config already exists at ${path}`);
    return;
  }

  const dir = dirname(path);
  if (!fsDeps.existsSync(dir)) {
    const mkdirResult = await tryCatchAsync(
      fsDeps.mkdir(dir, { recursive: true }),
    );
    if (!mkdirResult.ok) {
      print.error(`Failed to create the directory: ${dir}`);
      return;
    }
  }

  const writeResult = await tryCatchAsync(
    fsDeps.writeFile(path, getDefaultConfig("initlocal")),
  );
  if (!writeResult.ok) {
    print.error(`Failed to write the config to ${path}`);
    return;
  }
  print.info(`Created the local config at ${path}`);
}

export async function initGlobalConfig() {
  const path = getGlobalConfigPath();

  if (fsDeps.existsSync(path)) {
    print.warning(`The global config already exists at ${path}`);
    return;
  }

  const dir = dirname(path);
  if (!fsDeps.existsSync(dir)) {
    const mkdirResult = await tryCatchAsync(
      fsDeps.mkdir(dir, { recursive: true }),
    );
    if (!mkdirResult.ok) {
      print.error(`Failed to create the directory: ${dir}`);
      return;
    }
  }

  const writeResult = await tryCatchAsync(
    fsDeps.writeFile(path, getDefaultConfig("initglobal")),
  );
  if (!writeResult.ok) {
    print.error(`Failed to write the config to ${path}`);
    return;
  }
  print.info(`Created the global config at ${path}`);
}

export async function pageHistory({ isTyped = false }: SpacingOpts = {}) {
  const { transcript } = getState().conversation;

  if (transcript.length === 0) {
    streamingSupportedWithSpacing(isTyped, () =>
      print.warning("No chat history"),
    );
    return;
  }

  const formattedTranscript = transcript
    .map(
      ({ message, role, timestamp }) => `${getPrettyDate(timestamp)}  *${role}*
${normalizeNewline(message, { count: 0 })}`,
    )
    .toReversed()
    .join("\n\n---\n\n");

  const initialContentStr = `# [lasso] Chat history

${formattedTranscript}`;

  await openWithPager({
    initialContentStr,
    contentType: "markdown",
  });
}

export async function pageLastResponse({ isTyped = false }: SpacingOpts = {}) {
  const { messages } = getState().conversation;
  const lastMessage = messages.findLast(
    (message) => message.role === "assistant",
  );

  if (lastMessage == undefined) {
    streamingSupportedWithSpacing(isTyped, () =>
      print.warning("No llm messages"),
    );
    return;
  }

  const contentStr = getStrFromAssistantContent(
    lastMessage.content as AssistantContent,
  );
  if (contentStr.length === 0) {
    streamingSupportedWithSpacing(isTyped, () =>
      print.warning("No llm messages"),
    );
    return;
  }

  const formattedContentStr = await formatMarkdown(contentStr);

  const initialContentStr = `# [lasso] Last response

${formattedContentStr}`;

  await openWithPager({
    initialContentStr,
    contentType: "markdown",
  });
}

export async function pageLastMessage({ isTyped = false }: SpacingOpts = {}) {
  const { messages } = getState().conversation;
  const lastMessage = messages.findLast((message) => message.role === "user");

  if (lastMessage == undefined) {
    streamingSupportedWithSpacing(isTyped, () =>
      print.warning("No user messages"),
    );
    return;
  }

  const contentStr = lastMessage.content as string;
  assertAtBuildtime(typeof contentStr === "string");

  if (contentStr.length === 0) {
    streamingSupportedWithSpacing(isTyped, () =>
      print.warning("No user messages"),
    );
    return;
  }

  const initialContentStr = `# [lasso] Last message

${contentStr}`;

  await openWithPager({
    initialContentStr,
    contentType: "markdown",
  });
}

export async function pageSummaries({ isTyped = false }: SpacingOpts = {}) {
  if (getState().conversation.summaries.length === 0) {
    streamingSupportedWithSpacing(isTyped, () =>
      print.warning("No conversation summaries"),
    );
    return;
  }

  const summariesStr = getState()
    .conversation.summaries.map(
      (
        summary,
        idx,
      ) => `## Summary ${String(idx + 1)} (${summary.tokens.toLocaleString()} tokens, compacted at ${getPrettyDate(summary.compactedAt)})

${summary.compacted}`,
    )
    .toReversed()
    .join("\n\n---\n\n");

  const initialContentStr = `# [lasso] Conversation summaries

${summariesStr}`;

  await openWithPager({
    initialContentStr,
    contentType: "markdown",
  });
}

export async function pageLastDiff({ isTyped = false }: SpacingOpts = {}) {
  const { toolEditDiffs } = getState().conversation;

  if (toolEditDiffs.length === 0) {
    streamingSupportedWithSpacing(isTyped, () =>
      print.warning("No diffs from the last turn"),
    );
    return;
  }
  const initialContentStr = toolEditDiffs
    .map(
      ({ diffStdout, fileName }) => `${wrapInFence(fileName)}
${diffStdout}`,
    )
    .join("\n\n");

  await openWithPager({
    initialContentStr,
    contentType: "diff",
  });
}

export function clearRlLine(): readline.Interface | null {
  const rl = getState().terminal.rl;
  assertAtBuildtime(rl !== null);
  rl.write(null, { ctrl: true, name: "e" });
  rl.write(null, { ctrl: true, name: "u" });
  return rl;
}

export async function pageTools() {
  function formatTool(
    [name, tool]: [name: string, tool: Tool],
    context: { type: "harness" } | { type: "mcp"; name: string },
  ) {
    const description =
      typeof tool.description === "string"
        ? tool.description
        : "[no description available]";

    const prefix = context.type === "harness" ? "lasso" : `${context.name} mcp`;

    return `- **[${prefix}] ${name}**: ${description}`;
  }

  const formattedHarnessTools = Object.entries(harnessTools).map((entry) =>
    formatTool(entry, { type: "harness" }),
  );

  const clientToolSets = await Promise.all(
    Object.entries(getState().mcp.clients).map(
      async ([clientName, mcpClient]) => ({
        clientName,
        mcpToolSet: await mcpClient.tools(),
      }),
    ),
  );

  const formattedMCPTools = clientToolSets.flatMap(
    ({ clientName, mcpToolSet }) =>
      Object.entries(mcpToolSet).map((toolEntry) =>
        formatTool(toolEntry, { type: "mcp", name: clientName }),
      ),
  );

  const initialContentStr = `# Available tools:

${formattedHarnessTools.concat(formattedMCPTools).join("\n")}`;

  await openWithPager({
    initialContentStr,
    contentType: "markdown",
  });
}

export function warnOnMissingTranscribeConfig() {
  const rl = getState().terminal.rl;
  assertAtBuildtime(rl !== null);

  const transcriptionApiKey = processDeps.env.get(
    "LASSO_TRANSCRIPTION_API_KEY",
  );
  const { transcriptionModel, transcriptionSdkProvider } = getState().config;

  const warningMessages: string[] = [];

  if (transcriptionApiKey === undefined) {
    warningMessages.push(
      "Set the `LASSO_TRANSCRIPTION_API_KEY` environment variable, e.g. `export LASSO_TRANSCRIPTION_API_KEY=...`",
    );
  }

  if (transcriptionSdkProvider === undefined) {
    warningMessages.push(
      "Set `transcriptionSdkProvider` in your config file (`openai` or `google`)",
    );
  }

  if (transcriptionModel === undefined) {
    warningMessages.push("Set `transcriptionModel` in your config file");
  }

  if (warningMessages.length > 0) {
    const formattedMessages = warningMessages
      .map((message) => `- ${message}`)
      .join("\n");

    const warning = `Warning! You're missing required configuration options for /record.
${formattedMessages}`;

    print.warning(warning, { whileMuted: true });
    return true;
  }
  return false;
}

export async function recordAndTranscribeInput({
  isTyped = false,
}: SpacingOpts = {}) {
  const rl = getState().terminal.rl;
  assertAtBuildtime(rl !== null);

  const missingConfig = warnOnMissingTranscribeConfig();
  if (missingConfig) return null;

  const abortController = new AbortController();
  actions.setRecordProcessAbortController(abortController);

  const tempFile = await getTempFileName({ extension: "wav" });

  if (tempFile === null) {
    print.error("Error creating a time file to write the recording to", {
      whileMuted: !isTyped,
    });
    actions.setRecordProcessAbortController(null);
    return null;
  }

  async function cleanup() {
    assertAtBuildtime(tempFile !== null);
    await tryCatchAsync(fsDeps.unlink(tempFile));
  }

  const { stop, recordingFinished } = recordInput(tempFile);
  const recordingPromise = tryCatchAsync(recordingFinished);

  const query = `${wrapInColor("⏺", "red")} Press enter to stop recording `;
  let questionPromise: Promise<string>;

  if (isTyped) {
    questionPromise = rl.question(query, { signal: abortController.signal });
  } else {
    print.plain(query.concat("\n"), {
      appendNewline: false,
      whileMuted: true,
    });
    // rl.question writes its prompt through mutedStdout which drops output
    // during the recording, so the banner is printed directly instead
    questionPromise = rl.question("", { signal: abortController.signal });
  }
  const finishRecordingResult = await tryCatchAsync(questionPromise);

  stop();
  await recordingPromise;
  actions.setRecordProcessAbortController(null);

  if (!finishRecordingResult.ok) {
    if (isAbortError(finishRecordingResult.error)) {
      print.warning("Cancelled");
      await cleanup();
      return null;
    }

    print.error(
      `Error while prompting the user to stop recording: ${getMessageFromError(finishRecordingResult.error)}`,
      { whileMuted: !isTyped },
    );
    await cleanup();
    return null;
  }

  const readResult = await tryCatchAsync(fsDeps.readFile(tempFile));
  await cleanup();
  if (!readResult.ok) {
    print.error(
      `Error while reading the temp file that was recorded to: ${getMessageFromError(readResult.error)}`,
      { whileMuted: !isTyped },
    );
    return null;
  }

  const transcriptionAbortController = new AbortController();
  actions.setTranscriptionAbortController(transcriptionAbortController);
  const transcribeResult = await tryCatchAsync(
    transcribeInput(readResult.value),
  );
  actions.setTranscriptionAbortController(null);

  if (!transcribeResult.ok) {
    if (isAbortError(transcribeResult.error)) {
      await cleanup();
      return null;
    }

    print.error(
      `Error while transcribing: ${getMessageFromError(transcribeResult.error)}`,
      { whileMuted: !isTyped },
    );
    return null;
  }

  print.doing("Transcribed: ", { appendNewline: false, whileMuted: true });
  print.plain(transcribeResult.value, { whileMuted: true });
  return transcribeResult.value;
}

export function recordInput(tempFile: string) {
  const abortController = getState().abortControllers.recordProcess;
  assertAtBuildtime(abortController !== null);

  const outputChunks: Buffer[] = [];

  const recordingProcess = childProcessDeps.spawn(
    "sox",
    [
      "-d", // use the default audio input device as the input
      "-t",
      "wav", // output file type: raw audio with no header, just samples
      "-r",
      "16000", // output sample rate: 16000 samples per second
      "-c",
      "1", // output channels: mono
      "-b",
      "16", // output bit depth: 16 bits per sample
      tempFile,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  recordingProcess.stdout.on("data", (chunk: Buffer) =>
    outputChunks.push(chunk),
  );

  const recordingReady = new Promise<void>((resolve) => {
    recordingProcess.stderr.once("data", () => resolve());
  });

  const errorChunks: Buffer[] = [];

  recordingProcess.stderr.on("data", (chunk: Buffer) =>
    errorChunks.push(chunk),
  );

  abortController.signal.addEventListener("abort", () => {
    recordingProcess.kill("SIGINT");
  });

  const recordingFinished = once(recordingProcess, "close");

  return {
    stop: () => recordingProcess.kill("SIGINT"),
    recordingFinished,
    recordingReady,
    getErrorOutput: () => Buffer.concat(errorChunks).toString("utf8"),
  };
}

export async function transcribeInput(buffer: Buffer): Promise<string> {
  const transcriptionAbortController =
    getState().abortControllers.transcription;
  assertAtBuildtime(transcriptionAbortController !== null);

  const { transcriptionModel } = getState().config;
  assertAtBuildtime(transcriptionModel !== undefined);

  const { text } = await aiDeps.transcribe({
    model: getTranscriptionProvider().transcription(transcriptionModel),
    audio: buffer,
    abortSignal: transcriptionAbortController.signal,
  });

  return text;
}
