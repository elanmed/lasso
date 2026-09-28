import readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import { dirname, join } from "node:path";
import childProcess from "node:child_process";
import os from "node:os";
import type { AssistantContent } from "ai";
import { assertAtBuildtime } from "./assert.ts";
import {
  isAbortError,
  isReadlineClosedError,
  tryCatch,
  tryCatchAsync,
  getMessageFromError,
  normalizeNewline,
  getTempFileName,
  execPromise,
  isExisty,
  listSessionFiles,
  stringify,
  getStrFromAssistantContent,
  markdownFence,
} from "./utils.ts";
import { truncate } from "./text.ts";
import {
  print,
  printNewline,
  printSessionStartDate,
  withSpacing,
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
import { fsDeps, processDeps } from "./deps.ts";
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

// https://stackoverflow.com/a/33500118
const mutedStdout = new Writable({
  write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    if (getState().app.loadingStateTimeout === null) {
      stdout.write(chunk);
    }
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

export function initReadline() {
  const rl = readline.createInterface({
    input: stdin,
    output: mutedStdout,
    terminal: true,
  });
  actions.setRl(rl);

  if (stdin.isTTY) {
    stdin.setRawMode(true);
  }

  if (stdout.isTTY) {
    stdout.on("resize", () => {
      mutedStdout.emit("resize");
    });
  }

  process.on("exit", () => {
    if (stdin.isTTY) {
      stdin.setRawMode(false);
    }
  });

  emitKeypressEvents(stdin, rl);
  return rl;
}

async function getEditorInitialContent(opts: {
  includeClipboardSuffix: boolean;
}) {
  const rl = getState().app.rl;
  assertAtBuildtime(rl !== null);

  const prefilledEditorContent = (() => {
    const editorInputValue = getState().app.editorInputValue;
    if (editorInputValue !== null) return normalizeNewline(editorInputValue);
    return "";
  })();

  const readlineContent = (() => {
    if (rl.line.length > 0) return rl.line;
    return "";
  })();

  let clipboardContent = "";
  if (opts.includeClipboardSuffix) {
    const defaultPasteCmd = (() => {
      if (os.platform() === "darwin") return "pbpaste";
      if (os.platform() === "linux") return "xclip -selection clipboard -o";
      return "";
    })();

    const pasteCmd =
      processDeps.env.get("LASSO_CLIPBOARD_PASTE") ?? defaultPasteCmd;

    const pasteResult = await tryCatchAsync(execPromise(pasteCmd));
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

export function initKeypress() {
  const rl = getState().app.rl;
  assertAtBuildtime(rl !== null);

  function typeCommand(command: string) {
    // TODO: clear first
    assertAtBuildtime(rl !== null);
    const output = `/${command}\n`;
    rl.write(output);
    actions.appendStdoutTail(output);
  }

  // Reprints the readline prompt line and any half-typed input after pager
  // commands so the pending question and its input stay visible and editable
  function redrawPendingQuestion() {
    if (getState().abortControllers.question === null) return;
    assertAtBuildtime(rl !== null);
    rl.prompt(true);
    actions.appendStdoutTail(getState().config.promptPrefix);
  }

  stdin.on("keypress", (_char, key: Key) => {
    void (async () => {
      const keymaps = getState().config.keymaps;

      for (const command of builtinSlashCommands) {
        const keymap = keymaps[command];
        if (keymap === undefined) continue;
        if (!isSameKey(key, keymap)) continue;

        switch (command) {
          case "edit": {
            const editorContent = await spawnAndReadEditorContent();
            if (editorContent === null) {
              redrawPendingQuestion();
            } else {
              abortRlQuestionForEditorIfActive(editorContent);
            }

            return;
          }
          case "editpage": {
            pageEditStr();
            redrawPendingQuestion();
            return;
          }
          case "paste": {
            const editorContent = await spawnAndReadEditorContent({
              includeClipboardSuffix: true,
            });
            if (editorContent === null) {
              redrawPendingQuestion();
            } else {
              abortRlQuestionForEditorIfActive(editorContent);
            }
            return;
          }
          case "history": {
            pageHistory();
            redrawPendingQuestion();
            return;
          }
          case "config": {
            const initialContentStr = getAllPrettyConfig();

            openWithPager({
              initialContentStr,
              contentType: "markdown",
            });
            redrawPendingQuestion();

            return;
          }
          case "contextpage": {
            pageContextStr();
            redrawPendingQuestion();
            return;
          }
          case "commandspage": {
            pageCustomSlashCommandsStr();
            redrawPendingQuestion();
            return;
          }
          case "lastresponse": {
            await pageLastResponse();
            redrawPendingQuestion();
            return;
          }
          case "lastmessage": {
            pageLastMessage();
            redrawPendingQuestion();
            return;
          }
          case "lastdiff": {
            pageLastDiff();
            redrawPendingQuestion();
            return;
          }
          case "messages": {
            pageMessages();
            redrawPendingQuestion();
            return;
          }
          case "summaries": {
            pageSummaries();
            redrawPendingQuestion();
            return;
          }
          case "reload": {
            await reload();
            redrawPendingQuestion();
            return;
          }
          case "commands": {
            pageCommands();
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

      for (const slashCommand of getState().app.slashCommands) {
        const keymap = keymaps[slashCommand.name];
        if (keymap === undefined) continue;
        if (!isSameKey(key, keymap)) continue;

        if (getState().abortControllers.question !== null) {
          typeCommand(slashCommand.name);
        }
        return;
      }

      if (getState().app.loadingStateTimeout !== null) {
        rl.write(null, { ctrl: true, name: "u" });
      }
    })();
  });
}

export function initSigInt() {
  const rl = getState().app.rl;
  assertAtBuildtime(rl !== null);
  rl.on("SIGINT", () => {
    const apiStream = getState().abortControllers.apiStream;
    const interruptWithEditorContent =
      getState().abortControllers.interruptWithEditorContent;
    const question = getState().abortControllers.question;
    const controllers = [apiStream, interruptWithEditorContent, question];
    assertAtBuildtime(controllers.filter((c) => c !== null).length <= 1);

    if (apiStream !== null) {
      apiStream.abort();
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

export function parseInputFromEditor() {
  const editorInputValue = getState().app.editorInputValue;
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

  syncSessionFile({
    transcript: getAppendedTranscript({
      message: firstMessage,
      role: "user",
      timestamp: Date.now(),
    }),
  });
  return firstMessage;
}

export async function resolveUserInput({
  isFirstInput,
}: {
  isFirstInput: boolean;
}) {
  const rl = getState().app.rl;
  assertAtBuildtime(rl !== null);

  if (getState().app.editorInputValue !== null) {
    const editorInput = parseInputFromEditor();
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
  const inputResult = await tryCatchAsync(
    rl.question(getState().config.promptPrefix, {
      signal: abortController.signal,
    }),
  );
  actions.setQuestionAbortController(null);

  if (!inputResult.ok) {
    if (isReadlineClosedError(inputResult.error)) {
      await exitSession();
    }

    if (!isAbortError(inputResult.error)) {
      print.error(getMessageFromError(inputResult.error));
      return null;
    }

    const abortedByEditor = getState().app.editorInputValue !== null;
    if (abortedByEditor) {
      const editorInput = parseInputFromEditor();
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
  syncSessionFile({
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
    const customSlashCommands = getState().app.slashCommands.map((c) => c.name);
    return [...builtinSlashCommands, ...customSlashCommands].includes(command);
  }

  return true;
}

async function exitSession() {
  const rl = getState().app.rl;
  assertAtBuildtime(rl !== null);
  rl.close();
  printSessionStartDate();
  await getState().mcp.close();
  process.exit(0);
}

async function resolveExitConfirmation() {
  const rl = getState().app.rl;
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
      await exitSession();
    }

    print.error(getMessageFromError(exitResult.error));
    return;
  }

  if (/^y(es)?$/i.exec(exitResult.value) !== null) {
    actions.appendStdoutTail(
      `${getState().config.promptPrefix}${exitResult.value}\n`,
    );

    await exitSession();
  }

  return;
}

export async function resolveInterruptWithEditor() {
  const rl = getState().app.rl;
  assertAtBuildtime(rl !== null);

  actions.setInterruptWithEditorAbortController(new AbortController());
  const abortController =
    getState().abortControllers.interruptWithEditorContent;
  assertAtBuildtime(abortController !== null);
  print.warning(
    `You have queued messages! Edit them with ${JSON.stringify(getState().config.keymaps.edit)} or press enter to continue`,
  );
  const continueResult = await tryCatchAsync(
    rl.question("Ready? ", {
      signal: abortController.signal,
    }),
  );
  actions.setInterruptWithEditorAbortController(null);

  if (continueResult.ok) return;
  if (isAbortError(continueResult.error)) return;

  print.error(getMessageFromError(continueResult.error));
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
      const content = await spawnAndReadEditorContent();
      if (content !== null) {
        syncSessionFile({
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
      pageEditStr({ isTyped: true });
      return { handled: true, inputFromCommand: null };
    }
    case "paste": {
      const content = await spawnAndReadEditorContent({
        includeClipboardSuffix: true,
      });
      if (content !== null)
        syncSessionFile({
          transcript: getAppendedTranscript({
            message: content,
            role: "user",
            timestamp: Date.now(),
          }),
        });
      return { handled: true, inputFromCommand: content };
    }
    case "clear": {
      clearCommand();
      return { handled: true, inputFromCommand: null };
    }
    case "history": {
      pageHistory({ isTyped: true });
      return { handled: true, inputFromCommand: null };
    }
    case "model": {
      getModel();
      return { handled: true, inputFromCommand: null };
    }
    case "skills": {
      printSkills();
      return { handled: true, inputFromCommand: null };
    }
    case "context": {
      printAvailableContextFiles();
      return { handled: true, inputFromCommand: null };
    }
    case "contextpage": {
      pageContextStr({ isTyped: true });
      return { handled: true, inputFromCommand: null };
    }
    case "commands": {
      pageCommands();
      return { handled: true, inputFromCommand: null };
    }
    case "commandspage": {
      pageCustomSlashCommandsStr({ isTyped: true });

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

      openWithPager({
        initialContentStr,
        contentType: "markdown",
      });

      return { handled: true, inputFromCommand: null };
    }
    case "resume": {
      const inputFromCommand = resumeWithNoArgs();
      if (inputFromCommand !== null) {
        syncSessionFile({
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
      initLocalConfig();
      return { handled: true, inputFromCommand: null };
    }
    case "initglobal": {
      initGlobalConfig();
      return { handled: true, inputFromCommand: null };
    }
    case "lastresponse": {
      await pageLastResponse({ isTyped: true });
      return { handled: true, inputFromCommand: null };
    }
    case "lastmessage": {
      pageLastMessage({ isTyped: true });
      return { handled: true, inputFromCommand: null };
    }
    case "lastdiff": {
      pageLastDiff({ isTyped: true });
      return { handled: true, inputFromCommand: null };
    }
    case "messages": {
      pageMessages();
      return { handled: true, inputFromCommand: null };
    }
    case "summaries": {
      pageSummaries({ isTyped: true });
      return { handled: true, inputFromCommand: null };
    }
    default: {
      command satisfies never;
      return { handled: false, inputFromCommand: null };
    }
  }
}

function resolveParameterizedBuiltinSlashCommand(
  commandWithArgs: string,
): SlashCommandOutcome {
  const parts = commandWithArgs.split(/\s+/);
  const command = parts[0] as ParameterizedBuiltinSlashCommand | undefined;
  if (command === undefined) return { handled: false, inputFromCommand: null };

  switch (command) {
    case "model": {
      setModelCommand(commandWithArgs);
      return { handled: true, inputFromCommand: null };
    }
    case "resume": {
      const inputFromCommand = resume(commandWithArgs);
      if (inputFromCommand !== null) {
        syncSessionFile({
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

  const slashCommands = getState().app.slashCommands;
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
    resolveParameterizedBuiltinSlashCommand(commandWithoutSlash);
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

export function clearCommand() {
  print.infoSubtle(`Context cleared (${getPrettyTokenUsage()})`);
  syncSessionFile({
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
    getState().app.modelUsageForSession[model] ?? [],
  );
  const tokenUsageForLimitWindow = sumUsageTokens(
    getState().app.modelUsageForLimitWindow[model] ?? [],
  );
  const { usageLimit } = getState().config;

  const usedInSession = (() => {
    const tokensInSession = `${(tokenUsageForSession.inputTokens + tokenUsageForSession.outputTokens).toLocaleString()} tokens`;
    if (pricing === undefined) {
      return tokensInSession;
    }
    const dollarsInSession = `$${String(getUsageMoneyForModel(tokenUsageForSession, model))}`;
    return `${tokensInSession}, ${dollarsInSession}`;
  })();

  withSpacing(() => {
    print.doing("Usage:");
    print.plain(`- Session: ${usedInSession}`);

    if (!isUsageLimitDisabled()) {
      assertAtBuildtime(usageLimit !== undefined);
      const costForLimitWindow = getUsageMoneyForModel(
        tokenUsageForLimitWindow,
        model,
      );

      print.plain(
        `- ${usageLimit.duration} window: ${getPrettyMoney(costForLimitWindow)} of ${String(usageLimit.dollarAmount)} limit`,
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

  const contextWindowUsage = (() => {
    const prettyContextWindowUsageRaw = getPrettyContextWindowUsage();
    if (prettyContextWindowUsageRaw !== null) {
      return ` (${prettyContextWindowUsageRaw})`;
    }
    return "";
  })();

  withSpacing(() => {
    print.doing(`Token count: ${total.toLocaleString()}${contextWindowUsage}`);
    print.plain(getPrettyTokensByArea());
    printNewline();
  });
}

export async function spawnAndReadEditorContent(opts?: {
  includeClipboardSuffix?: boolean;
}) {
  const includeClipboardSuffix = opts?.includeClipboardSuffix ?? false;

  const initialContent = await getEditorInitialContent({
    includeClipboardSuffix,
  });

  const tempFile = getTempFileName();
  if (tempFile === null) {
    print.error("Failed to create a temp file");
    return null;
  }

  const editCommand = (() => {
    const lassoEditEnvValue = processDeps.env.get("LASSO_EDIT");
    if (isExisty(lassoEditEnvValue)) {
      return lassoEditEnvValue.replace("__FILE__", tempFile);
    }

    const editorEnvValue = processDeps.env.get("EDITOR");
    if (isExisty(editorEnvValue)) {
      return editorEnvValue.includes("__FILE__")
        ? editorEnvValue.replace("__FILE__", tempFile)
        : `${editorEnvValue} ${tempFile}`;
    }

    return `vi ${tempFile}`;
  })();

  const writeResult = tryCatch(() =>
    fsDeps.writeFileSync(tempFile, initialContent),
  );
  if (!writeResult.ok) {
    print.error("Failed to write to temp file");
    return null;
  }

  const statBefore = tryCatch(() => fsDeps.statSync(tempFile));

  childProcess.spawnSync(editCommand, {
    shell: true,
    stdio: "inherit",
  });

  const statAfter = tryCatch(() => fsDeps.statSync(tempFile));

  const readResult = tryCatch(() => fsDeps.readFileSync(tempFile).toString());
  if (!readResult.ok) {
    print.error("Failed to read from temp file");
    tryCatch(() => fsDeps.unlinkSync(tempFile));
    return null;
  }
  tryCatch(() => fsDeps.unlinkSync(tempFile));

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

export function pageContextStr({ isTyped = false }: SpacingOpts = {}) {
  if (getState().app.contextEntries.length === 0) {
    withSpacingIf(
      getState().abortControllers.apiStream === null && isTyped,
      () => print.doing("No available context files"),
    );
    return;
  }

  const initialContentStr = getState().app.contextStr;

  openWithPager({
    initialContentStr,
    contentType: "markdown",
  });
}

export interface SpacingOpts {
  isTyped?: boolean;
}

function withSpacingIf(shouldSpace: boolean, cb: () => void) {
  if (shouldSpace) {
    printNewline();
    cb();
    printNewline();
  } else {
    cb();
  }
}

export function pageEditStr({ isTyped = false }: SpacingOpts = {}) {
  const { editorInputValue } = getState().app;
  if (editorInputValue === null) {
    withSpacingIf(
      getState().abortControllers.apiStream === null && isTyped,
      () => print.doing("Editor is empty"),
    );
    return;
  }

  const initialContentStr = `# [lasso] Editor content

${editorInputValue}`;

  openWithPager({
    initialContentStr,
    contentType: "markdown",
  });
}

export function pageCommands() {
  const initialContentStr = `# Available commands:

${getAvailableCommandsStr()}`;

  openWithPager({
    initialContentStr,
    contentType: "markdown",
  });
}

export function pageCustomSlashCommandsStr({
  isTyped = false,
}: SpacingOpts = {}) {
  if (getState().app.slashCommands.length === 0) {
    withSpacingIf(
      getState().abortControllers.apiStream === null && isTyped,
      () => print.doing("No available custom slash commands"),
    );
    return;
  }

  const initialContentStr = getCustomSlashCommandsStr();

  openWithPager({
    initialContentStr,
    contentType: "markdown",
  });
}

export function printSkills() {
  if (getState().app.skills.length === 0) {
    withSpacing(() => print.doing("No available skills"));
    return;
  }

  const skillsList = getState()
    .app.skills.filter(
      (skill) => !skill.name.startsWith(contextFileSkillNamePrefix),
    )
    .map(
      (skill) => `- ${skill.name}: ${skill.description}
  ${skill.dir}`,
    )
    .join("\n");

  withSpacing(() => {
    print.doing("Available skills:");
    print.plain(skillsList);
  });
}

export function printAvailableContextFiles() {
  if (getState().app.contextEntries.length === 0) {
    withSpacing(() => print.doing("No available context files"));
    return;
  }

  const contextFiles = getState().app.contextEntries.map(
    (context) => `- ${context.filePath}`,
  );

  const contextSkillFiles = getState()
    .app.skills.filter((skill) =>
      skill.name.startsWith(contextFileSkillNamePrefix),
    )
    .map((skill) => `- ${join(skill.dir, "AGENTS.md")} (as a skill)`);

  const formatted = contextFiles.concat(contextSkillFiles).join("\n");

  withSpacing(() => {
    print.doing("Available context files:");
    print.plain(formatted);
  });
}

export function resumeWithNoArgs() {
  const sessionFiles = listSessionFiles().filter(
    ({ absolutePath }) => getState().app.sessionFilePath !== absolutePath,
  );
  if (sessionFiles.length === 0) {
    withSpacing(() => print.error("No sessions to resume"));
    return null;
  }

  const sortedSessionFiles = sessionFiles.toSorted(
    (a, b) => b.timestampMs - a.timestampMs,
  );
  const sessionFile = sortedSessionFiles[0];
  assertAtBuildtime(sessionFile !== undefined);

  const success = resumeFromSessionFile(sessionFile.absolutePath);
  if (success) return "Continue";
  return null;
}

export function resume(rawInput: string) {
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

  const sessionFiles = listSessionFiles();
  for (const { absolutePath, timestampMs } of sessionFiles) {
    if (timestampMs !== Number(sessionStartDate)) continue;
    const success = resumeFromSessionFile(absolutePath);
    if (success) {
      return "Continue";
    }
    return null;
  }

  withSpacing(() => {
    print.error(
      `No conversation found with session start date: ${sessionStartDate}`,
    );
  });
  return null;
}

export function printKeymaps() {
  withSpacing(() => {
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

${markdownFence("yaml", getState().app.globalConfigStr)}

# ${localConfigTitle}

${markdownFence("yaml", getState().app.localConfigStr)}

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
  global: markdownFence("yaml", getState().app.globalConfigStr),
  local: markdownFence("yaml", getState().app.localConfigStr),
  applied: markdownFence("json", stringify(getState().config)),
  context: getState().app.contextStr,
  commands: getCustomSlashCommandsStr(),
  skills: getState().app.skillsStr,
});

async function reload() {
  const beforeFiles = reloadTempFilePrefixes.map((prefix) =>
    getTempFileName({
      pathPrefix: `lasso-${prefix}-before`,
      initialContentStr: getReloadTempFileStr()[prefix],
    }),
  );

  await initStateRepeatable();

  const afterFiles = reloadTempFilePrefixes.map((prefix) =>
    getTempFileName({
      pathPrefix: `lasso-${prefix}-after`,
      initialContentStr: getReloadTempFileStr()[prefix],
    }),
  );
  const diffResults = [];
  for (let i = 0; i < reloadTempFilePrefixes.length; i++) {
    const beforeFile = beforeFiles[i];
    if (beforeFile === null || beforeFile === undefined) continue;

    const afterFile = afterFiles[i];
    if (afterFile === null || afterFile === undefined) {
      tryCatch(() => fsDeps.unlinkSync(beforeFile));
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
        tryCatch(() => fsDeps.unlinkSync(path));
      }
      print.error(
        `An error occurred when getting the diff: ${getMessageFromError(diffResult.error)}`,
      );
      return;
    }

    if (diffResult.value.stdout.length > 0) {
      const prefix = reloadTempFilePrefixes[i];
      assertAtBuildtime(prefix !== undefined);
      diffResults.push(
        `${getReloadTempFileDiffTitle()[prefix]}
${normalizeNewline(diffResult.value.stdout)}`,
      );
    }
  }
  for (const path of beforeFiles.concat(afterFiles).filter((p) => p !== null)) {
    tryCatch(() => fsDeps.unlinkSync(path));
  }

  const diff = diffResults.join("\n");
  if (diff.length === 0) {
    print.info("No diff from reload");
  } else {
    openWithPager({
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

export function initLocalConfig() {
  const path = getLocalConfigPath();

  if (fsDeps.existsSync(path)) {
    print.warning(`The local config already exists at ${path}`);
    return;
  }

  const dir = dirname(path);
  if (!fsDeps.existsSync(dir)) {
    const mkdirResult = tryCatch(() =>
      fsDeps.mkdirSync(dir, { recursive: true }),
    );
    if (!mkdirResult.ok) {
      print.error(`Failed to create the directory: ${dir}`);
      return;
    }
  }

  const writeResult = tryCatch(() =>
    fsDeps.writeFileSync(path, getDefaultConfig("initlocal")),
  );
  if (!writeResult.ok) {
    print.error(`Failed to write the config to ${path}`);
    return;
  }
  print.info(`Created the local config at ${path}`);
}

export function initGlobalConfig() {
  const path = getGlobalConfigPath();

  if (fsDeps.existsSync(path)) {
    print.warning(`The global config already exists at ${path}`);
    return;
  }

  const dir = dirname(path);
  if (!fsDeps.existsSync(dir)) {
    const mkdirResult = tryCatch(() =>
      fsDeps.mkdirSync(dir, { recursive: true }),
    );
    if (!mkdirResult.ok) {
      print.error(`Failed to create the directory: ${dir}`);
      return;
    }
  }

  const writeResult = tryCatch(() =>
    fsDeps.writeFileSync(path, getDefaultConfig("initglobal")),
  );
  if (!writeResult.ok) {
    print.error(`Failed to write the config to ${path}`);
    return;
  }
  print.info(`Created the global config at ${path}`);
}

export function pageHistory({ isTyped = false }: SpacingOpts = {}) {
  const { transcript } = getState().app;

  if (transcript.length === 0) {
    withSpacingIf(
      getState().abortControllers.apiStream === null && isTyped,
      () => print.doing("No chat history"),
    );
    return;
  }

  const formattedTranscript = transcript
    .map(
      ({ message, role, timestamp }) => `${new Date(timestamp).toLocaleString(
        "en-US",
        {
          dateStyle: "medium",
          timeStyle: "medium",
        },
      )}  *${role}*
${normalizeNewline(message, { count: 0 })}`,
    )
    .join("\n\n---\n\n");

  const initialContentStr = `# [lasso] Chat history

${formattedTranscript}`;

  openWithPager({
    initialContentStr,
    contentType: "markdown",
  });
}

export async function pageLastResponse({ isTyped = false }: SpacingOpts = {}) {
  const { messages } = getState().app.conversation;
  const lastMessage = messages.findLast(
    (message) => message.role === "assistant",
  );

  if (lastMessage == undefined) {
    withSpacingIf(
      getState().abortControllers.apiStream === null && isTyped,
      () => print.doing("No llm messages"),
    );
    return;
  }

  const contentStr = getStrFromAssistantContent(
    lastMessage.content as AssistantContent,
  );
  if (contentStr.length === 0) {
    withSpacingIf(
      getState().abortControllers.apiStream === null && isTyped,
      () => print.doing("No llm messages"),
    );
    return;
  }

  const formattedContentStr = await formatMarkdown(contentStr);

  const initialContentStr = `# [lasso] Last response

${formattedContentStr}`;

  openWithPager({
    initialContentStr,
    contentType: "markdown",
  });
}

export function pageLastMessage({ isTyped = false }: SpacingOpts = {}) {
  const { messages } = getState().app.conversation;
  const lastMessage = messages.findLast((message) => message.role === "user");

  if (lastMessage == undefined) {
    withSpacingIf(
      getState().abortControllers.apiStream === null && isTyped,
      () => print.doing("No user messages"),
    );
    return;
  }

  const contentStr = lastMessage.content as string;
  assertAtBuildtime(typeof contentStr === "string");

  if (contentStr.length === 0) {
    withSpacingIf(
      getState().abortControllers.apiStream === null && isTyped,
      () => print.doing("No user messages"),
    );
    return;
  }

  const initialContentStr = `# [lasso] Last message

${contentStr}`;

  openWithPager({
    initialContentStr,
    contentType: "markdown",
  });
}

export function pageMessages() {
  const initialContentStr = `# [lasso] Messages

${stringify(getState().app.conversation.messages.toReversed())}`;

  openWithPager({
    initialContentStr,
    contentType: "markdown",
  });
}

export function pageSummaries({ isTyped = false }: SpacingOpts = {}) {
  if (getState().app.conversation.summaries.length === 0) {
    withSpacingIf(
      getState().abortControllers.apiStream === null && isTyped,
      () => print.doing("No conversation summaries"),
    );
    return;
  }

  const summariesStr = getState()
    .app.conversation.summaries.map(
      (
        summary,
        idx,
      ) => `## Summary ${String(idx + 1)} (${summary.tokens.toLocaleString()} tokens, compacted at ${String(summary.compactedAt)})

${summary.compacted}`,
    )
    .toReversed()
    .join("\n\n---\n\n");

  const initialContentStr = `# [lasso] Conversation summaries

${summariesStr}`;

  openWithPager({
    initialContentStr,
    contentType: "markdown",
  });
}

export function pageLastDiff({ isTyped = false }: SpacingOpts = {}) {
  const { toolEditDiffs } = getState().app;

  if (toolEditDiffs.length === 0) {
    withSpacingIf(
      getState().abortControllers.apiStream === null && isTyped,
      () => print.doing("No diffs from the last turn"),
    );
    return;
  }
  const initialContentStr = toolEditDiffs
    .map(
      ({ diffStdout, fileName }) => `${wrapInFence(fileName)}
${diffStdout}`,
    )
    .join("\n\n");

  openWithPager({
    initialContentStr,
    contentType: "diff",
  });
}

export function clearRlLine(): readline.Interface | null {
  const rl = getState().app.rl;
  assertAtBuildtime(rl !== null);
  rl.write(null, { ctrl: true, name: "e" });
  rl.write(null, { ctrl: true, name: "u" });
  return rl;
}
