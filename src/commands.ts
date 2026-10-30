import os from "node:os";
import { basename, extname, join } from "node:path";
import readline from "node:readline/promises";
import { once } from "node:events";
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import { type AssistantContent, type Tool } from "ai";
import {
  assertAtBuildtime,
  isAbortError,
  tryCatchAsync,
  getMessageFromError,
  markdownFence,
  normalizeNewline,
  shellQuote,
  stringify,
  isExisty,
  wrapInColor,
  getPrettyMoney,
  isNullish,
  getPrettyDate,
} from "./utils.ts";
import { actions, getState, type SlashCommand } from "./state.ts";
import { aiDeps, childProcessDeps, fsDeps, processDeps } from "./deps.ts";
import {
  getGlobalConfigPath,
  getGlobalSlashCommandDir,
  getLocalConfigPath,
  getLocalSlashCommandDir,
} from "./paths.ts";
import {
  getUsageMoneyForModel,
  sumUsageTokens,
  isUsageLimitDisabled,
  getPrettyTokenUsage,
} from "./usage.ts";
import {
  truncate,
  print,
  printNewline,
  successWithSpacing,
  errorWithSpacing,
  wrapInFence,
  streamingSupportedWithSpacing,
  wrapToOpenNonBlockingProcess,
  getTempFileName,
  formatMarkdown,
  markdownBatFlags,
  baseBatFlags,
  execGitDiff,
} from "./printing.ts";
import type { SpacingOpts } from "./printing.ts";
import {
  getAppendedTranscript,
  interruptContent,
  listSessionFiles,
  syncSessionFile,
  resumeFromSessionFile,
} from "./session.ts";
import {
  printMissingConfigWarnings,
  resetConfigMessages,
  getTranscriptionProvider,
  initLocalConfig,
  initGlobalConfig,
  getAllPrettyConfig,
} from "./config.ts";
import { harnessTools } from "./tools.ts";
import {
  printLargeContextOverheadWarning,
  getApproxRequestInputTokens,
  getRequestInputCharLength,
  getPrettyTokensByArea,
  getTokensByArea,
  getPrettyContextWindowUsage,
  formatTokenCountAside,
  formatTokenRangeAside,
} from "./tokens.ts";
import { isSameKey, type Key } from "./schemas.ts";
import { printMcps } from "./mcp.ts";

export const contextFileSkillNamePrefix = "__lasso-context-for";

export const builtinSlashCommands = [
  "edit",
  "editpage",
  "history",
  "clear",
  "paste",
  "skills",
  "context",
  "commands",
  "keymaps",
  "usage",
  "tokens",
  "resume",
  "config",
  "reload",
  "initlocal",
  "initglobal",
  "lastresponse",
  "lastmessage",
  "lastdiff",
  "summaries",
  "tools",
  "record",
  "mcps",
  "steer",
] as const;

export type BuiltinSlashCommand = (typeof builtinSlashCommands)[number];

export function getAvailableCommandsStr({
  includeTokenCount = false,
}: { includeTokenCount?: boolean } = {}) {
  const customCommandsFormatted = getState().content.slashCommands.map(
    (command) => {
      const suffix = (() => {
        if (!includeTokenCount) return "";
        return ` ${formatTokenCountAside(command.content)}`;
      })();

      return `- ${command.filePath}${suffix}`;
    },
  );
  const builtinCommandsFormatted = builtinSlashCommands.map(
    (command) => `- /${command}`,
  );
  return builtinCommandsFormatted.concat(customCommandsFormatted).join("\n");
}

export function getCustomSlashCommandsStr() {
  const contents = getState()
    .content.slashCommands.map(
      ({ content, filePath }) => `## ${filePath}

${normalizeNewline(content, { count: 0 })}`,
    )
    .join("\n\n");

  return `# [lasso] Slash commands:

${contents}`;
}

function splitArgs(input: string) {
  return input.split(/\s+/);
}

function hasArgs(input: string) {
  return splitArgs(input).length > 1;
}

export async function openWithPager({
  initialContentStr,
  contentType,
}: {
  initialContentStr: string;
  contentType: "diff" | "markdown";
}): Promise<void> {
  initialContentStr = normalizeNewline(initialContentStr, { count: 2 });
  const tempFile = await getTempFileName({ initialContentStr });
  if (tempFile === null) return;

  const pagerCommand = (() => {
    const lassoDefaultPagerEnvValue = processDeps.env.get("LASSO_PAGER");
    if (isExisty(lassoDefaultPagerEnvValue)) {
      return lassoDefaultPagerEnvValue.replace("__FILE__", tempFile);
    }

    const defaultPagerEnvValue = processDeps.env.get("PAGER");
    if (isExisty(defaultPagerEnvValue)) {
      return `${defaultPagerEnvValue} ${shellQuote(tempFile)}`;
    }

    if (getState().content.batAvailable) {
      const batFlags =
        contentType === "diff"
          ? baseBatFlags()
          : baseBatFlags().concat(markdownBatFlags);

      return `bat ${batFlags.join(" ")} --paging=always ${shellQuote(tempFile)}`;
    }

    return `less ${shellQuote(tempFile)}`;
  })();

  await wrapToOpenNonBlockingProcess(async () => {
    const pagerProcess = childProcessDeps.spawn(pagerCommand, {
      shell: true,
      stdio: "inherit",
    });
    const onceResult = await tryCatchAsync(once(pagerProcess, "exit"));
    if (!onceResult.ok) {
      print.error(
        `Error while spawning the pager: ${getMessageFromError(onceResult.error)}`,
      );
    }
    await tryCatchAsync(fsDeps.unlink(tempFile));
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
  if (tempFile === null) return null;

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
      actions.terminal.setEditorInputValue(null);
    }
    return null;
  }

  actions.terminal.setEditorInputValue(readResult.value);
  return normalizeNewline(readResult.value);
}

export async function pageEditStr({ isTyped = false }: SpacingOpts = {}) {
  const { editorInputValue } = getState().terminal;
  if (editorInputValue === null) {
    streamingSupportedWithSpacing(isTyped, () =>
      print.warning("Editor is empty"),
    );
    return;
  }

  const initialContentStr = `# [lasso] Editor content ${formatTokenCountAside(editorInputValue)}

${editorInputValue}`;

  await openWithPager({
    initialContentStr,
    contentType: "markdown",
  });
}

async function pageForInvalidCommand(rawInput: string) {
  const initialContentStr = `# Invalid command: \`${rawInput}\`

## Available commands

${getAvailableCommandsStr({ includeTokenCount: true })}`;

  await openWithPager({
    initialContentStr,
    contentType: "markdown",
  });
}

export async function pageCommands() {
  const initialContentStr = `# [lasso] Available commands:

${getAvailableCommandsStr({ includeTokenCount: true })}`;

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
      (
        skill,
      ) => `- **${skill.name}** ${formatTokenRangeAside(skill.description, skill.content)}: ${skill.description}
  ${skill.dir}`,
    )
    .join("\n");

  const initialContentStr = `# [lasso] Available skills:

${skillsList}`;

  await openWithPager({ contentType: "markdown", initialContentStr });
}

export async function pageContext({ isTyped = false }: SpacingOpts = {}) {
  if (getState().content.contextEntries.length === 0) {
    streamingSupportedWithSpacing(isTyped, () =>
      print.warning("No available context files"),
    );
    return;
  }

  const contextFiles = getState().content.contextEntries.map(
    (context) =>
      `- ${context.filePath} ${formatTokenCountAside(context.content)}`,
  );

  const contextSkillFiles = getState()
    .content.skills.filter((skill) =>
      skill.name.startsWith(contextFileSkillNamePrefix),
    )
    .map(
      (skill) =>
        `- ${join(skill.dir, "AGENTS.md")} ${formatTokenRangeAside(skill.description, skill.content)}`,
    );

  const formatted = contextFiles.concat(contextSkillFiles).join("\n");

  const initialContentStr = `# [lasso] Available context files:

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
  const parts = splitArgs(rawInput);

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
      print.plain(`- ${command}: ${stringify(keymap, { space: 0 })}`);
    }
  });
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
    const dollarsInSession = `$${getPrettyMoney(getUsageMoneyForModel(tokenUsageForSession, pricing))}`;
    return `${tokensInSession}, ${dollarsInSession}`;
  })();

  successWithSpacing(() => {
    print.doing("Usage:");
    print.plain(`- Session: ${usedInSession}`);

    if (!isUsageLimitDisabled()) {
      assertAtBuildtime(usageLimit !== undefined);
      assertAtBuildtime(pricing !== undefined);
      const costForLimitWindow = getUsageMoneyForModel(
        tokenUsageForLimitWindow,
        pricing,
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

export async function clearCommand() {
  print.infoSubtle(`Context cleared (${getPrettyTokenUsage()})`);
  await syncSessionFile({
    messages: [],
    summaries: [],
    transcript: [],
  });
  // the next api call only reports its token usage after it completes, so seeding with the
  // request input approximation keeps the context window percent from displaying 0% in the meantime
  actions.usage.setRequestInputTokens(getApproxRequestInputTokens());
  actions.usage.setRequestInputTokensCharLength(getRequestInputCharLength());
  actions.usage.setModelUsageForSession({});
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
  const lastMessage = messages.findLast(
    (message) =>
      message.role === "user" && message.content !== interruptContent,
  );

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

    return `- **[${prefix}] ${name}** ${formatTokenCountAside(stringify(tool, { space: 0 }))}: ${description}`;
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

  const initialContentStr = `# [lasso] Available tools:

${formattedHarnessTools.concat(formattedMCPTools).join("\n")}`;

  await openWithPager({
    initialContentStr,
    contentType: "markdown",
  });
}

export function steerCommand({ isTyped = false }: SpacingOpts = {}) {
  if (isTyped) {
    errorWithSpacing(() => {
      print.warning(
        "/steer can only be triggered via a keymap during an ongoing agent turn",
      );
    });
    return;
  }

  const apiStream = getState().abortControllers.apiStream;
  if (apiStream === null) {
    streamingSupportedWithSpacing(isTyped, () => {
      print.warning(
        "/steer can only be triggered during an ongoing agent turn",
      );
    });
    return;
  }

  if (getState().terminal.editorInputValue === null) {
    print.warning("The editor is empty, unable to steer");
    return;
  }

  apiStream.abort();
  actions.terminal.setIsSteering(true);
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

    print.warning(warning, { whileBuffering: true });
    return true;
  }
  return false;
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
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  recordingProcess.stdout.on("data", (chunk: Buffer) =>
    outputChunks.push(chunk),
  );

  abortController.signal.addEventListener("abort", () => {
    recordingProcess.kill("SIGINT");
  });

  const recordingFinished = once(recordingProcess, "close");
  const recordingReady = once(recordingProcess, "spawn");

  return {
    stop: () => recordingProcess.kill("SIGINT"),
    recordingFinished,
    recordingReady,
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

export async function recordAndTranscribeInput({
  isTyped = false,
}: SpacingOpts = {}) {
  const rl = getState().terminal.rl;
  assertAtBuildtime(rl !== null);

  const missingConfig = warnOnMissingTranscribeConfig();
  if (missingConfig) return null;

  const abortController = new AbortController();
  actions.abortControllers.setRecordProcess(abortController);

  const tempFile = await getTempFileName({ extension: "wav" });
  if (tempFile === null) {
    actions.abortControllers.setRecordProcess(null);
    return null;
  }

  async function cleanup() {
    assertAtBuildtime(tempFile !== null);
    await tryCatchAsync(fsDeps.unlink(tempFile));
  }

  const { stop, recordingFinished, recordingReady } = recordInput(tempFile);
  const recordingPromise = tryCatchAsync(recordingFinished);

  const readyResult = await tryCatchAsync(recordingReady);
  if (!readyResult.ok) {
    print.error(`Recording failed: ${getMessageFromError(readyResult.error)}`, {
      whileBuffering: !isTyped,
    });
    await cleanup();
    return null;
  }

  const query = `${wrapInColor("⏺", "red")} Press enter to stop recording `;
  let questionPromise: Promise<string>;

  if (isTyped) {
    questionPromise = rl.question(query, { signal: abortController.signal });
  } else {
    print.plain(query.concat("\n"), {
      appendNewline: false,
      whileBuffering: true,
    });
    // rl.question writes its prompt through mutedStdout which drops output
    // during the recording, so the banner is printed directly instead
    questionPromise = rl.question("", { signal: abortController.signal });
  }
  const finishRecordingResult = await tryCatchAsync(questionPromise);
  stop();

  const recordingResult = await recordingPromise;
  actions.abortControllers.setRecordProcess(null);
  if (!recordingResult.ok) {
    print.error(
      `Recording failed: ${getMessageFromError(recordingResult.error)}`,
      { whileBuffering: !isTyped },
    );
    await cleanup();
    return null;
  }

  if (!finishRecordingResult.ok) {
    if (isAbortError(finishRecordingResult.error)) {
      print.warning("Cancelled");
      await cleanup();
      return null;
    }

    print.error(
      `Error while prompting the user to stop recording: ${getMessageFromError(finishRecordingResult.error)}`,
      { whileBuffering: !isTyped },
    );
    await cleanup();
    return null;
  }

  const readResult = await tryCatchAsync(fsDeps.readFile(tempFile));
  await cleanup();
  if (!readResult.ok) {
    print.error(
      `Error while reading the temp file that was recorded to: ${getMessageFromError(readResult.error)}`,
      { whileBuffering: !isTyped },
    );
    return null;
  }

  const transcriptionAbortController = new AbortController();
  actions.abortControllers.setTranscription(transcriptionAbortController);
  const transcribeResult = await tryCatchAsync(
    transcribeInput(readResult.value),
  );
  actions.abortControllers.setTranscription(null);

  if (!transcribeResult.ok) {
    if (isAbortError(transcribeResult.error)) {
      await cleanup();
      return null;
    }

    print.error(
      `Error while transcribing: ${getMessageFromError(transcribeResult.error)}`,
      { whileBuffering: !isTyped },
    );
    return null;
  }

  if (transcribeResult.value === "") {
    print.error("Empty transcription result");
    return null;
  }

  print.doing("Transcribed: ", { appendNewline: false, whileBuffering: true });
  print.plain(transcribeResult.value, { whileBuffering: true });
  return "[Message transcribed; may contain errors] ".concat(
    transcribeResult.value,
  );
}

export function getStrFromAssistantContent(content: AssistantContent) {
  if (typeof content === "string") return content;
  return content
    .map((c) => {
      const { type: ctype } = c;
      switch (ctype) {
        case "text": {
          return c.text;
        }
        case "file":
        case "custom":
        case "reasoning":
        case "reasoning-file":
        case "tool-call":
        case "tool-result":
        case "tool-approval-request": {
          return "";
        }
        default: {
          ctype satisfies never;
          return "";
        }
      }
    })
    .join("\n");
}

// TODO: mcp clients?
// TODO: tools?
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
  applied: markdownFence("json", stringify(getState().config, { space: 2 })),
  context: getState().content.contextStr,
  commands: getCustomSlashCommandsStr(),
  skills: getState().content.skillsStr,
});

export async function getAvailableSlashCommands() {
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
    const globResult = await tryCatchAsync(fsDeps.glob(glob));
    if (!globResult.ok) {
      actions.content.appendConfigWarningMessage(
        `Failed to list the slash command files in \`${dir}\`, ignoring. Error: ${getMessageFromError(globResult.error, { forceSingleLine: true })}`,
      );
      continue;
    }
    slashCommandFilePaths.push(...globResult.value);
  }

  for (const filePath of slashCommandFilePaths) {
    const readResult = await tryCatchAsync(fsDeps.readFile(filePath, "utf8"));
    if (!readResult.ok) {
      actions.content.appendConfigWarningMessage(
        `Failed to read the slash command file at \`${filePath}\`, ignoring. Error: ${getMessageFromError(readResult.error, { forceSingleLine: true })}`,
      );
      continue;
    }
    const name = basename(filePath, extname(filePath));
    if (seenSlashCommands.has(name)) continue;
    seenSlashCommands.add(name);

    entries.push({ filePath, name, content: readResult.value });
  }

  return entries;
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

interface SlashCommandOutcome {
  handled: boolean;
  inputFromCommand: string | null;
}

function printUsageIfArgs(commandWithArgs: string) {
  if (!hasArgs(commandWithArgs)) return false;
  const [commandStr] = splitArgs(commandWithArgs);
  assertAtBuildtime(commandStr !== undefined);

  print.error(`Usage: /${commandStr}`);
  return true;
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

// https://stackoverflow.com/a/33500118
export const mutedStdout = new Writable({
  write(
    out: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    // The main purpose of this is to prevent keypresses from appearing to stdout
    // TODO: is there a cleaner way?
    if (shouldMuteStdout()) return callback();

    processDeps.stdout.write(out);
    callback();
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
    actions.terminal.appendBufferedInputWhileInitializing(char);
  });
}

export function initStdout() {
  if (stdout.isTTY) {
    stdout.on("resize", () => {
      mutedStdout.emit("resize");
    });
  }
}

function abortRlQuestionForEditorIfActive(editorContent: string) {
  const abortController = getState().abortControllers.question;
  if (abortController !== null) {
    const rl = clearRlLine();
    assertAtBuildtime(rl !== null);

    const truncatedFirstLine = truncate(
      editorContent,
      getState().config.promptPrefix.length,
    );
    rl.write(truncatedFirstLine);
    actions.terminal.appendStdoutTail(truncatedFirstLine);

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
    const executeUserInput = getState().abortControllers.executeUserInput;

    const controllers = [
      apiStream,
      interruptWithEditorContent,
      question,
      transcription,
      executeUserInput,
    ];
    assertAtBuildtime(controllers.filter((c) => c !== null).length <= 1);

    if (executeUserInput !== null) {
      executeUserInput.abort();
      return;
    }

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

export function clearRlLine(): readline.Interface | null {
  const rl = getState().terminal.rl;
  assertAtBuildtime(rl !== null);
  rl.write(null, { ctrl: true, name: "e" });
  rl.write(null, { ctrl: true, name: "u" });
  return rl;
}
async function reload(reloadState: () => Promise<void>) {
  resetConfigMessages();

  const beforeFiles = await Promise.all(
    reloadTempFilePrefixes.map((prefix) =>
      getTempFileName({
        pathPrefix: `lasso-${prefix}-before`,
        initialContentStr: getReloadTempFileStr()[prefix],
      }),
    ),
  );

  await reloadState();

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
      continue;
    }

    const afterFile = afterFiles[i];
    if (afterFile === null || afterFile === undefined) {
      await tryCatchAsync(fsDeps.unlink(beforeFile));
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
  printLargeContextOverheadWarning();
  printMissingConfigWarnings();
}

async function resolveBuiltinSlashCommand(
  commandWithArgs: string,
  reloadState: () => Promise<void>,
): Promise<SlashCommandOutcome> {
  const [commandStr] = splitArgs(commandWithArgs);
  assertAtBuildtime(commandStr !== undefined);

  const command = commandStr as BuiltinSlashCommand;
  switch (command) {
    case "edit": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      actions.terminal.setIsNonBlockingProcessOngoing(true);
      const content = await spawnAndReadEditorContent();
      actions.terminal.setIsNonBlockingProcessOngoing(false);

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
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      await pageEditStr({ isTyped: true });
      return { handled: true, inputFromCommand: null };
    }
    case "paste": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      actions.terminal.setIsNonBlockingProcessOngoing(true);
      const content = await spawnAndReadEditorContent({
        includeClipboardSuffix: true,
      });
      actions.terminal.setIsNonBlockingProcessOngoing(false);

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
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      await clearCommand();
      return { handled: true, inputFromCommand: null };
    }
    case "history": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      await pageHistory({ isTyped: true });
      return { handled: true, inputFromCommand: null };
    }
    case "skills": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      await pageSkills();
      return { handled: true, inputFromCommand: null };
    }
    case "context": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      await pageContext();
      return { handled: true, inputFromCommand: null };
    }
    case "commands": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      await pageCommands();
      return { handled: true, inputFromCommand: null };
    }
    case "keymaps": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      printKeymaps();
      return { handled: true, inputFromCommand: null };
    }
    case "usage": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      printUsage();
      return { handled: true, inputFromCommand: null };
    }
    case "tokens": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      printTokens();
      return { handled: true, inputFromCommand: null };
    }
    case "config": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      const initialContentStr = getAllPrettyConfig();
      await openWithPager({
        initialContentStr,
        contentType: "markdown",
      });

      return { handled: true, inputFromCommand: null };
    }
    case "resume": {
      const inputFromCommand = hasArgs(commandWithArgs)
        ? await resume(commandWithArgs)
        : await resumeWithNoArgs();

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
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      await reload(reloadState);
      return { handled: true, inputFromCommand: null };
    }
    case "initlocal": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      await initLocalConfig();
      return { handled: true, inputFromCommand: null };
    }
    case "initglobal": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      await initGlobalConfig();
      return { handled: true, inputFromCommand: null };
    }
    case "lastresponse": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      await pageLastResponse({ isTyped: true });
      return { handled: true, inputFromCommand: null };
    }
    case "lastmessage": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      await pageLastMessage({ isTyped: true });
      return { handled: true, inputFromCommand: null };
    }
    case "lastdiff": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      await pageLastDiff({ isTyped: true });
      return { handled: true, inputFromCommand: null };
    }
    case "summaries": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      await pageSummaries({ isTyped: true });
      return { handled: true, inputFromCommand: null };
    }
    case "tools": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      await pageTools();
      return { handled: true, inputFromCommand: null };
    }
    case "mcps": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      printMcps();
      return { handled: true, inputFromCommand: null };
    }
    case "steer": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }
      steerCommand({ isTyped: true });
      return { handled: true, inputFromCommand: null };
    }
    case "record": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

      actions.terminal.setIsRecording(true);
      const inputFromCommand = await recordAndTranscribeInput({
        isTyped: true,
      });
      actions.terminal.setIsRecording(false);

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

async function resolveSlashCommand(
  reloadState: () => Promise<void>,
  rawInput: string,
) {
  const commandWithoutSlash = rawInput.trim().slice(1);
  const builtinSlashCommandOutcome = await resolveBuiltinSlashCommand(
    commandWithoutSlash,
    reloadState,
  );
  if (builtinSlashCommandOutcome.handled) {
    return builtinSlashCommandOutcome.inputFromCommand;
  }

  const customSlashCommandOutcome =
    resolveCustomSlashCommand(commandWithoutSlash);
  if (customSlashCommandOutcome.handled) {
    return customSlashCommandOutcome.inputFromCommand;
  }

  await pageForInvalidCommand(rawInput);
  return null;
}

function typeCommand(rl: readline.Interface, command: string) {
  const output = `/${command}\n`;
  rl.write(output);
  actions.terminal.appendStdoutTail(output);
}

// Reprints the readline prompt line and any half-typed input after pager
// commands so the pending question and its input stay visible and editable
function redrawPendingQuestion(rl: readline.Interface) {
  if (getState().abortControllers.question === null) return;
  rl.prompt(true);
  actions.terminal.appendStdoutTail(getState().config.promptPrefix);
}

function initKeypress(
  {
    reloadState,
    onExitRequested,
  }: {
    reloadState: () => Promise<void>;
    onExitRequested: () => Promise<void>;
  },
  rl: readline.Interface,
) {
  stdin.on("keypress", (_char, key: Key) => {
    void (async () => {
      if (key.ctrl === true && key.name === "d") {
        await onExitRequested();
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
              redrawPendingQuestion(rl);
            } else {
              abortRlQuestionForEditorIfActive(editorContent);
            }

            return;
          }
          case "record": {
            if (getState().abortControllers.question !== null) {
              typeCommand(rl, command);
              return;
            }

            actions.terminal.setIsRecording(true);
            const transcriptionInput = await wrapToOpenNonBlockingProcess(
              recordAndTranscribeInput,
              { pauseStdin: false }, // rl.question needs stdin to receive Enter and stop recording.
            );
            actions.terminal.setIsRecording(false);

            if (transcriptionInput === null) return;

            const { editorInputValue } = getState().terminal;
            if (editorInputValue === null) {
              actions.terminal.appendEditorInputValue(transcriptionInput);
            } else {
              actions.terminal.appendEditorInputValue(
                `\n${getState().config.messageQueueDelimiter}${transcriptionInput}`,
              );
            }
            return;
          }
          case "editpage": {
            await pageEditStr();
            redrawPendingQuestion(rl);
            return;
          }
          case "paste": {
            const editorContent = await wrapToOpenNonBlockingProcess(() =>
              spawnAndReadEditorContent({ includeClipboardSuffix: true }),
            );

            if (editorContent === null) {
              redrawPendingQuestion(rl);
            } else {
              abortRlQuestionForEditorIfActive(editorContent);
            }
            return;
          }
          case "history": {
            await pageHistory();
            redrawPendingQuestion(rl);
            return;
          }
          case "config": {
            const initialContentStr = getAllPrettyConfig();

            await openWithPager({
              initialContentStr,
              contentType: "markdown",
            });
            redrawPendingQuestion(rl);

            return;
          }
          case "lastresponse": {
            await pageLastResponse();
            redrawPendingQuestion(rl);
            return;
          }
          case "lastmessage": {
            await pageLastMessage();
            redrawPendingQuestion(rl);
            return;
          }
          case "lastdiff": {
            await pageLastDiff();
            redrawPendingQuestion(rl);
            return;
          }
          case "summaries": {
            await pageSummaries();
            redrawPendingQuestion(rl);
            return;
          }
          case "reload": {
            await reload(reloadState);
            redrawPendingQuestion(rl);
            return;
          }
          case "commands": {
            await pageCommands();
            redrawPendingQuestion(rl);
            return;
          }
          case "tools": {
            await pageTools();
            redrawPendingQuestion(rl);
            return;
          }
          case "skills": {
            await pageSkills();
            redrawPendingQuestion(rl);
            return;
          }
          case "context": {
            await pageContext();
            redrawPendingQuestion(rl);
            return;
          }
          case "mcps": {
            printMcps();
            redrawPendingQuestion(rl);
            return;
          }
          case "steer": {
            steerCommand();
            redrawPendingQuestion(rl);
            return;
          }
          case "initlocal":
          case "initglobal":
          case "keymaps":
          case "usage":
          case "tokens":
          case "resume":
          case "clear": {
            if (getState().abortControllers.question !== null) {
              typeCommand(rl, command);
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
          typeCommand(rl, slashCommand.name);
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

export function createCommands({
  reloadState,
  onExitRequested,
}: {
  reloadState: () => Promise<void>;
  onExitRequested: () => Promise<void>;
}) {
  return {
    resolveSlashCommand: resolveSlashCommand.bind(undefined, reloadState),
    initKeypress: initKeypress.bind(undefined, {
      reloadState,
      onExitRequested,
    }),
  };
}
