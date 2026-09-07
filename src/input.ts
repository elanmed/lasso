import readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import assert from "node:assert";
import { Writable } from "node:stream";
import {
  isAbortError,
  tryCatch,
  tryCatchAsync,
  getMessageFromError,
  normalizeLine,
  getTempFileName,
  execPromise,
  isExisty,
  truncate,
  listChatHistoryFiles,
  openWithPager,
  stringify,
} from "./utils.ts";
import {
  print,
  printNewline,
  fencePrint,
  printSessionStartDate,
} from "./print.ts";
import { getPrettyTokenUsage, getPrettyUsage } from "./usage.ts";
import { basename, dirname, extname, join } from "node:path";
import { actions, getState, type SlashCommand } from "./state.ts";
import childProcess from "node:child_process";
import os from "node:os";
import { initStateRepeatable, type Key } from "./config.ts";
import { appendToChatHistory } from "./log.ts";
import { fsDeps, processDeps } from "./deps.ts";
import {
  getGlobalConfigPath,
  getGlobalSlashCommandDir,
  getLocalConfigPath,
  getLocalSlashCommandDir,
} from "./paths.ts";
import { contextFileSkillNamePrefix } from "./context.ts";
import { execGitDiff } from "./tools.ts";

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
  assert(rl !== null);

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
    assert(rl !== null);

    const truncatedFirstLine = truncate(editorContent);
    rl.write(truncatedFirstLine);
    actions.appendToStdout(truncatedFirstLine);

    abortController.abort();
  }
}

export function initKeypress() {
  const rl = getState().app.rl;
  assert(rl !== null);

  function typeCommand(command: string) {
    assert(rl !== null);
    const output = `/${command}\n`;
    rl.write(output);
    actions.appendToStdout(output);
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
            if (editorContent !== null) {
              abortRlQuestionForEditor(editorContent);
            }
            return;
          }
          case "editpage": {
            await pageEditStr();
            return;
          }
          case "paste": {
            const editorContent = await spawnAndReadEditorContent({
              includeClipboardSuffix: true,
            });
            if (editorContent !== null) {
              abortRlQuestionForEditor(editorContent);
            }
            return;
          }
          case "history": {
            await openWithPager({
              initialContentPath: getState().app.chatHistoryPath,
              pagerEnvKey: "LASSO_PAGER_HISTORY",
              contentType: "markdown",
            });
            return;
          }
          case "config": {
            await openWithPager({
              pagerEnvKey: "LASSO_PAGER_CONFIG",
              initialContentStr: getAllPrettyConfig(),
              contentType: "markdown",
            });

            return;
          }
          case "contextpage": {
            await pageContextStr();
            return;
          }
          case "commandspage": {
            await pageCustomSlashCommandsStr();
            return;
          }
          case "reload": {
            await reload();
            return;
          }
          case "init-local":
          case "init-global":
          case "model":
          case "skills":
          case "context":
          case "commands":
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
  assert(rl !== null);
  rl.on("SIGINT", () => {
    const apiStream = getState().abortControllers.apiStream;
    const interruptWithEditorContent =
      getState().abortControllers.interruptWithEditorContent;
    const question = getState().abortControllers.question;
    const controllers = [apiStream, interruptWithEditorContent, question];
    assert(controllers.filter((c) => c !== null).length <= 1);

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
  assert(editorInputValue !== null);
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

  appendToChatHistory(firstMessage, "user");
  return firstMessage;
}

export async function resolveUserInput({
  isFirstInput,
}: {
  isFirstInput: boolean;
}) {
  const rl = getState().app.rl;
  assert(rl !== null);

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
  assert(abortController !== null);
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

  actions.appendToStdout(
    `${getState().config.promptPrefix}${inputResult.value}\n`,
  );
  appendToChatHistory(inputResult.value, "user");

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
  assert(rl !== null);

  actions.setQuestionAbortController(new AbortController());
  const abortController = getState().abortControllers.question;
  assert(abortController !== null);
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
      process.exit(0);
    }

    print.error(getMessageFromError(exitResult.error));
    return;
  }

  if (/^y(es)?$/i.exec(exitResult.value) !== null) {
    actions.appendToStdout(
      `${getState().config.promptPrefix}${exitResult.value}\n`,
    );

    rl.close();
    printSessionStartDate();
    process.exit(0);
  }

  return;
}

export async function resolveInterruptWithEditor() {
  const rl = getState().app.rl;
  assert(rl !== null);

  actions.setInterruptWithEditorAbortController(new AbortController());
  const abortController =
    getState().abortControllers.interruptWithEditorContent;
  assert(abortController !== null);
  const continueResult = await tryCatchAsync(
    rl.question(
      `There are pending messages! Update the editor with the keymap ${JSON.stringify(getState().config.keymaps.edit)} and/or press enter when ready to continue.`,
      {
        signal: abortController.signal,
      },
    ),
  );
  actions.setInterruptWithEditorAbortController(null);

  if (continueResult.ok) return;
  if (isAbortError(continueResult.error)) return;

  print.error(getMessageFromError(continueResult.error));
}

const builtinSlashCommands = [
  "edit",
  "editpage",
  "history",
  "clear",
  "paste",
  "model",
  "skills",
  "context",
  "contextpage",
  "commands",
  "commandspage",
  "keymaps",
  "usage",
  "resume",
  "config",
  "reload",
  "init-local",
  "init-global",
] as const;
type BuiltinSlashCommand = (typeof builtinSlashCommands)[number];

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
      if (content !== null) appendToChatHistory(content, "user");
      return { handled: true, inputFromCommand: content };
    }
    case "editpage": {
      await pageEditStr();
      return { handled: true, inputFromCommand: null };
    }
    case "paste": {
      const content = await spawnAndReadEditorContent({
        includeClipboardSuffix: true,
      });
      if (content !== null) appendToChatHistory(content, "user");
      return { handled: true, inputFromCommand: content };
    }
    case "clear": {
      clearCommand();
      return { handled: true, inputFromCommand: null };
    }
    case "history": {
      await openWithPager({
        initialContentPath: getState().app.chatHistoryPath,
        pagerEnvKey: "LASSO_PAGER_HISTORY",
        contentType: "markdown",
      });
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
      await pageContextStr();
      return { handled: true, inputFromCommand: null };
    }
    case "commands": {
      printAvailableCommandsStr();
      return { handled: true, inputFromCommand: null };
    }
    case "commandspage": {
      await pageCustomSlashCommandsStr();

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
      await openWithPager({
        pagerEnvKey: "LASSO_PAGER_CONFIG",
        initialContentStr: getAllPrettyConfig(),
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
    case "init-local": {
      initLocalConfig();
      return { handled: true, inputFromCommand: null };
    }
    case "init-global": {
      initGlobalConfig();
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
      if (content !== null) appendToChatHistory(content, "user");
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

  print.infoSubtle(`Executing slash command: ${command}`);

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
  print(getAvailableCommandsStr());
  return null;
}

export function clearCommand() {
  print.infoSubtle(`Context cleared (${getPrettyTokenUsage()})`);
  actions.resetMessageParams();
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
  assert(model !== undefined);

  const prevModel = getState().config.model;
  actions.setModel(model);
  print.doing(`Model updated from \`${prevModel}\` to \`${model}\``);
  actions.setMessageParamTokensStale(true);
}

export async function pageContextStr() {
  if (getState().app.contextEntries.length === 0) {
    printNewline();
    print.doing("No available context files");
    return;
  }

  await openWithPager({
    pagerEnvKey: "LASSO_PAGER_CONTEXT",
    initialContentStr: getState().app.contextStr,
    contentType: "markdown",
  });
}

export async function pageEditStr() {
  const { editorInputValue } = getState().app;
  if (editorInputValue === null) {
    printNewline();
    print.doing("Editor is empty");
    return;
  }

  await openWithPager({
    initialContentStr: editorInputValue,
    pagerEnvKey: "LASSO_PAGER_EDIT",
    contentType: "markdown",
  });
}

export function printAvailableCommandsStr() {
  printNewline();
  print.doing("Available commands:");
  print(getAvailableCommandsStr());
}

export async function pageCustomSlashCommandsStr() {
  if (getState().app.slashCommands.length === 0) {
    printNewline();
    print.doing("No available custom slash commands");
    return;
  }

  await openWithPager({
    pagerEnvKey: "LASSO_PAGER_COMMANDS",
    initialContentStr: getCustomSlashCommandsStr(),
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
  print(skillsList);
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
  print(formatted);
}

export function resume(rawInput: string) {
  const parts = rawInput.split(/\s+/);

  if (parts.length !== 2) {
    print.error("Usage: /resume [session start date]");
    return null;
  }
  const sessionStartDate = parts[1];
  assert(sessionStartDate !== undefined);

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

    actions.resetMessageParams();
    return `Continue the conversation recorded in the transcript below. Respond to this message with "Ready to continue chatting."
Transcript:
${readResult.value}
    `;
  }

  print.error(
    `No conversation found with session start date: ${sessionStartDate}`,
  );
  return null;
}

function getAvailableCommandsStr() {
  const customCommandsFormatted = getState().app.slashCommands.map(
    (command) => `- ${command.filePath}`,
  );

  const builtinCommandsFormatted = builtinSlashCommands.map(
    (command) => `- /${command}`,
  );

  return builtinCommandsFormatted.concat(customCommandsFormatted).join("\n");
}

export function isSameKey(a: Key, b: Key) {
  return (
    a.name === b.name &&
    (a.ctrl ?? false) === (b.ctrl ?? false) &&
    (a.meta ?? false) === (b.meta ?? false) &&
    (a.shift ?? false) === (b.shift ?? false)
  );
}

export function printKeymaps() {
  printNewline();
  print.doing("Keymaps:");
  for (const [command, keymap] of Object.entries(getState().config.keymaps)) {
    print(`- ${command}: ${JSON.stringify(keymap)}`);
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

function getCustomSlashCommandsStr() {
  const contents = getState()
    .app.slashCommands.map(
      ({ content, filePath }) => `## ${filePath}

${content}`,
    )
    .join("\n\n");

  return `# [lasso] Slash commands:

${contents}`;
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
    assert(beforeFile !== undefined);

    const afterFile = afterFiles[i];
    assert(afterFile !== undefined);

    const diffResult = await tryCatchAsync(
      execGitDiff({
        tempFileBeforePath: beforeFile,
        tempFileAfterPath: afterFile,
      }),
    );

    if (!diffResult.ok) {
      for (const path of beforeFiles.concat(afterFiles)) {
        fsDeps.unlinkSync(path);
      }
      print.error(
        `An error occurred when getting the diff: ${getMessageFromError(diffResult.error)}`,
      );
      return;
    }

    if (diffResult.value.stdout.length > 0) {
      const prefix = reloadTempFilePrefixes[i];
      assert(prefix !== undefined);
      diffResults.push(
        `${getReloadTempFileDiffTitle()[prefix]}
${diffResult.value.stdout}
`,
      );
    }
  }
  for (const path of beforeFiles.concat(afterFiles)) {
    fsDeps.unlinkSync(path);
  }

  const diff = diffResults.join("");
  if (diff.length === 0) {
    print.info("No diff from reload");
    return;
  }

  await openWithPager({
    pagerEnvKey: "LASSO_PAGER_RELOAD",
    initialContentStr: diff,
    contentType: "diff",
  });
}

const getDefaultConfig = (
  command: "init-local" | "init-global",
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
    fsDeps.writeFileSync(path, getDefaultConfig("init-local")),
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
    fsDeps.writeFileSync(path, getDefaultConfig("init-global")),
  );
  if (!writeResult.ok) {
    print.warning(`Failed to write the config to ${path}`);
    return;
  }
  print.info(`Created the global config at ${path}`);
}

export function clearRlLine(): readline.Interface | null {
  const rl = getState().app.rl;
  assert(rl !== null);
  rl.write(null, { ctrl: true, name: "e" });
  rl.write(null, { ctrl: true, name: "u" });
  return rl;
}

export function getAvailableSlashCommands() {
  const seenSlashCommands = new Set<string>();

  const entries: SlashCommand[] = [];
  const slashCommandFilePaths: string[] = [];

  const slashCommandDirs = [
    ...getState().config.customSlashCommandDirs,
    getLocalSlashCommandDir(),
    getGlobalSlashCommandDir(),
  ];

  for (const dir of slashCommandDirs) {
    const glob = join(dir, "**/*.md");
    const globResult = tryCatch(() => fsDeps.globbySync(glob));
    if (!globResult.ok) continue;
    slashCommandFilePaths.push(...globResult.value);
  }

  for (const filePath of slashCommandFilePaths) {
    const readResult = tryCatch(() => fsDeps.readFileSync(filePath).toString());
    if (!readResult.ok) continue;
    const name = basename(filePath, extname(filePath));
    if (seenSlashCommands.has(name)) continue;
    seenSlashCommands.add(name);

    entries.push({ filePath, name, content: readResult.value });
  }

  return entries;
}
