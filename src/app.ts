import os from "node:os";
import { join, dirname, basename, extname } from "node:path";
import readline from "node:readline/promises";
import { once } from "node:events";
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import {
  type AssistantContent,
  Output,
  type ModelMessage as AiModelMessage,
  type LanguageModelUsage,
  type Tool,
  tool,
} from "ai";
import { z } from "zod";
import * as YAML from "yaml";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogle } from "@ai-sdk/google";
// eslint-disable-next-line import/no-unresolved
import { Experimental_StdioMCPTransport as StdioClientTransport } from "@ai-sdk/mcp/mcp-stdio";
import { format } from "prettier";
import {
  assertAtBuildtime,
  isAbortError,
  getTimeoutError,
  tryCatchAsync,
  getMessageFromError,
  safeStringify,
  strToApproxTokens,
  formatTokenCountAside,
  formatTokenRangeAside,
  markdownFence,
  removeMediaReplacer,
  orApproxTokens,
  assertAtRuntime,
  approxTokensToCharLen,
  tryCatch,
  normalizeNewline,
  getShortId,
  shellQuote,
  isShellSafePath,
  stringify,
  isExisty,
  getMaxColLength,
  createLockUtils,
  shouldDisableColor,
  decimalToPercent,
  getDurationColor,
  getPrettyDuration,
  type Color,
  bold,
  wrapInColor,
  parseFrontMatter,
  getLockQueue,
  getPrettyMoney,
  isReadlineClosedError,
  isNullish,
  getPrettyDate,
  sleep,
  writeDebugLog,
} from "./utils.ts";
import {
  actions,
  getState,
  type ContextEntry,
  type MCPClients,
  type MCPToolSet,
  type Skill,
  type SlashCommand,
} from "./state.ts";
import {
  aiDeps,
  childProcessDeps,
  fsDeps,
  mcpDeps,
  processDeps,
} from "./deps.ts";
import {
  getDebugLogDir,
  getGlobalConfigPath,
  getGlobalContextDir,
  getGlobalSkillDir,
  getGlobalSlashCommandDir,
  getLocalConfigPath,
  getLocalSkillDir,
  getLocalSlashCommandDir,
  getSessionDir,
  getUsageLogLockPath,
  getUsageLogPath,
  getWebpagesDir,
} from "./paths.ts";
import {
  getBaseAgentPrompt,
  getConversationSummaryPrompt,
  getMergeSummariesPrompt,
  getSubagentPrompt,
} from "./prompts.ts";
import {
  bashToolInputSchema,
  createSubagentSafeTools,
  loadSkillToolSchema,
  mcpListResourcesSchema,
  mcpReadResourceSchema,
  mcpResourceTools,
  readImageSchema,
  timeoutSettings,
  webFetchToolSchema,
  type ToolResult,
} from "./tools.ts";
import {
  ModelUsageSchema,
  filterExpiredModelUsage,
  getUsageMoneyForModel,
  sumUsageTokens,
  type ModelUsage,
} from "./usage.ts";
import {
  MISSING,
  dedicatedSummaryRatio,
  maxTokenCountPerSummary,
  ConfigSchema,
  SessionFileSchema,
  defaultConfig,
  isSameKey,
  type Config,
  type Key,
  type Mcp,
  type ModelMessage,
  type ModelSummary,
  type SessionFile,
  type TranscriptEntry,
} from "./schemas.ts";

const interruptContent = "[Interrupted before a response was generated]";

export function getUnicodeChar(char: string) {
  const map = {
    ["┊"]: "|",
    ["…"]: "~",
    ["━"]: "=",
  };
  assertAtRuntime(char in map);
  const replacement = map[char as keyof typeof map];
  if (getState().config.asciiOnly) return replacement;
  return char;
}

export function truncate(str: string, padding = 0) {
  const maxLen = Math.max(1, getMaxColLength() - padding);
  const newlineIdx = str.indexOf("\n");
  const ellipsis = getUnicodeChar("…");

  const firstLine = (() => {
    if (newlineIdx === -1) return str;
    return str.substring(0, newlineIdx);
  })();

  if (newlineIdx !== -1) {
    return firstLine.substring(0, maxLen - 1).concat(ellipsis);
  }

  if (str.length <= maxLen) {
    return firstLine;
  }

  return firstLine.substring(0, maxLen - 1).concat(ellipsis);
}

export function getApproxTokensFromMessages(messages: ModelMessage[]) {
  return strToApproxTokens(JSON.stringify(messages, removeMediaReplacer));
}

interface SessionFileInfo {
  absolutePath: string;
  timestampMs: number;
}

export async function listSessionFiles() {
  const sessionDir = getSessionDir();
  const sessionDirExistsResult = tryCatch(() => fsDeps.existsSync(sessionDir));
  if (!sessionDirExistsResult.ok) {
    print.error(
      `Failed to check if ${sessionDir} exists. Error: ${getMessageFromError(sessionDirExistsResult.error)}`,
    );
    return [];
  }
  if (!sessionDirExistsResult.value) return [];

  const sessionFiles: SessionFileInfo[] = [];
  const readdirResult = await tryCatchAsync(fsDeps.readdir(sessionDir));
  if (!readdirResult.ok) {
    print.error(
      `Failed to read ${sessionDir}. Error: ${getMessageFromError(readdirResult.error)}`,
    );
    return [];
  }
  for (const name of readdirResult.value) {
    const fullPath = join(sessionDir, name);
    const statResult = await tryCatchAsync(fsDeps.stat(fullPath));
    if (!statResult.ok) continue;
    if (!statResult.value.isFile()) continue;

    const fileName = basename(name, extname(name));
    const parts = fileName.split("-");
    if (parts.length !== 2) continue;
    if (parts[0] !== "session") continue;

    const timestampMs = Number(parts[1]);
    if (Number.isNaN(timestampMs)) continue;

    if (extname(name) !== ".json") continue;

    sessionFiles.push({
      absolutePath: fullPath,
      timestampMs,
    });
  }
  return sessionFiles;
}

interface AppendNewlineOpts {
  appendNewline?: boolean;
  whileMuted?: boolean;
}

export const print = {
  doing: (text: string, opts: AppendNewlineOpts = {}) =>
    colorPrint(text, "blue", opts),
  error: (text: string, opts: AppendNewlineOpts = {}) =>
    colorPrint(text, "red", opts),
  info: (text: string, opts: AppendNewlineOpts = {}) =>
    colorPrint(text, "purple", opts),
  infoSubtle: (text: string, opts: AppendNewlineOpts = {}) =>
    colorPrint(text, "grey", opts),
  warning: (text: string, opts: AppendNewlineOpts = {}) =>
    colorPrint(text, "yellow", opts),
  plain: (text: string, opts: AppendNewlineOpts = {}) =>
    colorPrint(text, "none", opts),
};

export function colorPrint(
  text: string,
  color: Color,
  opts: AppendNewlineOpts = {},
) {
  const out = (() => {
    const suffix = opts.appendNewline === false ? "" : "\n";
    if (color === "none" || shouldDisableColor()) {
      return `${text}${suffix}`;
    }
    return `${wrapInColor(text, color)}${suffix}`;
  })();

  if (opts.whileMuted === true) {
    processDeps.stdout.write(out);
    return;
  }

  const { isNonBlockingProcessOngoing } = getState().terminal;
  if (isNonBlockingProcessOngoing) {
    actions.appendBufferedStdoutWhileEditorOpen(out);
    actions.appendStdoutTail(out);
    return;
  }

  const wasSpinnerActive = getState().terminal.loadingStateTimeout !== null;
  stopLoadingState();
  processDeps.stdout.write(out);
  if (wasSpinnerActive) startLoadingState();
  actions.appendStdoutTail(out);
}

export function createPerformanceLogger({
  logDuration,
}: {
  logDuration: boolean;
}) {
  let startTime: bigint | null = null;
  function start(label: string) {
    if (!logDuration) return;
    assertAtRuntime(startTime === null);
    startTime = process.hrtime.bigint();
    print.doing(label, { appendNewline: false });
  }

  function end() {
    if (!logDuration) return;
    assertAtRuntime(startTime !== null);
    const endTime = process.hrtime.bigint();
    const duration = getPrettyDuration(startTime, endTime, {
      includeMicroseconds: true,
    });
    colorPrint(duration, getDurationColor(startTime, endTime));
    startTime = null;
  }

  return { start, end };
}

export type ParallelPerformanceLogger = ReturnType<
  typeof createParallelPerformanceLogger
>;

export type LogIdToLabel = [logId: string, label: string][];

export function createParallelPerformanceLogger({
  logDuration,
  logIdToLabel,
}: {
  logDuration: boolean;
  logIdToLabel: LogIdToLabel;
}) {
  const startTimeByLogId = new Map<string, bigint>();
  const labels = logIdToLabel.map(([, label]) => label);

  function printAllLabels() {
    if (!logDuration) return;
    for (const labelContent of labels) {
      print.doing(labelContent);
    }
  }

  function start(logId: string) {
    if (!logDuration) return;
    startTimeByLogId.set(logId, process.hrtime.bigint());
  }

  function end(logId: string) {
    if (!logDuration) return;
    const startTime = startTimeByLogId.get(logId);
    assertAtRuntime(startTime !== undefined);
    const endTime = process.hrtime.bigint();
    const duration = getPrettyDuration(startTime, endTime, {
      includeMicroseconds: true,
    });
    const labelEntry = logIdToLabel.find(([id]) => id === logId);
    assertAtBuildtime(labelEntry !== undefined);
    const labelIndex = logIdToLabel.indexOf(labelEntry);
    const linesUp = labels.length - labelIndex;
    const label = labelEntry[1];
    processDeps.stdout.write(`\x1b[${String(linesUp)}A\x1b[2K\r`);
    print.doing(label, { appendNewline: false });
    colorPrint(duration, getDurationColor(startTime, endTime), {
      appendNewline: false,
    });
    processDeps.stdout.write(`\x1b[${String(linesUp)}B\r`);
  }

  return { printAllLabels, start, end };
}

export function printNewline() {
  if (getState().terminal.stdoutTail.endsWith("\n\n")) return;
  colorPrint("", "none");
}

export function successWithSpacing(cb: () => void) {
  printNewline();
  cb();
  printNewline();
}

export function errorWithSpacing(cb: () => void) {
  cb();
  printNewline();
}

export function startLoadingState() {
  if (getState().terminal.isNonBlockingProcessOngoing) return;

  writeLoadingStateFrame();
  const timeout = setInterval(() => {
    writeLoadingStateFrame();
  }, getState().config.loadingStateFrameDuration);
  actions.setLoadingStateTimeout(timeout);
}

function writeLoadingStateFrame() {
  const { loadingStateFrames } = getState().config;
  processDeps.stdout.write(
    `\r${String(loadingStateFrames[getState().terminal.loadingStateFrameIdx % loadingStateFrames.length])}`,
  );
  actions.incrementLoadingStateFrameIdx();
}

export function stopLoadingState() {
  const { loadingStateTimeout } = getState().terminal;
  if (loadingStateTimeout === null) return;

  clearInterval(loadingStateTimeout);
  actions.setLoadingStateTimeout(null);

  processDeps.stdout.write(
    `\r${" ".repeat(getState().config.loadingStateFrames[0]?.length ?? 0)}\r`,
  );
  actions.resetLoadingStateFrameIdx();
}

export function printSessionStartDate() {
  print.info(
    `Resume this session with /resume ${String(getState().session.sessionStartDate)}`,
  );
}

export function getSystemContent() {
  return [
    getBaseAgentPrompt(getState().mcp.clients),
    getState().content.contextStr,
    getState().content.skillsStr,
  ].join("\n\n");
}

export function getToolsContentStr() {
  return stringifyTools();
}

export const contextFileSkillNamePrefix = "__lasso-context-for";

export function getContextFilesStr(contextEntries: ContextEntry[]) {
  if (contextEntries.length === 0) return "";

  const contextFilesList = contextEntries
    .map(
      (entry) => `## Path: ${entry.filePath}

${normalizeNewline(entry.content)}`,
    )
    .join("\n\n");

  return `# [lasso] AGENTS.md context files

${contextFilesList}`;
}

export async function getContextEntries() {
  const agentFileDirs: string[] = [processDeps.cwd(), getGlobalContextDir()];

  const entries: ContextEntry[] = [];

  for (const agentFileDir of agentFileDirs) {
    const filePath = join(agentFileDir, "AGENTS.md");
    const filePathExistsResult = tryCatch(() => fsDeps.existsSync(filePath));
    if (!filePathExistsResult.ok) {
      print.error(
        `Failed to check if ${filePath} exists. Error: ${getMessageFromError(filePathExistsResult.error)}`,
      );
      continue;
    }
    if (!filePathExistsResult.value) continue;
    const readResult = await tryCatchAsync(fsDeps.readFile(filePath, "utf8"));
    if (!readResult.ok) {
      actions.appendConfigWarningMessage(
        `Failed to read the agent file at \`${filePath}\`, ignoring. Error: ${getMessageFromError(readResult.error, { forceSingleLine: true })}`,
      );
      continue;
    }
    entries.push({ filePath, content: readResult.value });
  }

  return entries;
}

const skillMetadataSchema = z.object({
  name: z.string(),
  description: z.string(),
});

export type SkillMetadata = z.infer<typeof skillMetadataSchema>;

export function getSkillsStr(skills: Skill[]) {
  if (skills.length === 0) return "";

  const skillsFormatted = skills
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join("\n");

  return `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

${skillsFormatted}`;
}

export async function getSkills() {
  const seenSkills = new Set<string>();
  const skillGrandparentDirs = [
    ...getState().config.customSkillDirs,
    getLocalSkillDir(),
    getGlobalSkillDir(),
  ];
  const skills: Skill[] = [];
  const skillPaths: string[] = [];

  for (const skillGrandparentDir of skillGrandparentDirs) {
    const glob = join(skillGrandparentDir, "**/SKILL.md");
    const globResult = await tryCatchAsync(fsDeps.glob(glob));
    if (!globResult.ok) {
      actions.appendConfigWarningMessage(
        `Failed to list the skill files in \`${skillGrandparentDir}\`, ignoring. Error: ${getMessageFromError(globResult.error, { forceSingleLine: true })}`,
      );
      continue;
    }
    skillPaths.push(...globResult.value);
  }

  for (const skillPath of skillPaths) {
    const skill = await getSkillJSON(skillPath);
    if (skill === null) continue;

    if (seenSkills.has(skill.name)) continue;
    seenSkills.add(skill.name);
    skills.push(skill);
  }

  const agentFileGlobResult = await tryCatchAsync(
    fsDeps.gitLsFiles("**/AGENTS.md"),
  );
  if (!agentFileGlobResult.ok) {
    actions.appendConfigWarningMessage(
      `Failed to list the agent files with git, ignoring. Error: ${getMessageFromError(agentFileGlobResult.error, { forceSingleLine: true })}`,
    );
    return skills;
  }

  for (const agentFilePath of agentFileGlobResult.value) {
    const isRootAgentsMd = agentFilePath === "AGENTS.md";
    if (isRootAgentsMd) continue;
    const readResult = await tryCatchAsync(
      fsDeps.readFile(agentFilePath, "utf8"),
    );
    if (!readResult.ok) {
      actions.appendConfigWarningMessage(
        `Failed to read the agent file at \`${agentFilePath}\`, ignoring. Error: ${getMessageFromError(readResult.error, { forceSingleLine: true })}`,
      );
      continue;
    }
    const dir = dirname(agentFilePath);

    const skill: Skill = {
      content: readResult.value,
      description: `Context relevant for ${dir}`,
      dir,
      name: `${contextFileSkillNamePrefix}-${dir}`,
    };
    skills.push(skill);
  }

  return skills;
}

export async function getSkillJSON(skillMdPath: string) {
  const readResult = await tryCatchAsync(fsDeps.readFile(skillMdPath, "utf8"));
  if (!readResult.ok) {
    actions.appendConfigWarningMessage(
      `Failed to read the skill at ${skillMdPath}, ignoring. Error: ${getMessageFromError(readResult.error)}`,
    );
    return null;
  }

  const parsed = parseFrontMatter(readResult.value);
  if (parsed === null) {
    actions.appendConfigWarningMessage(
      `Malformed skill at ${skillMdPath}! A skill's front matter must contain valid YAML between \`---\` and \`---\`.`,
    );
    return null;
  }
  const parseResult = skillMetadataSchema.safeParse(parsed.data);
  if (!parseResult.success) {
    actions.appendConfigWarningMessage(
      `Malformed skill at ${skillMdPath}! A skill's front matter must contain a \`name\` and \`description\` field.`,
    );
    return null;
  }

  const skill: Skill = {
    content: parsed.body,
    dir: dirname(skillMdPath),
    name: parseResult.data.name,
    description: parseResult.data.description,
  };
  return skill;
}

export const compactTriggerRatio = 0.95;

export const dedicatedPromptOverheadRatio =
  compactTriggerRatio - dedicatedSummaryRatio;

export const defaultContextWindow = 128_000;

export const maxCharCountPerSummary = approxTokensToCharLen(
  maxTokenCountPerSummary,
);

export function getMaxNumberSummaries() {
  const { model } = getState().config;
  const contextWindow =
    getState().config.contextWindowPerModel[model] ?? defaultContextWindow;
  const allSummariesTokenCount = dedicatedSummaryRatio * contextWindow;
  return Math.floor(allSummariesTokenCount / maxTokenCountPerSummary);
}

const ModelUsageMapSchema = z.record(z.string(), z.array(ModelUsageSchema));

export async function appendModelUsage(
  usage: LanguageModelUsage,
  model = getState().config.model,
) {
  const now = Date.now();

  const defaultedUsage: ModelUsage = {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens ?? 0,
    date: now,
  };

  await syncNewModelUsageForLimitWindow(model, defaultedUsage);
  actions.appendToModelUsageForSession(defaultedUsage, model);
}

export function isUsageLimitDisabled(model = getState().config.model) {
  const { usageLimit, pricingPerModel } = getState().config;
  const pricing = pricingPerModel[model];

  return pricing === undefined || usageLimit === undefined;
}

export function getExpiredTime() {
  const { usageLimit } = getState().config;
  assertAtBuildtime(usageLimit !== undefined);

  const now = Date.now();
  const msPerDuration = {
    s: 1_000,
    m: 1_000 * 60,
    h: 1_000 * 60 * 60,
    d: 1_000 * 60 * 60 * 24,
  };
  const durationSuffix = usageLimit.duration.slice(
    -1,
  ) as keyof typeof msPerDuration;
  const durationPrefix = Number(usageLimit.duration.slice(0, -1));
  const duration = durationPrefix * msPerDuration[durationSuffix];
  const expiredTime = now - duration;
  return expiredTime;
}

export async function syncInitialModelUsageForLimitWindow() {
  if (isUsageLimitDisabled()) return;

  const { usageLimit } = getState().config;
  assertAtBuildtime(usageLimit !== undefined);
  const expiredTime = getExpiredTime();

  const path = getUsageLogPath();
  const dir = dirname(path);
  const dirExistsResult = tryCatch(() => fsDeps.existsSync(dir));
  if (!dirExistsResult.ok) {
    print.error(
      `Failed to check if ${dir} exists. Error: ${getMessageFromError(dirExistsResult.error)}`,
    );
    return;
  }
  if (!dirExistsResult.value) return;

  await getLockQueue(getUsageLogLockPath()).enqueue(async () => {
    const lockUtils = createLockUtils(getUsageLogLockPath());
    const created = await lockUtils.createLock();
    if (!created) {
      return print.error(
        `Failed to acquire a lock for ${getUsageLogLockPath()}`,
      );
    }

    const pathExistsResult = tryCatch(() => fsDeps.existsSync(path));
    if (!pathExistsResult.ok) {
      print.error(
        `Failed to check if ${path} exists. Error: ${getMessageFromError(pathExistsResult.error)}`,
      );
      await lockUtils.deleteLock();
      return;
    }
    if (!pathExistsResult.value) {
      await tryCatchAsync(fsDeps.writeFile(path, JSON.stringify({})));
      await lockUtils.deleteLock();
      return;
    }

    const readResult = await tryCatchAsync(fsDeps.readFile(path, "utf8"));
    if (!readResult.ok) {
      print.error(
        `Failed to read the usage log at ${path}. Error: ${getMessageFromError(readResult.error)}`,
      );
      await tryCatchAsync(fsDeps.writeFile(path, JSON.stringify({})));
      await lockUtils.deleteLock();
      return;
    }

    const parseResult = tryCatch(() =>
      ModelUsageMapSchema.parse(JSON.parse(readResult.value)),
    );
    if (!parseResult.ok) {
      print.error(
        `Failed to parse the usage log at ${path}. Error: ${getMessageFromError(parseResult.error)}`,
      );
      await tryCatchAsync(fsDeps.writeFile(path, JSON.stringify({})));
      await lockUtils.deleteLock();
      return;
    }
    const filtered = filterExpiredModelUsage(parseResult.value, expiredTime);

    await tryCatchAsync(fsDeps.writeFile(path, JSON.stringify(filtered)));

    await lockUtils.deleteLock();
    actions.setModelUsageForLimitWindow(filtered);
  });
}

export async function syncNewModelUsageForLimitWindow(
  model: string,
  usage: ModelUsage,
) {
  if (isUsageLimitDisabled(model)) return;

  const expiredTime = getExpiredTime();

  const path = getUsageLogPath();
  const dir = dirname(path);
  const dirExistsResult = tryCatch(() => fsDeps.existsSync(dir));
  if (!dirExistsResult.ok) {
    print.error(
      `Failed to check if ${dir} exists. Error: ${getMessageFromError(dirExistsResult.error)}`,
    );
    return;
  }
  if (!dirExistsResult.value) {
    const mkDirResult = await tryCatchAsync(
      fsDeps.mkdir(dir, { recursive: true }),
    );
    if (!mkDirResult.ok) {
      print.error(`Failed to create the directory: ${dir}`);
      return;
    }
  }

  await getLockQueue(getUsageLogLockPath()).enqueue(async () => {
    const lockUtils = createLockUtils(getUsageLogLockPath());
    const created = await lockUtils.createLock();
    if (!created) {
      return print.error(
        `Failed to acquire a lock for ${getUsageLogLockPath()}`,
      );
    }

    const loggedModelUsage = await (async () => {
      const pathExistsResult = tryCatch(() => fsDeps.existsSync(path));
      if (!pathExistsResult.ok) {
        print.error(
          `Failed to check if ${path} exists. Error: ${getMessageFromError(pathExistsResult.error)}`,
        );
        return {};
      }
      if (!pathExistsResult.value) return {};

      const readResult = await tryCatchAsync(fsDeps.readFile(path, "utf8"));
      if (!readResult.ok) {
        print.error(
          `Failed to read the usage log at ${path}. Error: ${getMessageFromError(readResult.error)}`,
        );
        return {};
      }
      const parseResult = tryCatch(() =>
        ModelUsageMapSchema.parse(JSON.parse(readResult.value)),
      );
      if (parseResult.ok) return parseResult.value;
      print.error(
        `Failed to parse the usage log at ${path}. Error: ${getMessageFromError(parseResult.error)}`,
      );
      return {};
    })();
    (loggedModelUsage[model] ??= []).push(usage);

    const filtered = filterExpiredModelUsage(loggedModelUsage, expiredTime);

    await tryCatchAsync(fsDeps.writeFile(path, JSON.stringify(filtered)));
    await lockUtils.deleteLock();

    actions.setModelUsageForLimitWindow(filtered);
  });
}

export function getPromptOverheadTokensApprox() {
  const systemContentTokensApprox = strToApproxTokens(getSystemContent());
  const toolsTokensApprox = strToApproxTokens(stringifyTools());
  return systemContentTokensApprox + toolsTokensApprox;
}

export function printLargeContextOverheadWarning() {
  const { model } = getState().config;
  const contextWindow =
    getState().config.contextWindowPerModel[model] ?? defaultContextWindow;

  const promptOverheadTokensApprox = getPromptOverheadTokensApprox();

  const promptOverheadRatio = promptOverheadTokensApprox / contextWindow;
  if (promptOverheadRatio >= dedicatedPromptOverheadRatio) {
    print.warning(
      `The current set of context, skills, and tools is ${decimalToPercent(promptOverheadRatio)} of the ${contextWindow.toLocaleString()} token context window!

Lasso reserves ${decimalToPercent(dedicatedSummaryRatio)} of the context window for compacted summaries with the assumption that at most ${decimalToPercent(dedicatedPromptOverheadRatio)} of the context window will be used for prompt overhead. As is, the prompt overhead is large enough to break this assumption and, along with any user messages, may breach the llm's context window and cause API calls to be rejected. Consider converting some of your context to skills and minimizing MCP servers.`,
    );
  }
}

export function getApproxPromptTokens() {
  return (
    getApproxTokensFromMessages(getState().conversation.messages) +
    getPromptOverheadTokensApprox()
  );
}

export function getCurrentPromptTokens() {
  if (getState().usage.promptTokens.dirty) {
    return getApproxPromptTokens();
  }
  return getState().usage.promptTokens.value;
}

interface TokensByArea {
  messages: number;
  tools: number;
  context: number;
  basePrompt: number;
  skills: number;
}

type TokenArea = keyof TokensByArea;

const tokenAreaToPrettyName: Record<TokenArea, string> = {
  basePrompt: "Base system prompt",
  context: "Context files",
  messages: "Chat messages",
  skills: "Skill descriptions",
  tools: "Harness and MCP tools",
};

export function getPrettyTokensByArea() {
  const tokensByArea = getTokensByArea();
  const lines = (Object.keys(tokensByArea) as TokenArea[]).map(
    (area) =>
      `- ${tokenAreaToPrettyName[area]}: ${Math.round(tokensByArea[area]).toLocaleString()}`,
  );
  return lines.join("\n");
}

export function getTokensByArea(): TokensByArea {
  const tokensByAreaApprox: TokensByArea = {
    messages: getApproxTokensFromMessages(getState().conversation.messages),
    context: strToApproxTokens(getState().content.contextStr),
    tools: strToApproxTokens(stringifyTools()),
    basePrompt: strToApproxTokens(getBaseAgentPrompt(getState().mcp.clients)),
    skills: strToApproxTokens(getState().content.skillsStr),
  };

  if (getState().usage.promptTokens.dirty) {
    return tokensByAreaApprox;
  }

  const realTokens = getState().usage.promptTokens.value;
  const approxTotal = getApproxPromptTokens();
  if (realTokens === 0 || approxTotal === 0) {
    return tokensByAreaApprox;
  }

  const realToApproxRatio = realTokens / approxTotal;
  const realTokensByArea = { ...tokensByAreaApprox };
  for (const area of Object.keys(realTokensByArea) as TokenArea[]) {
    realTokensByArea[area] = realTokensByArea[area] * realToApproxRatio;
  }
  return realTokensByArea;
}

export function getPrettyTokenUsage() {
  const { model } = getState().config;
  const pricing = getState().config.pricingPerModel[model];
  const tokenUsageForSession = sumUsageTokens(
    getState().usage.modelUsageForSession[model] ?? [],
  );

  if (pricing === undefined) {
    return `${(tokenUsageForSession.inputTokens + tokenUsageForSession.outputTokens).toLocaleString()} tokens in session`;
  }

  const tokenUsageForLimitWindow = sumUsageTokens(
    getState().usage.modelUsageForLimitWindow[model] ?? [],
  );

  const costForSession = getUsageMoneyForModel(tokenUsageForSession, pricing);
  const { usageLimit } = getState().config;

  if (isUsageLimitDisabled()) {
    return `$${getPrettyMoney(costForSession)} in session`;
  }

  assertAtBuildtime(usageLimit !== undefined);
  const costForLimitWindow = getUsageMoneyForModel(
    tokenUsageForLimitWindow,
    pricing,
  );
  return `$${getPrettyMoney(costForSession)} in session, $${getPrettyMoney(costForLimitWindow)} of $${String(usageLimit.dollarAmount)} limit`;
}

export function getPrettyContextWindowUsage() {
  const { model } = getState().config;
  const contextWindow =
    getState().config.contextWindowPerModel[model] ?? defaultContextWindow;

  const currTokens = getCurrentPromptTokens();

  const currRatio = currTokens / contextWindow;
  return `${decimalToPercent(currRatio, { precision: 3 })} of context window`;
}

interface FencePrintOpts {
  showSessionInfo?: boolean;
  color?: Color;
}

export function wrapInFence(text: string) {
  const fence = getUnicodeChar("━").repeat(2);
  return `${fence} ${text} ${fence}`;
}

function getFenceSessionLine(text: string) {
  const fenceCharsLen = 6;
  const availCol = getMaxColLength();

  let accumulatedCol = fenceCharsLen;
  let sessionInfo = "";

  const fittedHeader = truncate(text, fenceCharsLen);

  sessionInfo += bold(fittedHeader);
  accumulatedCol += fittedHeader.length;

  const prettyApiDurationInfo = ` (${getPrettyApiDuration()})`;
  if (accumulatedCol + prettyApiDurationInfo.length > availCol) {
    return sessionInfo;
  }
  sessionInfo += prettyApiDurationInfo;
  accumulatedCol += prettyApiDurationInfo.length;

  const prettyTokenUsage = ` (${getPrettyTokenUsage()})`;
  if (accumulatedCol + prettyTokenUsage.length > availCol) {
    return sessionInfo;
  }
  sessionInfo += prettyTokenUsage;
  accumulatedCol += prettyTokenUsage.length;

  const prettyContextWindowUsage = ` (${getPrettyContextWindowUsage()})`;
  if (accumulatedCol + prettyContextWindowUsage.length > availCol) {
    return sessionInfo;
  }
  sessionInfo += prettyContextWindowUsage;
  accumulatedCol += prettyContextWindowUsage.length;

  return sessionInfo;
}

export function fencePrint(text: string, opts: FencePrintOpts = {}) {
  const showSessionInfo = opts.showSessionInfo ?? false;

  const line = (() => {
    const fenceCharsLen = 6;
    if (!showSessionInfo) {
      return wrapInFence(bold(truncate(text, fenceCharsLen)));
    }
    return wrapInFence(getFenceSessionLine(text));
  })();

  colorPrint(line, opts.color ?? "grey");
}

export function getPrettyApiDuration({
  includeMicroseconds = false,
}: { includeMicroseconds?: boolean } = {}) {
  const startTime = getState().usage.apiStartTime;
  assertAtRuntime(startTime !== null);
  const endTime = getState().usage.apiEndTime;
  assertAtRuntime(endTime !== null);

  return getPrettyDuration(startTime, endTime, { includeMicroseconds });
}

export function isToolCallDiffSafePath(path: string) {
  return !path.startsWith(os.tmpdir());
}

export function createToolCallDiffer() {
  type ToolCallId = string;
  type FilePath = string;
  type TempFilePath = string;
  const toolCallIdsMap = new Map<ToolCallId, Map<FilePath, TempFilePath>>();

  async function setTempFiles(toolCallId: string, paths: string[]) {
    const filePathToTempFileBefore = new Map<FilePath, TempFilePath>();

    const pathsToSnapshot = Array.from(new Set(paths)).filter(
      isToolCallDiffSafePath,
    );
    const promises = pathsToSnapshot.map(async (path) => {
      const tempFile = await getTempFileName({ initialContentPath: path });
      if (tempFile === null) return;
      filePathToTempFileBefore.set(path, tempFile);
    });
    await Promise.all(promises);

    if (filePathToTempFileBefore.size > 0) {
      toolCallIdsMap.set(toolCallId, filePathToTempFileBefore);
    }
  }

  async function diffAndCleanup(toolCallId: string, paths: string[]) {
    const tempFilesBefore = toolCallIdsMap.get(toolCallId);
    if (tempFilesBefore === undefined) return;
    const pathsToDiff = Array.from(new Set(paths)).filter(
      isToolCallDiffSafePath,
    );

    const promises = pathsToDiff.map(async (path) => {
      const tempFileAfterPath = await getTempFileName({
        initialContentPath: path,
      });
      if (tempFileAfterPath === null) return;

      const tempFileBeforePath = tempFilesBefore.get(path);
      if (tempFileBeforePath === undefined) {
        await tryCatchAsync(fsDeps.unlink(tempFileAfterPath));
        return;
      }

      const diffResult = await tryCatchAsync(
        execGitDiff({
          tempFileBeforePath,
          tempFileAfterPath,
        }),
      );

      if (!diffResult.ok) {
        print.error(
          `An error occurred when getting the diff for ${path}: ${getMessageFromError(diffResult.error)}`,
        );
        await tryCatchAsync(fsDeps.unlink(tempFileAfterPath));
        return;
      }

      if (diffResult.value.stdout.length > 0) {
        actions.appendToolEditDiff({
          fileName: path,
          diffStdout: diffResult.value.stdout,
        });

        if (!getState().config.suppressToolEditDiffs) {
          printNewline();
          fencePrint(`File change: ${path}`);
          print.plain(normalizeNewline(diffResult.value.stdout));
          printNewline();
        }
      }

      await tryCatchAsync(fsDeps.unlink(tempFileAfterPath));
    });
    await Promise.all(promises);
    await cleanupToolCallIdTempFiles(toolCallId);
  }

  async function cleanupToolCallIdTempFiles(toolCallId: string) {
    const tempFiles = toolCallIdsMap.get(toolCallId);
    if (tempFiles === undefined) return;

    const promises = tempFiles
      .values()
      .map((tempFile) => tryCatchAsync(fsDeps.unlink(tempFile)));
    await Promise.all(promises);
    toolCallIdsMap.delete(toolCallId);
  }

  async function cleanupAllTempFiles() {
    const promises = toolCallIdsMap
      .values()
      .flatMap((tempFiles) =>
        tempFiles
          .values()
          .map((tempFile) => tryCatchAsync(fsDeps.unlink(tempFile))),
      );
    await Promise.all(promises);
    toolCallIdsMap.clear();
  }

  return {
    toolCallIdsMap,
    setTempFiles,
    diffAndCleanup,
    cleanupToolCallIdTempFiles,
    cleanupAllTempFiles,
  };
}
export function getHeaders() {
  const headers: Record<string, string> = {};
  if (getState().config.gateway === "opencode") {
    headers["x-opencode-session"] = getState().session.sessionId;
    headers["x-opencode-client"] = "lasso";
  }
  return headers;
}

export function getLanguageModel(model = getState().config.model) {
  const apiKey = processDeps.env.get("LASSO_API_KEY");
  const sdkProvider = getState().config.sdkProvider;

  assertAtBuildtime(apiKey !== undefined);
  assertAtBuildtime(sdkProvider !== MISSING);

  const baseURL = getState().config.baseURL;
  const headers = getHeaders();

  switch (sdkProvider) {
    case "openai-compatible": {
      assertAtBuildtime(baseURL !== undefined);
      return createOpenAICompatible({
        apiKey,
        baseURL,
        name: "openai-compatible",
        headers,
      }).chatModel(model);
    }
    case "anthropic": {
      return createAnthropic({
        apiKey,
        headers,
        ...(baseURL === undefined ? {} : { baseURL }),
      })(model);
    }
    case "openai": {
      return createOpenAI({
        apiKey,
        headers,
        ...(baseURL === undefined ? {} : { baseURL }),
      })(model);
    }
    case "google": {
      return createGoogle({
        apiKey,
        headers,
        ...(baseURL === undefined ? {} : { baseURL }),
      })(model);
    }
    default: {
      sdkProvider satisfies never;
      throw new Error("Unhandled sdkProvider");
    }
  }
}

export function getTranscriptionProvider() {
  const apiKey = processDeps.env.get("LASSO_TRANSCRIPTION_API_KEY");
  assertAtBuildtime(apiKey !== undefined);

  const { transcriptionBaseURL, transcriptionSdkProvider } = getState().config;
  assertAtBuildtime(transcriptionSdkProvider !== undefined);

  switch (transcriptionSdkProvider) {
    case "openai": {
      return createOpenAI({
        apiKey,
        ...(transcriptionBaseURL === undefined
          ? {}
          : { baseURL: transcriptionBaseURL }),
      });
    }
    case "google": {
      return createGoogle({
        apiKey,
        ...(transcriptionBaseURL === undefined
          ? {}
          : { baseURL: transcriptionBaseURL }),
      });
    }
    default: {
      transcriptionSdkProvider satisfies never;
      throw new Error("Unhandled transcriptionSdkProvider");
    }
  }
}

export function debugLog(content: string) {
  void writeDebugLog(
    getState().debug.debugLog,
    getState().debug.debugLogPath,
    content,
  );
}

export function getAppendedConversationMessages(...messages: ModelMessage[]) {
  return [...getState().conversation.messages, ...messages];
}

export function getAppendedTranscript(...transcriptEntries: TranscriptEntry[]) {
  return [...getState().conversation.transcript, ...transcriptEntries];
}

export async function syncSessionFile({
  messages = getState().conversation.messages,
  summaries = getState().conversation.summaries,
  transcript = getState().conversation.transcript,
}: {
  messages?: ModelMessage[];
  summaries?: ModelSummary[];
  transcript?: TranscriptEntry[];
} = {}) {
  const sessionFilePath = getState().session.sessionFilePath;
  const sessionDir = getSessionDir();
  const sessionDirExistsResult = tryCatch(() => fsDeps.existsSync(sessionDir));
  if (!sessionDirExistsResult.ok) {
    print.error(
      `Failed to check if ${sessionDir} exists. Error: ${getMessageFromError(sessionDirExistsResult.error)}`,
    );
    return;
  }
  if (!sessionDirExistsResult.value) {
    const mkdirResult = await tryCatchAsync(
      fsDeps.mkdir(sessionDir, { recursive: true }),
    );
    if (!mkdirResult.ok) {
      print.error(`Failed to create the directory: ${sessionDir}`);
      return;
    }
  }

  const next: SessionFile = {
    messages,
    summaries,
    transcript,
  };

  actions.setConversationMessages(messages);
  actions.setConversationSummaries(summaries);
  actions.setTranscript(transcript);

  const stringifyResult = tryCatch(() => JSON.stringify(next));
  if (!stringifyResult.ok) {
    print.error("Failed to stringify the session file");
    return;
  }

  const writeResult = await tryCatchAsync(
    fsDeps.writeFile(sessionFilePath, stringifyResult.value),
  );
  if (!writeResult.ok) {
    print.error(`Failed to write the session file to ${sessionFilePath}`);
    return;
  }
}

export async function resumeFromSessionFile(sessionFilePath: string) {
  const readResult = await tryCatchAsync(
    fsDeps.readFile(sessionFilePath, "utf8"),
  );
  if (!readResult.ok) {
    errorWithSpacing(() => {
      print.error(`Failed to read the session file at ${sessionFilePath}`);
    });
    return false;
  }

  const jsonResult = tryCatch((): unknown => JSON.parse(readResult.value));
  if (!jsonResult.ok) {
    errorWithSpacing(() => {
      print.error(`Failed to parse the session file at ${sessionFilePath}`);
    });
    return false;
  }

  const parseResult = tryCatch(() => SessionFileSchema.parse(jsonResult.value));
  if (!parseResult.ok) {
    errorWithSpacing(() => {
      print.error(`Failed to validate the session file at ${sessionFilePath}`);
    });
    return false;
  }
  const { messages, summaries, transcript } = parseResult.value;
  actions.setTranscript(transcript);
  actions.setConversationSummaries(summaries);
  actions.setConversationMessages(messages);
  actions.setPromptTokensDirty(true);
  return true;
}

export function initSessionFile() {
  const sessionDir = getSessionDir();
  const sessionFilePath = join(
    sessionDir,
    `session-${getState().session.sessionStartDate.toString()}.json`,
  );
  actions.setSessionFilePath(sessionFilePath);
}

export async function deleteExpiredSessionFiles() {
  const sessionFiles = await listSessionFiles();

  for (const { absolutePath, timestampMs } of sessionFiles) {
    const oneDay = 1_000 * 60 * 60 * 24;
    if (timestampMs + oneDay < getState().session.sessionStartDate) {
      await tryCatchAsync(fsDeps.unlink(absolutePath));
    }
  }
}

export async function deleteExpiredWebpageFiles() {
  const webpagesDir = getWebpagesDir();
  const webpagesDirExistsResult = tryCatch(() =>
    fsDeps.existsSync(webpagesDir),
  );
  if (!webpagesDirExistsResult.ok) {
    print.error(
      `Failed to check if ${webpagesDir} exists. Error: ${getMessageFromError(webpagesDirExistsResult.error)}`,
    );
    return;
  }
  if (!webpagesDirExistsResult.value) return;

  interface WebpageFileInfo {
    absolutePath: string;
    timestampMs: number;
  }

  const webpageFiles: WebpageFileInfo[] = [];
  const readdirResult = await tryCatchAsync(fsDeps.readdir(webpagesDir));
  if (!readdirResult.ok) {
    print.error(
      `Failed to read ${webpagesDir}. Error: ${getMessageFromError(readdirResult.error)}`,
    );
    return;
  }
  for (const name of readdirResult.value) {
    const fullPath = join(webpagesDir, name);
    const statResult = await tryCatchAsync(fsDeps.stat(fullPath));
    if (!statResult.ok) continue;
    if (!statResult.value.isFile()) continue;

    const fileName = basename(name, extname(name));
    const parts = fileName.split("-");
    const lastPart = parts.at(-1);
    if (lastPart === undefined) continue;

    const timestampMs = Number(lastPart);
    if (Number.isNaN(timestampMs)) continue;

    if (extname(name) !== ".md") continue;

    webpageFiles.push({
      absolutePath: fullPath,
      timestampMs,
    });
  }

  for (const { absolutePath, timestampMs } of webpageFiles) {
    const oneDay = 1_000 * 60 * 60 * 24;
    if (timestampMs + oneDay < getState().session.sessionStartDate) {
      await tryCatchAsync(fsDeps.unlink(absolutePath));
    }
  }
}

async function createMcpClient(config: Mcp) {
  switch (config.type) {
    case "http":
    case "sse": {
      const headers = (() => {
        if (config.headers === undefined) return {};
        return { headers: config.headers };
      })();

      return mcpDeps.createMCPClient({
        transport: {
          type: config.type,
          url: config.url,
          ...headers,
          protocolVersion: config.protocolVersion,
          redirect: "error",
        },
      });
    }
    case "stdio": {
      const args = (() => {
        if (config.args === undefined) return {};
        return { args: config.args };
      })();

      return mcpDeps.createMCPClient({
        transport: new StdioClientTransport({
          command: config.command,
          ...args,
          stderr: "pipe",
        }),
      });
    }
    default: {
      config satisfies never;
      throw new Error("Unsupported MCP configuration");
    }
  }
}

async function getMcpClients({
  performanceLogger,
}: {
  performanceLogger: ParallelPerformanceLogger;
}) {
  const mcpClients: MCPClients = {};

  const serverEntries = Object.entries(getState().config.mcps);
  await Promise.all(
    serverEntries.map(async ([name, config]) => {
      performanceLogger.start(name);
      const createMcpResult = await tryCatchAsync(createMcpClient(config));
      performanceLogger.end(name);
      if (createMcpResult.ok) {
        mcpClients[name] = createMcpResult.value;
      } else {
        actions.appendConfigWarningMessage(
          `Failed to start the ${name} mcp server, ignoring. Error: ${getMessageFromError(createMcpResult.error, { forceSingleLine: true })}`,
        );
      }
    }),
  );

  return mcpClients;
}

export async function initMcpState({
  performanceLogger,
}: {
  performanceLogger: ParallelPerformanceLogger;
}) {
  const state = getState();

  await state.mcp.close();
  const clients = await getMcpClients({
    performanceLogger,
  });
  const toolSetsPromise = Promise.all(
    Object.entries(clients).map(async ([name, client]) => {
      const toolsPromise = await tryCatchAsync(client.tools());
      if (toolsPromise.ok) {
        return toolsPromise.value;
      } else {
        actions.appendConfigWarningMessage(
          `Failed to import the tools for the \`${name}\` mcp server, ignoring. Error: ${getMessageFromError(toolsPromise.error, { forceSingleLine: true })}`,
        );
        return null;
      }
    }),
  );
  const toolSetsResult = (await toolSetsPromise).filter(
    (toolSet) => toolSet !== null,
  );
  const tools = Object.assign({}, ...toolSetsResult) as MCPToolSet;
  actions.setMcp(clients, tools);
}

export interface GetTempFileNameArgs {
  pathPrefix?: string | undefined;
  initialContentPath?: string | undefined;
  initialContentStr?: string | undefined;
  extension?: string;
}

export async function getTempFileName(args?: GetTempFileNameArgs) {
  const { pathPrefix, initialContentPath, initialContentStr, extension } =
    args ?? {};
  assertAtRuntime(
    initialContentPath === undefined || initialContentStr === undefined,
  );

  const tempFile = join(
    os.tmpdir(),
    `${pathPrefix ?? "lasso"}-${getShortId()}.${extension ?? "txt"}`,
  );

  assertAtRuntime(isShellSafePath(tempFile));

  if (initialContentPath !== undefined) {
    const existsResult = tryCatch(() => fsDeps.existsSync(initialContentPath));
    if (!existsResult.ok) {
      print.error(
        `Failed to create a temp file with content from path ${initialContentPath}. Error: ${getMessageFromError(existsResult.error)}`,
      );
      return null;
    }
    if (!existsResult.value) {
      const writeResult = await tryCatchAsync(fsDeps.writeFile(tempFile, ""));
      if (!writeResult.ok) {
        print.error(
          `Failed to write an empty temp file. Error: ${getMessageFromError(writeResult.error)}`,
        );
        return null;
      }
      return tempFile;
    }

    const readResult = await tryCatchAsync(
      fsDeps.readFile(initialContentPath, "utf8"),
    );
    if (!readResult.ok) {
      print.error(
        `Failed to read the content from path ${initialContentPath} to prepopulate a temp file. Error: ${getMessageFromError(readResult.error)}`,
      );
      return null;
    }

    const writeResult = await tryCatchAsync(
      fsDeps.writeFile(tempFile, readResult.value),
    );
    if (!writeResult.ok) {
      print.error(
        `Failed to write a temp file with the content from path ${initialContentPath}: ${getMessageFromError(writeResult.error)}`,
      );
      return null;
    }

    return tempFile;
  }

  if (initialContentStr !== undefined) {
    const writeResult = await tryCatchAsync(
      fsDeps.writeFile(tempFile, initialContentStr),
    );
    if (!writeResult.ok) {
      print.error(
        `Failed to write to a temp file. Error: ${getMessageFromError(writeResult.error)}`,
      );
      return null;
    }
    return tempFile;
  }

  const writeResult = await tryCatchAsync(fsDeps.writeFile(tempFile, ""));
  if (!writeResult.ok) {
    print.error(
      `Failed to create an empty temp file. Error: ${getMessageFromError(writeResult.error)}`,
    );
    return null;
  }
  return tempFile;
}

export async function formatMarkdown(content: string): Promise<string> {
  const formatResult = await tryCatchAsync(
    format(content, { parser: "markdown" }),
  );
  if (formatResult.ok) return formatResult.value;
  print.error(
    `Outputting raw content, markdown formatting failed: ${getMessageFromError(formatResult.error)}`,
  );
  return content;
}

export async function executeBat(content: string) {
  content = await formatMarkdown(content);
  content = normalizeNewline(content);
  if (!getState().content.batAvailable) {
    return print.plain(content);
  }

  function fallbackPrint(message: string) {
    print.error(message);
    print.plain(content);
  }
  const baseMessage =
    "Falling back to plain text rendering, an error occurred when spawning `bat`: ";
  const batResult = spawnBat(content);
  if (!batResult.ok) {
    return fallbackPrint(
      baseMessage.concat(getMessageFromError(batResult.error)),
    );
  }
  if (batResult.value.status !== null && batResult.value.status !== 0) {
    return fallbackPrint(
      baseMessage.concat(
        `\`bat\` returned code ${String(batResult.value.status)}`,
      ),
    );
  }
  if (batResult.value.stderr.length !== 0) {
    return fallbackPrint(baseMessage.concat(batResult.value.stderr));
  }
  print.plain(batResult.value.stdout);
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

  childProcessDeps.spawnSync(pagerCommand, {
    shell: true,
    stdio: "inherit",
  });
  await tryCatchAsync(fsDeps.unlink(tempFile));
}

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
      actions.appendConfigWarningMessage(
        `Failed to list the slash command files in \`${dir}\`, ignoring. Error: ${getMessageFromError(globResult.error, { forceSingleLine: true })}`,
      );
      continue;
    }
    slashCommandFilePaths.push(...globResult.value);
  }

  for (const filePath of slashCommandFilePaths) {
    const readResult = await tryCatchAsync(fsDeps.readFile(filePath, "utf8"));
    if (!readResult.ok) {
      actions.appendConfigWarningMessage(
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

export function toolPrint(
  label: string,
  detail: string,
  { maxLines = 5 }: { maxLines?: number } = {},
) {
  const detailArr = detail.split("\n").filter((str) => str.length > 0);
  const colonSpaceLen = 2;
  const labelLen = label.length + colonSpaceLen;
  const indent = " ".repeat(7).concat(getUnicodeChar("┊"));
  const lines = [];

  let detailIdx = 0;
  let strIdx = 0;
  while (lines.length < maxLines && detailIdx < detailArr.length) {
    const detailLine = detailArr[detailIdx];
    assertAtBuildtime(detailLine !== undefined);

    let maxLen = (() => {
      if (lines.length === 0) return getMaxColLength() - labelLen;
      return getMaxColLength() - indent.length;
    })();
    maxLen = Math.max(1, maxLen);

    const splitStr = detailLine.slice(strIdx, strIdx + maxLen);
    strIdx += splitStr.length;
    if (strIdx >= detailLine.length) {
      detailIdx++;
      strIdx = 0;
    }

    const prefix = (() => {
      if (lines.length === 0) return `${bold(label)}: `;
      return indent;
    })();

    lines.push(prefix.concat(splitStr));
  }

  const overflow = lines.length === maxLines && detailIdx < detailArr.length;

  if (overflow) {
    const lastLine = lines.pop();
    assertAtBuildtime(lastLine !== undefined);

    const ellipsis = getUnicodeChar("…");
    const newLastLine = (() => {
      if (lastLine.length >= getMaxColLength()) {
        return lastLine.slice(0, -1).concat(ellipsis);
      } else {
        return lastLine.concat(ellipsis);
      }
    })();
    lines.push(newLastLine);
  }

  const linesStr = lines.join("\n");

  print.doing(linesStr);
}

export type ToolPrint = typeof toolPrint;

export const createSubagentTaskSchema = z.object({
  prompt: z
    .string()
    .describe("The prompt describing the task for the subagent"),
  access: z
    .enum(["read-only", "read-write"])
    .describe(
      "Whether the subagent may make changes (read-write) or only investigate (read-only)",
    ),
  model: z
    .string()
    .min(1)
    .describe("The model the subagent runs on")
    .superRefine((value, ctx) => {
      const configuredModels = getState().config.subagentModels;
      const allowedModels = (() => {
        if (configuredModels.length > 0) return configuredModels;
        return [getState().config.model];
      })();

      if (!allowedModels.includes(value)) {
        ctx.addIssue({
          code: "custom",
          message: `Invalid model: ${value}`,
        });
      }
    }),
});

export const createSubagentToolSchema = z.object({
  tasks: z
    .array(createSubagentTaskSchema)
    .describe("The independent subagent tasks to run in parallel"),
});

export type CreateSubagentTool = z.infer<typeof createSubagentToolSchema>;

export type CreateSubagentTask = z.infer<typeof createSubagentTaskSchema>;

export async function createSubagentTool(
  { tasks }: CreateSubagentTool,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const subagentPromises = tasks.map(
    async (subagentSchema): Promise<ToolResult> => {
      const model = subagentSchema.model;

      const systemContent = [
        getSubagentPrompt(subagentSchema.access, getState().mcp.clients),
        getState().content.contextStr,
        getState().content.skillsStr,
      ]
        .filter((content) => content.length > 0)
        .join("\n\n");

      const toolCallDiffer = createToolCallDiffer();

      const userMessage: AiModelMessage = {
        role: "user",
        content: subagentSchema.prompt,
      };

      const generateTextResult = await tryCatchAsync(
        aiDeps.generateText({
          // Subagents should always use the provider's default reasoning
          model: getLanguageModel(model),
          instructions: systemContent,
          messages: [userMessage],
          tools: {
            ...subagentSafeTools,
            ...mcpResourceTools,
            ...getState().mcp.tools,
          },
          stopWhen: aiDeps.isLoopFinished(),
          ...(signal === undefined ? {} : { abortSignal: signal }),
          timeout: timeoutSettings,
          onToolExecutionStart: async ({ toolCall }) => {
            if (subagentSchema.access !== "read-write") return;
            if (toolCall.toolName !== "bash") return;

            const bashSchemaResult = bashToolInputSchema.parse(toolCall.input);
            if (
              bashSchemaResult.fileSystemAccessType === "create-update-delete"
            ) {
              await toolCallDiffer.setTempFiles(
                toolCall.toolCallId,
                bashSchemaResult.filePaths,
              );
            }
          },
          onToolExecutionEnd: async ({ toolCall, toolOutput }) => {
            if (subagentSchema.access !== "read-write") return;
            if (toolCall.toolName !== "bash") return;
            const success = toolOutput.type === "tool-result";

            const bashSchemaResult = bashToolInputSchema.parse(toolCall.input);

            if (
              bashSchemaResult.fileSystemAccessType === "create-update-delete"
            ) {
              if (!success) {
                await toolCallDiffer.cleanupToolCallIdTempFiles(
                  toolCall.toolCallId,
                );
                return;
              }
              await toolCallDiffer.diffAndCleanup(
                toolCall.toolCallId,
                bashSchemaResult.filePaths,
              );
            }
          },
        }),
      );

      if (!generateTextResult.ok) {
        await toolCallDiffer.cleanupAllTempFiles();

        const timeoutError = getTimeoutError(signal);
        if (isAbortError(generateTextResult.error)) {
          if (timeoutError !== null) {
            return {
              isError: true,
              content: getMessageFromError(timeoutError),
            };
          }
          throw generateTextResult.error;
        }
        return {
          content: getMessageFromError(generateTextResult.error),
          isError: true,
        };
      }

      const { usage, text } = generateTextResult.value;
      await appendModelUsage(usage, model);
      await toolCallDiffer.cleanupAllTempFiles();

      return {
        content: text,
        isError: false,
      };
    },
  );

  const results = await Promise.allSettled(subagentPromises);

  const abortResult = results.find(
    (result) => result.status === "rejected" && isAbortError(result.reason),
  );
  if (abortResult !== undefined) {
    throw (abortResult as PromiseRejectedResult).reason;
  }

  return {
    isError: results.some(
      (result) => result.status === "rejected" || result.value.isError,
    ),
    content: stringify(
      results.map((result) => {
        if (result.status === "rejected") {
          const ret: ToolResult = {
            isError: true,
            content: getMessageFromError(result.reason),
          };
          return ret;
        }
        return result.value;
      }),
    ),
  };
}

const subagentSafeTools = createSubagentSafeTools({
  toolPrint,
  printDoing: (text) => print.doing(text),
});

const baseAgentTools = {
  create_subagent: tool({
    description:
      "Launch parallel subagents for independent investigation or implementation. Prefer read-only subagents for parallel work to avoid conflicts. Read-only subagents can fetch web content, inspect files, and load skills; read-write subagents can modify files or execute commands.",
    inputSchema: createSubagentToolSchema,
    execute: (args, opts) => createSubagentTool(args, opts.abortSignal),
  }),
};

export const harnessTools = {
  ...subagentSafeTools,
  ...mcpResourceTools,
  ...baseAgentTools,
};

export function getBaseAgentTools() {
  return { ...harnessTools, ...getState().mcp.tools };
}

export function stringifyTools() {
  return safeStringify(getBaseAgentTools());
}

export async function readConfigFileStr(path: string) {
  const pathExistsResult = tryCatch(() => fsDeps.existsSync(path));
  if (!pathExistsResult.ok) {
    print.error(
      `Failed to check if ${path} exists. Error: ${getMessageFromError(pathExistsResult.error)}`,
    );
    return "{}";
  }
  if (!pathExistsResult.value) return "{}";

  const readResult = await tryCatchAsync(fsDeps.readFile(path, "utf8"));
  if (!readResult.ok) {
    actions.appendConfigWarningMessage(
      `Failed to read the config file at \`${path}\`, using the default config. Error: ${getMessageFromError(readResult.error, { forceSingleLine: true })}`,
    );
    return "{}";
  }

  return readResult.value;
}

export function parseConfigFileStr(
  configFileStr: string,
  path: string,
): Partial<Config> {
  const parseResult = tryCatch((): unknown => YAML.parse(configFileStr));
  if (!parseResult.ok) {
    actions.appendConfigErrorMessage(
      `Invalid YAML in \`${path}\`, using the default config. Error: ${getMessageFromError(parseResult.error, { forceSingleLine: true })}`,
    );
    return {};
  }

  const configResult = ConfigSchema.safeParse(parseResult.value);
  if (configResult.success) return configResult.data;
  actions.appendConfigErrorMessage(
    `Failed to validate \`${path}\`, using the default config. Error: ${getMessageFromError(configResult.error, { forceSingleLine: true })}`,
  );
  return {};
}

export function printMissingConfigWarnings() {
  if (getState().config.suppressConfigWarnings) return;

  const messages = getState().content.configWarningMessages;
  if (messages.length === 0) return;

  printNewline();
  print.warning("Warnings:");
  print.warning(messages.map((message) => `- ${message}`).join("\n"));
  printNewline();
  print.warning(
    `Suppress these warnings via the \`suppressConfigWarnings\` config option`,
  );
  printNewline();
}

export function printMissingConfigErrors() {
  const messages = getState().content.configErrorMessages;
  if (messages.length === 0) return false;

  printNewline();
  print.error("Errors:");
  print.error(messages.map((message) => `- ${message}`).join("\n"));
  if (getState().content.includeConfigInitMessage) {
    printNewline();
    print.error(
      "Run /initlocal or /initglobal to generate a sample config in `./.lasso` or `~/.config/lasso` respectively, then /reload to apply it to the current session.",
    );
  }
  printNewline();
  return true;
}

function filterNulls<T>(entries: Record<string, T | null>): Record<string, T> {
  const filtered: Record<string, T> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === null) continue;
    filtered[key] = value;
  }
  return filtered;
}

export function initStateFromConfig({
  localConfig,
  globalConfig,
}: {
  localConfig: Partial<Config>;
  globalConfig: Partial<Config>;
}) {
  const defaultedModel =
    localConfig.model ?? globalConfig.model ?? defaultConfig.model;

  const defaultedSdkProvider =
    localConfig.sdkProvider ??
    globalConfig.sdkProvider ??
    defaultConfig.sdkProvider;
  const defaultedGateway =
    localConfig.gateway ?? globalConfig.gateway ?? defaultConfig.gateway;
  const defaultedBaseURL = localConfig.baseURL ?? globalConfig.baseURL;

  const defaultedTranscriptionSdkProvider =
    localConfig.transcriptionSdkProvider ??
    globalConfig.transcriptionSdkProvider ??
    defaultConfig.transcriptionSdkProvider;
  const defaultedTranscriptionModel =
    localConfig.transcriptionModel ??
    globalConfig.transcriptionModel ??
    defaultConfig.transcriptionModel;
  const defaultedTranscriptionBaseURL =
    localConfig.transcriptionBaseURL ?? globalConfig.transcriptionBaseURL;

  if (
    defaultedBaseURL === undefined &&
    defaultedSdkProvider === "openai-compatible"
  ) {
    actions.appendConfigErrorMessage(
      `A \`baseURL\` is required when \`sdkProvider\` is \`openai-compatible\``,
    );
  }

  actions.setModel(defaultedModel);
  if (defaultedBaseURL !== undefined) actions.setBaseURL(defaultedBaseURL);
  actions.setSdkProvider(defaultedSdkProvider);
  actions.setGateway(defaultedGateway);
  if (defaultedTranscriptionSdkProvider !== undefined) {
    actions.setTranscriptionSdkProvider(defaultedTranscriptionSdkProvider);
  }
  if (defaultedTranscriptionModel !== undefined) {
    actions.setTranscriptionModel(defaultedTranscriptionModel);
  }
  if (defaultedTranscriptionBaseURL !== undefined) {
    actions.setTranscriptionBaseURL(defaultedTranscriptionBaseURL);
  }

  const defaultedPricingPerModel = filterNulls({
    ...defaultConfig.pricingPerModel,
    ...globalConfig.pricingPerModel,
    ...localConfig.pricingPerModel,
  });
  actions.setPricingPerModel(defaultedPricingPerModel);
  const defaultedContextWindowPerModel = filterNulls({
    ...defaultConfig.contextWindowPerModel,
    ...globalConfig.contextWindowPerModel,
    ...localConfig.contextWindowPerModel,
  });
  actions.setContextWindowPerModel(defaultedContextWindowPerModel);
  actions.setCustomSlashCommandDirs(
    localConfig.customSlashCommandDirs ??
      globalConfig.customSlashCommandDirs ??
      defaultConfig.customSlashCommandDirs,
  );
  actions.setCustomSkillDirs(
    localConfig.customSkillDirs ??
      globalConfig.customSkillDirs ??
      defaultConfig.customSkillDirs,
  );
  actions.setSubagentModels(
    localConfig.subagentModels ??
      globalConfig.subagentModels ??
      defaultConfig.subagentModels,
  );
  const defaultedKeymaps = {
    ...defaultConfig.keymaps,
    ...globalConfig.keymaps,
    ...localConfig.keymaps,
  };
  const keyedCommands = Object.entries(defaultedKeymaps);
  for (const [i, [commandA, keymapA]] of keyedCommands.entries()) {
    for (const [commandB, keymapB] of keyedCommands.slice(i + 1)) {
      if (!isSameKey(keymapA, keymapB)) continue;
      actions.appendConfigErrorMessage(
        `\`keymaps\` must be unique: \`${commandA}\` and \`${commandB}\` are both bound to \`${stringify(keymapA)}\``,
      );
    }
  }

  actions.setKeymaps(defaultedKeymaps);
  actions.setLoadingStateFrames(
    localConfig.loadingStateFrames ??
      globalConfig.loadingStateFrames ??
      defaultConfig.loadingStateFrames,
  );
  actions.setLoadingStateFrameDuration(
    localConfig.loadingStateFrameDuration ??
      globalConfig.loadingStateFrameDuration ??
      defaultConfig.loadingStateFrameDuration,
  );
  actions.setPromptPrefix(
    localConfig.promptPrefix ??
      globalConfig.promptPrefix ??
      defaultConfig.promptPrefix,
  );
  actions.setSuppressConfigWarnings(
    localConfig.suppressConfigWarnings ??
      globalConfig.suppressConfigWarnings ??
      defaultConfig.suppressConfigWarnings,
  );
  actions.setSuppressToolEditDiffs(
    localConfig.suppressToolEditDiffs ??
      globalConfig.suppressToolEditDiffs ??
      defaultConfig.suppressToolEditDiffs,
  );
  actions.setAsciiOnly(
    localConfig.asciiOnly ?? globalConfig.asciiOnly ?? defaultConfig.asciiOnly,
  );
  actions.setCompactWithStructuredOutput(
    localConfig.compactWithStructuredOutput ??
      globalConfig.compactWithStructuredOutput ??
      defaultConfig.compactWithStructuredOutput,
  );
  actions.setMessageQueueDelimiter(
    localConfig.messageQueueDelimiter ??
      globalConfig.messageQueueDelimiter ??
      defaultConfig.messageQueueDelimiter,
  );
  actions.setReasoning(
    localConfig.reasoning ?? globalConfig.reasoning ?? defaultConfig.reasoning,
  );
  const defaultedMcps = {
    ...defaultConfig.mcps,
    ...globalConfig.mcps,
    ...localConfig.mcps,
  };
  actions.setMcps(defaultedMcps);

  const defaultedUsageLimit = localConfig.usageLimit ?? globalConfig.usageLimit;

  if (
    defaultedUsageLimit !== undefined &&
    defaultedPricingPerModel[defaultedModel] === undefined
  ) {
    actions.appendConfigWarningMessage(
      `Usage limit is disabled because there is no \`pricingPerModel\` entry for the current model \`${defaultedModel}\``,
    );
  }

  if (defaultedContextWindowPerModel[defaultedModel] === undefined) {
    actions.appendConfigWarningMessage(
      `A default context window of 128,000 tokens is used because there is no \`contextWindowPerModel\` entry for the current model \`${defaultedModel}\``,
    );
  }

  actions.setUsageLimit(defaultedUsageLimit);

  let includeConfigCommand = false;
  if (getState().config.sdkProvider === MISSING) {
    includeConfigCommand = true;
    actions.appendConfigErrorMessage(
      "Set `sdkProvider` in your config file (`openai-compatible` or `anthropic`)",
    );
  }

  if (getState().config.model === MISSING) {
    includeConfigCommand = true;
    actions.appendConfigErrorMessage("Set `model` in your config file");
  }
  actions.setIncludeConfigInitMessage(includeConfigCommand);

  if (processDeps.env.get("LASSO_API_KEY") === undefined) {
    actions.appendConfigErrorMessage(
      "Set the `LASSO_API_KEY` environment variable, e.g. `export LASSO_API_KEY=...`",
    );
  }
}

export async function initStateFromFs({
  performanceLogger,
}: {
  performanceLogger: ParallelPerformanceLogger;
}) {
  await syncInitialModelUsageForLimitWindow();

  performanceLogger.start("context");
  const contextEntries = await getContextEntries();
  actions.setContextEntries(contextEntries);
  actions.setContextStr(getContextFilesStr(contextEntries));
  performanceLogger.end("context");

  performanceLogger.start("skills");
  const skills = await getSkills();
  actions.setSkills(skills);
  actions.setSkillsStr(getSkillsStr(skills));
  performanceLogger.end("skills");

  performanceLogger.start("commands");
  const slashCommands = await getAvailableSlashCommands();
  actions.setSlashCommands(slashCommands);
  performanceLogger.end("commands");
}

export async function initStateFirst() {
  actions.setDebugLog(processDeps.env.get("DEBUG") === "1");

  const globalConfigStr = await readConfigFileStr(getGlobalConfigPath());
  const globalConfig = parseConfigFileStr(
    globalConfigStr,
    getGlobalConfigPath(),
  );
  actions.setGlobalConfigStr(globalConfigStr);

  const localConfigStr = await readConfigFileStr(getLocalConfigPath());
  const localConfig = parseConfigFileStr(localConfigStr, getLocalConfigPath());
  actions.setLocalConfigStr(localConfigStr);

  actions.setSuppressStartupDurations(
    localConfig.suppressStartupDurations ??
      globalConfig.suppressStartupDurations ??
      defaultConfig.suppressStartupDurations,
  );

  return { globalConfig, localConfig };
}

export async function initStateRepeatable() {
  const { globalConfig, localConfig } = await initStateFirst();
  initStateFromConfig({ globalConfig, localConfig });

  const performanceLogger = createParallelPerformanceLogger({
    logDuration: !getState().config.suppressStartupDurations,
    logIdToLabel: getStartupLogIdToLabel(),
  });
  performanceLogger.printAllLabels();

  initSessionFile();

  await Promise.all([
    initMcpState({ performanceLogger }),
    initStateFromFs({ performanceLogger }),
  ]);
}

export function getMcpLogIdToLabel(): LogIdToLabel {
  const serverEntries = Object.entries(getState().config.mcps);
  return serverEntries.map(([name]) => [name, `Starting ${name} mcp server: `]);
}

export function getStartupLogIdToLabel(): LogIdToLabel {
  return getMcpLogIdToLabel().concat([
    ["context", "Reading context files: "],
    ["skills", "Reading skills: "],
    ["commands", "Reading slash commands: "],
  ]);
}

export async function initBatAvailable() {
  const batResult = await tryCatchAsync(childProcessDeps.exec("bat --version"));
  actions.setBatAvailable(batResult.ok);
  if (!batResult.ok) {
    actions.appendConfigWarningMessage(
      `\`bat\` is not available; consider installing it to properly render markdown responses`,
    );
  }
}

export async function initState() {
  const { globalConfig, localConfig } = await initStateFirst();
  const debugLogPath = join(getDebugLogDir(), `debug-${getShortId()}.log`);
  actions.setDebugLogPath(debugLogPath);

  initStateFromConfig({ globalConfig, localConfig });

  const performanceLogger = createParallelPerformanceLogger({
    logDuration: !getState().config.suppressStartupDurations,
    logIdToLabel: getStartupLogIdToLabel(),
  });
  performanceLogger.printAllLabels();

  initSessionFile();

  await Promise.all([
    initMcpState({ performanceLogger }),
    initStateFromFs({ performanceLogger }),
    deleteExpiredSessionFiles(),
    deleteExpiredWebpageFiles(),
    initBatAvailable(),
  ]);
}

function getApiStreamAbortSignal() {
  const controller = getState().abortControllers.apiStream;
  assertAtBuildtime(controller !== null);
  return controller.signal;
}

export async function resolveApiCall(userInput: string) {
  const toolCallDiffer = createToolCallDiffer();

  const userMessage: AiModelMessage = {
    role: "user",
    content: userInput,
  };

  const systemContent = getSystemContent();

  await syncSessionFile({
    messages: getAppendedConversationMessages(userMessage),
  });

  const completedStepMessages: AiModelMessage[] = [];

  actions.resetToolEditDiffs();
  actions.setApiStartTime();
  actions.setApiStreamAbortController(new AbortController());
  startLoadingState();
  const generateTextResult = await tryCatchAsync(
    aiDeps.generateText({
      model: getLanguageModel(getState().config.model),
      reasoning: getState().config.reasoning,
      instructions: systemContent,
      messages: [...getState().conversation.messages] as AiModelMessage[],
      tools: getBaseAgentTools(),
      stopWhen: aiDeps.isLoopFinished(),
      abortSignal: getApiStreamAbortSignal(),
      timeout: timeoutSettings,
      onToolExecutionStart: async ({ toolCall }) => {
        switch (toolCall.toolName) {
          case "bash": {
            const input = bashToolInputSchema.parse(toolCall.input);
            toolPrint("bash", input.command);
            if (input.fileSystemAccessType === "create-update-delete") {
              await toolCallDiffer.setTempFiles(
                toolCall.toolCallId,
                input.filePaths,
              );
            }
            break;
          }
          case "web_fetch_html": {
            const input = webFetchToolSchema.parse(toolCall.input);
            toolPrint("web_fetch_html", input.href);
            break;
          }
          case "web_fetch_json": {
            const input = webFetchToolSchema.parse(toolCall.input);
            toolPrint("web_fetch_json", input.href);
            break;
          }
          case "mcp_list_resources": {
            const input = mcpListResourcesSchema.parse(toolCall.input);
            toolPrint("mcp_list_resources", input.server);
            break;
          }
          case "mcp_read_resource": {
            const input = mcpReadResourceSchema.parse(toolCall.input);
            toolPrint("mcp_read_resource", `${input.server} ${input.uri}`);
            break;
          }
          case "load_skill": {
            const input = loadSkillToolSchema.parse(toolCall.input);
            toolPrint("load_skill", input.name);
            break;
          }
          case "read_image": {
            const input = readImageSchema.parse(toolCall.input);
            toolPrint("read_image", input.filePath);
            break;
          }
          case "create_subagent": {
            const input = createSubagentToolSchema.parse(toolCall.input);
            for (const task of input.tasks) {
              toolPrint("create_subagent", `[${task.model}] ${task.prompt}`, {
                maxLines: 2,
              });
            }
            break;
          }
          default:
            toolPrint(
              `[mcp] ${toolCall.toolName}`,
              safeStringify(toolCall.input),
            );
        }
      },
      onToolExecutionEnd: async ({ toolCall, toolOutput }) => {
        if (toolCall.toolName !== "bash") return;
        const success = toolOutput.type === "tool-result";

        const bashSchemaResult = bashToolInputSchema.parse(toolCall.input);
        if (bashSchemaResult.fileSystemAccessType === "create-update-delete") {
          if (!success) {
            await toolCallDiffer.cleanupToolCallIdTempFiles(
              toolCall.toolCallId,
            );
            return;
          }
          await toolCallDiffer.diffAndCleanup(
            toolCall.toolCallId,
            bashSchemaResult.filePaths,
          );
        }
      },
      onStepFinish: (stepResult) => {
        completedStepMessages.push(...stepResult.response.messages);
      },
    }),
  );
  stopLoadingState();
  actions.setApiStreamAbortController(null);
  actions.setApiEndTime();

  if (!generateTextResult.ok) {
    actions.setPromptTokensDirty(true);
    await toolCallDiffer.cleanupAllTempFiles();

    if (isAbortError(generateTextResult.error)) {
      const interruptMessage: AiModelMessage = {
        role: "assistant",
        content: interruptContent,
      };

      // TODO (later): do I want to save the completedStepMessages to the transcript?
      await syncSessionFile({
        messages: getAppendedConversationMessages(
          ...completedStepMessages,
          interruptMessage,
        ),
      });

      if (getState().terminal.isSteering) {
        print.info("Steering" + getUnicodeChar("…"));
        actions.setIsSteering(false);
        return null;
      }

      if (getState().terminal.editorInputValue !== null) {
        await resolveInterruptWithEditor();
      }
      return null;
    }

    print.error(getMessageFromError(generateTextResult.error));
    return null;
  }

  const { usage, finalStep, text, responseMessages } = generateTextResult.value;

  await appendModelUsage(usage);

  const finalStepInputTokens =
    finalStep.usage.inputTokens ?? getApproxPromptTokens();
  const finalStepOutputTokens = orApproxTokens(
    finalStep.usage.outputTokens,
    text,
  );

  actions.setPromptTokens(finalStepInputTokens + finalStepOutputTokens);
  actions.setPromptTokensDirty(false);

  await syncSessionFile({
    transcript: getAppendedTranscript({
      message: text,
      role: "assistant",
      timestamp: Date.now(),
    }),
    messages: getAppendedConversationMessages(...responseMessages),
  });

  return text;
}

export async function getMergedSummaries() {
  const { summaries } = getState().conversation;
  const maxNumberSummaries = getMaxNumberSummaries();

  if (summaries.length < maxNumberSummaries) {
    return getState().conversation.summaries;
  }

  let smallestSecondSummaryIdx = -1;
  let smallestFirstSummaryIdx = -1;

  let smallestSummaryCompactedAt = Infinity;
  for (let idx = 0; idx < summaries.length - 1; idx++) {
    const firstSummary = summaries[idx];
    assertAtBuildtime(firstSummary !== undefined);

    const secondSummary = summaries[idx + 1];
    assertAtBuildtime(secondSummary !== undefined);

    const largerCompactedAt = Math.max(
      firstSummary.compactedAt,
      secondSummary.compactedAt,
    );
    if (largerCompactedAt < smallestSummaryCompactedAt) {
      smallestSummaryCompactedAt = largerCompactedAt;
      smallestFirstSummaryIdx = idx;
      smallestSecondSummaryIdx = idx + 1;
    }
  }

  const firstSummary = summaries[smallestFirstSummaryIdx];
  assertAtBuildtime(firstSummary !== undefined);

  const secondSummary = summaries[smallestSecondSummaryIdx];
  assertAtBuildtime(secondSummary !== undefined);

  const { model } = getState().config;

  const compactPrompt = getMergeSummariesPrompt({
    targetCharLen: maxCharCountPerSummary,
    summaries: markdownFence(
      "json",
      JSON.stringify(
        [firstSummary, secondSummary].map(({ compacted }) => compacted),
      ),
    ),
  });

  const structuredOutputOpts = (() => {
    if (getState().config.compactWithStructuredOutput) {
      return {
        output: Output.object({
          schema: z.object({
            compacted: z.string().max(maxCharCountPerSummary),
          }),
        }),
      };
    }
    return {};
  })();

  startLoadingState();
  const generateTextResult = await tryCatchAsync(
    aiDeps.generateText({
      model: getLanguageModel(model),
      messages: [{ content: compactPrompt, role: "user" }],
      stopWhen: aiDeps.isLoopFinished(),
      abortSignal: getApiStreamAbortSignal(),
      timeout: timeoutSettings,
      ...structuredOutputOpts,
    }),
  );
  stopLoadingState();

  if (!generateTextResult.ok) {
    if (isAbortError(generateTextResult.error)) {
      if (getState().terminal.editorInputValue !== null) {
        await resolveInterruptWithEditor();
      }
      return getState().conversation.summaries;
    }

    print.error(getMessageFromError(generateTextResult.error));
    return getState().conversation.summaries;
  }

  const { usage, output, text } = generateTextResult.value;
  const summaryText = getState().config.compactWithStructuredOutput
    ? output.compacted
    : text;
  await appendModelUsage(usage);

  const mergedSummary: ModelSummary = {
    compacted: summaryText,
    compactedAt: Date.now(),
    tokens: orApproxTokens(usage.outputTokens, summaryText),
  };

  const nextSummaries = summaries
    .slice(0, smallestFirstSummaryIdx)
    .concat(mergedSummary)
    .concat(summaries.slice(smallestSecondSummaryIdx + 1));
  return nextSummaries;
}

export async function getConversationSummary() {
  // messages[0..summaries.length) are re-appended summaries, one per entry,
  // so everything from summaries.length on is not yet summarized
  const compactPrompt = getConversationSummaryPrompt({
    targetCharLen: maxCharCountPerSummary,
    conversation: markdownFence(
      "json",
      JSON.stringify(
        getState().conversation.messages.slice(
          getState().conversation.summaries.length,
        ),
        removeMediaReplacer,
      ),
    ),
  });

  // messages[0..summaries.length) are re-appended summaries, one per entry,
  // so everything from summaries.length on is not yet summarized

  const structuredOutputOpts = (() => {
    if (getState().config.compactWithStructuredOutput) {
      return {
        output: Output.object({
          schema: z.object({
            compacted: z.string().max(maxCharCountPerSummary),
          }),
        }),
      };
    }
    return {};
  })();

  startLoadingState();
  const generateTextResult = await tryCatchAsync(
    aiDeps.generateText({
      model: getLanguageModel(getState().config.model),
      messages: [{ content: compactPrompt, role: "user" }],
      stopWhen: aiDeps.isLoopFinished(),
      abortSignal: getApiStreamAbortSignal(),
      timeout: timeoutSettings,
      ...structuredOutputOpts,
    }),
  );
  stopLoadingState();

  if (!generateTextResult.ok) {
    if (isAbortError(generateTextResult.error)) {
      if (getState().terminal.editorInputValue !== null) {
        await resolveInterruptWithEditor();
      }
      return null;
    }

    print.error(getMessageFromError(generateTextResult.error));
    return null;
  }

  const { usage, output, text } = generateTextResult.value;
  const summaryText = getState().config.compactWithStructuredOutput
    ? output.compacted
    : text;
  const summary: ModelSummary = {
    compacted: summaryText,
    compactedAt: Date.now(),
    tokens: orApproxTokens(usage.outputTokens, summaryText),
  };
  await appendModelUsage(usage);

  return summary;
}

async function applyCompactedConversation(summaries: ModelSummary[]) {
  await syncSessionFile({
    messages: summaries.map(({ compacted }) => ({
      content: compacted,
      role: "assistant",
    })),
    summaries: summaries,
  });
}

export async function maybeCompact(userInput: string) {
  const { model } = getState().config;

  const contextWindow =
    getState().config.contextWindowPerModel[model] ?? defaultContextWindow;

  // maybeCompact runs before each api call turn, so we don't know the token
  // count of userInput until after the API call. This can be problematic when the userInput
  // would large enough to trigger compaction, so we approximate for the userInput
  const userInputTokensApprox = strToApproxTokens(userInput);
  const promptOverheadTokensApprox = getPromptOverheadTokensApprox();

  const nextApiTokens = getCurrentPromptTokens() + userInputTokensApprox;

  const currRatio = nextApiTokens / contextWindow;
  if (currRatio <= compactTriggerRatio) return;

  print.doing("Compacting" + getUnicodeChar("…"));

  actions.setApiStreamAbortController(new AbortController());
  // If summarizing the message params failed, don't reset the message params
  const conversationSummary = await getConversationSummary();
  if (conversationSummary === null) {
    actions.setApiStreamAbortController(null);
    return;
  }

  // If merging the existing summaries failed, use existing summaries
  const mergedSummaries = await getMergedSummaries();
  actions.setApiStreamAbortController(null);

  await applyCompactedConversation([...mergedSummaries, conversationSummary]);

  const summaryTokens = getState()
    .conversation.summaries.map(({ tokens }) => tokens)
    .reduce((accum, curr) => accum + curr, 0);
  actions.setPromptTokens(summaryTokens + promptOverheadTokensApprox);
  actions.setPromptTokensDirty(false);
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

            if (transcriptionInput === null) return;

            const { editorInputValue } = getState().terminal;
            if (editorInputValue === null) {
              actions.appendEditorInputValue(transcriptionInput);
            } else {
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
          case "skills": {
            await pageSkills();
            redrawPendingQuestion();
            return;
          }
          case "context": {
            await pageContext();
            redrawPendingQuestion();
            return;
          }
          case "mcps": {
            await pageMcps();
            redrawPendingQuestion();
            return;
          }
          case "steer": {
            steerCommand();
            redrawPendingQuestion();
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

interface SlashCommandOutcome {
  handled: boolean;
  inputFromCommand: string | null;
}

function splitArgs(input: string) {
  return input.split(/\s+/);
}

function hasArgs(input: string) {
  return splitArgs(input).length > 1;
}

function printUsageIfArgs(commandWithArgs: string) {
  if (!hasArgs(commandWithArgs)) return false;
  const [commandStr] = splitArgs(commandWithArgs);
  assertAtBuildtime(commandStr !== undefined);

  print.error(`Usage: /${commandStr}`);
  return true;
}

async function resolveBuiltinSlashCommand(
  commandWithArgs: string,
): Promise<SlashCommandOutcome> {
  const [commandStr] = splitArgs(commandWithArgs);
  assertAtBuildtime(commandStr !== undefined);

  const command = commandStr as BuiltinSlashCommand;
  switch (command) {
    case "edit": {
      if (printUsageIfArgs(commandWithArgs)) {
        return { handled: true, inputFromCommand: null };
      }

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

      await reload();
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

      await pageMcps({ isTyped: true });
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
  const builtinSlashCommandOutcome =
    await resolveBuiltinSlashCommand(commandWithoutSlash);
  if (builtinSlashCommandOutcome.handled) {
    return builtinSlashCommandOutcome.inputFromCommand;
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
      actions.setEditorInputValue(null);
    }
    return null;
  }

  actions.setEditorInputValue(readResult.value);
  return normalizeNewline(readResult.value);
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

  const initialContentStr = `# [lasso] Editor content ${formatTokenCountAside(editorInputValue)}

${editorInputValue}`;

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
      print.plain(`- ${command}: ${JSON.stringify(keymap)}`);
    }
  });
}

function getAllPrettyConfig() {
  const globalConfigTitle = `Global config from path: ${getGlobalConfigPath()}`;
  const localConfigTitle = `Local config from path: ${getLocalConfigPath()}`;

  return `# Applied config

${markdownFence("json", stringify(getState().config))}

# ${globalConfigTitle}

${markdownFence("yaml", getState().content.globalConfigStr)}

# ${localConfigTitle}

${markdownFence("yaml", getState().content.localConfigStr)}`;
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

const getDefaultConfig = (
  command: "initlocal" | "initglobal",
) => `# This config was auto-generated by the /${command} command
model: claude-haiku-5-5
sdkProvider: anthropic
contextWindowPerModel:
  claude-haiku-5-5: 100000
  gpt-6-luna: 1050000
  glm-5.3-flash: 1300000
pricingPerModel:
  claude-haiku-5-5:
    inputPerMillion: 0.1
    outputPerMillion: 0.5
    cacheReadPerMillion: 0.01
    cacheWritePerMillion: 0.13
  gpt-6-luna:
    inputPerMillion: 0.1
    outputPerMillion: 0.5
    cacheReadPerMillion: 0.01
    cacheWritePerMillion: 0.13
  glm-5.3-flash:
    inputPerMillion: 0.15
    outputPerMillion: 0.5
    cacheReadPerMillion: 0.03
usageLimit:
  dollarAmount: 100
  duration: 12h

# model: gpt-6-luna
# sdkProvider: openai

# model: glm-5.3-flash
# sdkProvider: openai-compatible
# baseURL: https://opencode.ai/zen/v1
\n`;

export async function initLocalConfig() {
  const path = getLocalConfigPath();

  const pathExistsResult = tryCatch(() => fsDeps.existsSync(path));
  if (!pathExistsResult.ok) {
    print.error(
      `Failed to check if ${path} exists. Error: ${getMessageFromError(pathExistsResult.error)}`,
    );
    return;
  }
  if (pathExistsResult.value) {
    print.warning(`The local config already exists at ${path}`);
    return;
  }

  const dir = dirname(path);
  const dirExistsResult = tryCatch(() => fsDeps.existsSync(dir));
  if (!dirExistsResult.ok) {
    print.error(
      `Failed to check if ${dir} exists. Error: ${getMessageFromError(dirExistsResult.error)}`,
    );
    return;
  }
  if (!dirExistsResult.value) {
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

  const pathExistsResult = tryCatch(() => fsDeps.existsSync(path));
  if (!pathExistsResult.ok) {
    print.error(
      `Failed to check if ${path} exists. Error: ${getMessageFromError(pathExistsResult.error)}`,
    );
    return;
  }
  if (pathExistsResult.value) {
    print.warning(`The global config already exists at ${path}`);
    return;
  }

  const dir = dirname(path);
  const dirExistsResult = tryCatch(() => fsDeps.existsSync(dir));
  if (!dirExistsResult.ok) {
    print.error(
      `Failed to check if ${dir} exists. Error: ${getMessageFromError(dirExistsResult.error)}`,
    );
    return;
  }
  if (!dirExistsResult.value) {
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

    return `- **[${prefix}] ${name}** ${formatTokenCountAside(safeStringify(tool))}: ${description}`;
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

export async function pageMcps({ isTyped = false }: SpacingOpts = {}) {
  if (Object.keys(getState().mcp.clients).length === 0) {
    streamingSupportedWithSpacing(isTyped, () =>
      print.warning("No available MCP servers"),
    );
    return;
  }

  const formatted = Object.entries(getState().mcp.clients)
    .map(([clientName, client]) => {
      const { serverInfo } = client;
      return `- ${clientName} _(${serverInfo.name} v${serverInfo.version})_`;
    })
    .join("\n");

  const initialContentStr = `# [lasso] Available MCP servers:

${formatted}`;

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
  actions.setIsSteering(true);
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
    actions.setRecordProcessAbortController(null);
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
      whileMuted: !isTyped,
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
      whileMuted: true,
    });
    // rl.question writes its prompt through mutedStdout which drops output
    // during the recording, so the banner is printed directly instead
    questionPromise = rl.question("", { signal: abortController.signal });
  }
  const finishRecordingResult = await tryCatchAsync(questionPromise);
  stop();

  const recordingResult = await recordingPromise;
  actions.setRecordProcessAbortController(null);
  if (!recordingResult.ok) {
    print.error(
      `Recording failed: ${getMessageFromError(recordingResult.error)}`,
      { whileMuted: !isTyped },
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

  if (transcribeResult.value === "") {
    print.error("Empty transcription result");
    return null;
  }

  print.doing("Transcribed: ", { appendNewline: false, whileMuted: true });
  print.plain(transcribeResult.value, { whileMuted: true });
  return "[Message transcribed; may contain errors] ".concat(
    transcribeResult.value,
  );
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

export async function execGitDiff(opts: {
  tempFileBeforePath: string;
  tempFileAfterPath: string;
  includeFilename?: boolean;
}): Promise<{ stdout: string; stderr: string }> {
  const deltaResult = await tryCatchAsync(
    childProcessDeps.exec("delta --version"),
  );
  const isDeltaAvailable = deltaResult.ok;

  const colorFlag = shouldDisableColor() ? "--color=never" : "--color=always";
  const base = `git diff --no-index ${colorFlag} -U3 ${opts.tempFileBeforePath} ${opts.tempFileAfterPath}`;
  const fileStyle = opts.includeFilename === true ? "normal" : "omit";
  const command = isDeltaAvailable
    ? `${base} | delta --paging=never --line-numbers --hunk-header-style=omit --file-style=${fileStyle}`
    : base;
  const result = await tryCatchAsync(
    childProcessDeps.exec(command, { cwd: os.tmpdir() }),
  );
  // exit code 1 for files that differ
  // exec treats exit code 1 as an error

  if (!result.ok) {
    const code = (result.error as { code?: number }).code;
    const isError = (() => {
      if (code === undefined) return true;
      if (isDeltaAvailable) return code > 1;
      return [2, 127, 128].includes(code) || code > 128;
    })();

    if (isError) {
      throw result.error;
    }
  }

  if (result.ok) return result.value;

  const obj: { stdout: string; stderr: string } = { stderr: "", stdout: "" };
  if (
    typeof result.error === "object" &&
    result.error !== null &&
    "stdout" in result.error &&
    typeof result.error.stdout === "string"
  ) {
    obj.stdout = result.error.stdout;
  }

  if (
    typeof result.error === "object" &&
    result.error !== null &&
    "stderr" in result.error &&
    typeof result.error.stderr === "string"
  ) {
    obj.stderr = result.error.stderr;
  }
  return obj;
}

export function spawnBat(input: string) {
  return tryCatch(() =>
    childProcessDeps.spawnSync(
      "bat",
      [...baseBatFlags(), ...markdownBatFlags, "--paging=never", "-"],
      {
        input,
        encoding: "utf8",
      },
    ),
  );
}

export const markdownBatFlags = ["--language", "md", "--italic-text=always"];

export function baseBatFlags() {
  return shouldDisableColor()
    ? ["--style=plain", "--color=never"]
    : ["--style=plain", "--color=always"];
}
