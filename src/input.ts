import readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import { dirname, join } from "node:path";
import childProcess from "node:child_process";
import os from "node:os";
import { assertAtBuildtime } from "./assert.ts";
import {
  isAbortError,
  tryCatch,
  tryCatchAsync,
  getMessageFromError,
  normalizeLine,
  getTempFileName,
  execPromise,
  isExisty,
  listChatHistoryFiles,
  stringify,
  getStrFromAssistantContent,
} from "./utils.ts";
import { truncate } from "./text.ts";
import { print, printNewline, printSessionStartDate } from "./print.ts";
import { fencePrint, wrapInFence } from "./fence.ts";
import { getPrettyTokenUsage, getPrettyUsage } from "./usage-format.ts";
import { getApproxPromptTokens, warnOnLargePromptOverhead } from "./usage.ts";
import { actions, getState } from "./state.ts";
import { initStateRepeatable } from "./config.ts";
import { isSameKey, type Key } from "./config-types.ts";
import { prependToChatHistory } from "./log.ts";
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
    if (editorInputValue !== null) {
      return `${normalizeLine(editorInputValue)}\n`;
    }

    return "";
  })();

  const readlineContent = (() => {
    if (rl.line.length > 0) {
      return rl.line;
    }

    return "";
  })();

  let clipboardContent = "";
  if (opts.includeClipboardSuffix) {
    const defaultPasteCmd = (() => {
      if (os.platform() === "darwin") {
        return "pbpaste";
      }

      if (os.platform() === "linux") {
        return "xclip -selection clipboard -o";
      }

      return "";
    })();

    const pasteCmd =
      processDeps.env.get("LASSO_CLIPBOARD_PASTE") ?? defaultPasteCmd;

    const pasteResult = await tryCatchAsync(execPromise(pasteCmd));
    if (pasteResult.ok) {
      clipboardContent = normalizeLine(pasteResult.value.stdout);
    }
  }

  return `${prefilledEditorContent}${readlineContent}${clipboardContent}`;
}

function abortRlQuestionForEditor(editorContent: string) {
  actions.setEditorInputValue(editorContent);
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
              abortRlQuestionForEditor(editorContent);
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
              abortRlQuestionForEditor(editorContent);
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
              initialContentStr: normalizeLine(initialContentStr),
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

  prependToChatHistory(firstMessage, "user");
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
  prependToChatHistory(inputResult.value, "user");

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
    if (isAbortError(exitResult.error)) {
      rl.close();
      printSessionStartDate();
      await getState().mcp.close();
      process.exit(0);
    }

    print.error(getMessageFromError(exitResult.error));
    return;
  }

  if (/^y(es)?$/i.exec(exitResult.value) !== null) {
    actions.appendStdoutTail(
      `${getState().config.promptPrefix}${exitResult.value}\n`,
    );

    rl.close();
    printSessionStartDate();
    await getState().mcp.close();
    process.exit(0);
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
      if (content !== null) prependToChatHistory(content, "user");
      return { handled: true, inputFromCommand: content };
    }
    case "editpage": {
      pageEditStr();
      return { handled: true, inputFromCommand: null };
    }
    case "paste": {
      const content = await spawnAndReadEditorContent({
        includeClipboardSuffix: true,
      });
      if (content !== null) prependToChatHistory(content, "user");
      return { handled: true, inputFromCommand: content };
    }
    case "clear": {
      clearCommand();
      return { handled: true, inputFromCommand: null };
    }
    case "history": {
      pageHistory();
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
      pageContextStr();
      return { handled: true, inputFromCommand: null };
    }
    case "commands": {
      pageCommands();
      return { handled: true, inputFromCommand: null };
    }
    case "commandspage": {
      pageCustomSlashCommandsStr();

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
    case "config": {
      const initialContentStr = getAllPrettyConfig();

      openWithPager({
        initialContentStr: normalizeLine(initialContentStr),
        contentType: "markdown",
      });

      return { handled: true, inputFromCommand: null };
    }
    case "resume": {
      print.error("Usage: /resume [session start date]");
      return { handled: true, inputFromCommand: null };
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
      await pageLastResponse();
      return { handled: true, inputFromCommand: null };
    }
    case "lastmessage": {
      pageLastMessage();
      return { handled: true, inputFromCommand: null };
    }
    case "lastdiff": {
      pageLastDiff();
      return { handled: true, inputFromCommand: null };
    }
    case "messages": {
      pageMessages();
      return { handled: true, inputFromCommand: null };
    }
    case "summaries": {
      pageSummaries();
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
      const content = resume(commandWithArgs);
      if (content !== null) prependToChatHistory(content, "user");
      return { handled: true, inputFromCommand: content };
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
    return { handled: true, inputFromCommand: matchedCommand.content };
  }

  const contentWithCommandContext = `Follow the instructions below along with the provided context:
## [lasso] Instructions
${matchedCommand.content}

## [lasso] Context
${commandContext}
`;

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
  actions.resetConversation();
  // the next api call only reports its token usage after it completes, so seeding with the
  // system prompt approx keeps the context window percent from displaying 0% in the meantime
  actions.setPromptTokens(getApproxPromptTokens());
  actions.setModelUsageForSession({});
}

export function printUsage() {
  print.doing(getPrettyUsage());
}

export async function spawnAndReadEditorContent(opts?: {
  includeClipboardSuffix?: boolean;
}) {
  const includeClipboardSuffix = opts?.includeClipboardSuffix ?? false;

  const initialContent = await getEditorInitialContent({
    includeClipboardSuffix,
  });

  const tempFile = getTempFileName();
  if (tempFile === null) return null;

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
  if (readResult.value === "") return null;

  return normalizeLine(readResult.value);
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

export function pageContextStr() {
  if (getState().app.contextEntries.length === 0) {
    print.doing("No available context files");
    return;
  }

  const initialContentStr = getState().app.contextStr;

  openWithPager({
    initialContentStr: normalizeLine(initialContentStr),
    contentType: "markdown",
  });
}

export function pageEditStr() {
  const { editorInputValue } = getState().app;
  if (editorInputValue === null) {
    print.doing("Editor is empty");
    return;
  }

  const initialContentStr = `# [lasso] Editor content

${editorInputValue}`;

  openWithPager({
    initialContentStr: normalizeLine(initialContentStr),
    contentType: "markdown",
  });
}

export function pageCommands() {
  const initialContentStr = `# Available commands:

${getAvailableCommandsStr()}`;

  openWithPager({
    initialContentStr: normalizeLine(initialContentStr),
    contentType: "markdown",
  });
}

export function pageCustomSlashCommandsStr() {
  if (getState().app.slashCommands.length === 0) {
    print.doing("No available custom slash commands");
    return;
  }

  const initialContentStr = getCustomSlashCommandsStr();

  openWithPager({
    initialContentStr: normalizeLine(initialContentStr),
    contentType: "markdown",
  });
}

export function printSkills() {
  if (getState().app.skills.length === 0) {
    printNewline();
    print.doing("No available skills");
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

  printNewline();
  print.doing("Available skills:");
  print.plain(skillsList);
}

export function printAvailableContextFiles() {
  if (getState().app.contextEntries.length === 0) {
    printNewline();
    print.doing("No available context files");
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

  printNewline();
  print.doing("Available context files:");
  print.plain(formatted);
}

function resumeFromTranscript(transcript: string) {
  actions.resetConversation();
  return `Continue the conversation recorded in the transcript below. Respond to this message with "Ready to continue chatting."
Transcript:
${transcript}`;
}

export function resume(rawInput: string) {
  const parts = rawInput.split(/\s+/);

  if (parts.length === 1) {
    const chatHistoryFileEntries = listChatHistoryFiles();
    if (chatHistoryFileEntries.length === 0) {
      print.error("No sessions to resume");
      return null;
    }

    const sortedEntries = chatHistoryFileEntries.toSorted(
      (a, b) => b.timestampMs - a.timestampMs,
    );
    const historyEntry = sortedEntries[0];
    assertAtBuildtime(historyEntry !== undefined);

    const { absolutePath, timestampMs } = historyEntry;
    const readResult = tryCatch(() =>
      fsDeps.readFileSync(absolutePath).toString(),
    );
    if (!readResult.ok) {
      print.error(
        `Unable to read the transcript from session ${String(timestampMs)} located at ${absolutePath}`,
      );
      return null;
    }
    return resumeFromTranscript(readResult.value);
  }

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

  const chatHistoryFileEntries = listChatHistoryFiles();
  for (const { absolutePath, timestampMs } of chatHistoryFileEntries) {
    if (timestampMs !== Number(sessionStartDate)) continue;

    const readResult = tryCatch(() =>
      fsDeps.readFileSync(absolutePath).toString(),
    );
    if (!readResult.ok) continue;
    return resumeFromTranscript(readResult.value);
  }

  print.error(
    `No conversation found with session start date: ${sessionStartDate}`,
  );
  return null;
}

export function printKeymaps() {
  printNewline();
  print.doing("Keymaps:");
  for (const [command, keymap] of Object.entries(getState().config.keymaps)) {
    print.plain(`- ${command}: ${JSON.stringify(keymap)}`);
  }
}

function markdownFence(lang: string, content: string) {
  return `\`\`\`${lang}
${content}
\`\`\``;
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
${diffResult.value.stdout}
`,
      );
    }
  }
  for (const path of beforeFiles.concat(afterFiles).filter((p) => p !== null)) {
    tryCatch(() => fsDeps.unlinkSync(path));
  }

  const diff = diffResults.join("");
  if (diff.length === 0) {
    print.info("No diff from reload");
  } else {
    openWithPager({
      initialContentStr: normalizeLine(diff),
      contentType: "diff",
    });
  }
  warnOnLargePromptOverhead();
}

const getDefaultConfig = (
  command: "initlocal" | "initglobal",
) => `# This config was auto-generated by the /${command} command
model: deepseek-v4-pro
baseURL: https://opencode.ai/zen/v1
`;

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
      print.warning(`Failed to create the directory: ${dir}`);
      return;
    }
  }

  const writeResult = tryCatch(() =>
    fsDeps.writeFileSync(path, getDefaultConfig("initlocal")),
  );
  if (!writeResult.ok) {
    print.warning(`Failed to write the config to ${path}`);
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
      print.warning(`Failed to create the directory: ${dir}`);
      return;
    }
  }

  const writeResult = tryCatch(() =>
    fsDeps.writeFileSync(path, getDefaultConfig("initglobal")),
  );
  if (!writeResult.ok) {
    print.warning(`Failed to write the config to ${path}`);
    return;
  }
  print.info(`Created the global config at ${path}`);
}

export function pageHistory() {
  const path = getState().app.chatHistoryPath;
  const readResult = tryCatch(() => fsDeps.readFileSync(path).toString());
  const historyStr = readResult.ok ? readResult.value : "";

  if (historyStr.length === 0) {
    print.doing("No chat history");
    return;
  }

  const initialContentStr = `# [lasso] Chat history

${historyStr}`;

  openWithPager({
    initialContentStr: normalizeLine(initialContentStr),
    contentType: "markdown",
  });
}

export async function pageLastResponse() {
  const { messages } = getState().app.conversation;
  const lastMessage = messages.findLast(
    (message) => message.role === "assistant",
  );

  if (lastMessage == undefined) {
    print.doing("No llm messages");
    return;
  }

  const contentStr = getStrFromAssistantContent(lastMessage.content);
  if (contentStr.length === 0) {
    print.doing("No llm messages");
    return;
  }

  const formattedContentStr = await formatMarkdown(contentStr);

  const initialContentStr = `# [lasso] Last response

${formattedContentStr}`;

  openWithPager({
    initialContentStr: normalizeLine(initialContentStr),
    contentType: "markdown",
  });
}

export function pageLastMessage() {
  const { messages } = getState().app.conversation;
  const lastMessage = messages.findLast((message) => message.role === "user");

  if (lastMessage == undefined) {
    print.doing("No user messages");
    return;
  }

  const contentStr = lastMessage.content;
  assertAtBuildtime(typeof contentStr === "string");

  if (contentStr.length === 0) {
    print.doing("No user messages");
    return;
  }

  const initialContentStr = `# [lasso] Last message

${contentStr}`;

  openWithPager({
    initialContentStr: normalizeLine(initialContentStr),
    contentType: "markdown",
  });
}

export function pageMessages() {
  const initialContentStr = `# [lasso] Messages

${stringify(getState().app.conversation.messages.toReversed())}`;

  openWithPager({
    initialContentStr: normalizeLine(initialContentStr),
    contentType: "markdown",
  });
}

export function pageSummaries() {
  if (getState().app.conversation.summaries.length === 0) {
    print.doing("No conversation summaries");
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
    initialContentStr: normalizeLine(initialContentStr),
    contentType: "markdown",
  });
}

export function pageLastDiff() {
  const { toolEditDiffs } = getState().app;

  if (toolEditDiffs.length === 0) {
    print.doing("No diffs from the last turn");
    return;
  }
  const initialContentStr = toolEditDiffs
    .map(
      ({ diffStdout, fileName }) => `${wrapInFence(fileName)}
${diffStdout}
`,
    )
    .join("\n");

  openWithPager({
    initialContentStr: normalizeLine(initialContentStr),
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
