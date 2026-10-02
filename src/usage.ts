import { dirname } from "node:path";
import { z } from "zod";
import type { LanguageModelUsage } from "ai";
import { assertAtBuildtime } from "./assert.ts";
import { actions, getState, promptDeps } from "./state.ts";

import {
  createLockUtils,
  createQueue,
  tryCatch,
  getApproxTokensFromMessages,
  strToApproxTokens,
  decimalToPercent,
  approxTokensToCharLen,
} from "./utils.ts";
import { fsDeps } from "./deps.ts";
import { getUsageLogLockPath, getUsageLogPath } from "./paths.ts";
import { print } from "./print.ts";
import { baseAgentPrompt } from "./prompts.ts";
import { MISSING } from "./missing.ts";

export const compactTriggerRatio = 0.95;
export const dedicatedSummaryRatio = 0.25;
export const dedicatedPromptOverheadRatio =
  compactTriggerRatio - dedicatedSummaryRatio;

export const defaultContextWindow = 128_000;
const maxTokenCountPerSummary = 5_000;
export const maxCharCountPerSummary = approxTokensToCharLen(
  maxTokenCountPerSummary,
);
export function getMaxNumberSummaries() {
  const { model } = getState().config;
  if (model === MISSING) return null;
  const contextWindow =
    getState().config.contextWindowPerModel[model] ?? defaultContextWindow;
  const allSummariesTokenCount = dedicatedSummaryRatio * contextWindow;
  return Math.floor(allSummariesTokenCount / maxTokenCountPerSummary);
}

export const ModelUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  date: z.number(),
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

const ModelUsageMapSchema = z.record(z.string(), z.array(ModelUsageSchema));

const lockQueues = new Map<string, ReturnType<typeof createQueue>>();

function getLockQueue(lockPath: string) {
  let queue = lockQueues.get(lockPath);
  if (queue === undefined) {
    queue = createQueue();
    lockQueues.set(lockPath, queue);
  }
  return queue;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

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
  actions.appendToModelUsageForSession(defaultedUsage);
}

export function isUsageLimitDisabled() {
  const { usageLimit, pricingPerModel, model } = getState().config;
  const pricing = pricingPerModel[model];

  return pricing === undefined || usageLimit === undefined;
}

export function filterExpiredModelUsage(
  map: Record<string, ModelUsage[]>,
  expiredTime: number,
) {
  const filtered: Record<string, ModelUsage[]> = {};
  for (const [model, modelUsage] of Object.entries(map)) {
    const kept = modelUsage.filter((usage) => usage.date >= expiredTime);
    if (kept.length > 0) filtered[model] = kept;
  }
  return filtered;
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
  if (!fsDeps.existsSync(dir)) return;

  await getLockQueue(getUsageLogLockPath()).enqueue(async () => {
    const lockUtils = createLockUtils(getUsageLogLockPath());
    const created = await lockUtils.createLock();
    if (!created) {
      return print.warning(
        `Failed to acquire a lock for ${getUsageLogLockPath()}`,
      );
    }

    const readResult = tryCatch(() => fsDeps.readFileSync(path).toString());
    if (!readResult.ok) {
      tryCatch(() => fsDeps.writeFileSync(path, JSON.stringify({})));
      lockUtils.deleteLock();
      return;
    }

    const parseResult = tryCatch(() =>
      ModelUsageMapSchema.parse(JSON.parse(readResult.value)),
    );
    if (!parseResult.ok) {
      tryCatch(() => fsDeps.writeFileSync(path, JSON.stringify({})));
      lockUtils.deleteLock();
      return;
    }
    const filtered = filterExpiredModelUsage(parseResult.value, expiredTime);

    tryCatch(() => fsDeps.writeFileSync(path, JSON.stringify(filtered)));

    lockUtils.deleteLock();
    actions.setModelUsageForLimitWindow(filtered);
  });
}

export async function syncNewModelUsageForLimitWindow(
  model: string,
  usage: ModelUsage,
) {
  if (isUsageLimitDisabled()) return;

  const expiredTime = getExpiredTime();

  const path = getUsageLogPath();
  const dir = dirname(path);
  if (!fsDeps.existsSync(dir)) {
    const mkDirResult = tryCatch(() =>
      fsDeps.mkdirSync(dir, { recursive: true }),
    );
    if (!mkDirResult.ok) {
      print.warning(`Failed to create the directory: ${dir}`);
      return;
    }
  }

  await getLockQueue(getUsageLogLockPath()).enqueue(async () => {
    const lockUtils = createLockUtils(getUsageLogLockPath());
    const created = await lockUtils.createLock();
    if (!created) {
      return print.warning(
        `Failed to acquire a lock for ${getUsageLogLockPath()}`,
      );
    }

    const readResult = tryCatch(() => fsDeps.readFileSync(path).toString());
    const loggedModelUsage = (() => {
      if (!readResult.ok) return {};
      const parseResult = tryCatch(() =>
        ModelUsageMapSchema.parse(JSON.parse(readResult.value)),
      );
      if (parseResult.ok) return parseResult.value;
      return {};
    })();
    (loggedModelUsage[model] ??= []).push(usage);

    const filtered = filterExpiredModelUsage(loggedModelUsage, expiredTime);

    tryCatch(() => fsDeps.writeFileSync(path, JSON.stringify(filtered)));
    lockUtils.deleteLock();

    actions.setModelUsageForLimitWindow(filtered);
  });
}

export function getPromptOverheadTokensApprox() {
  const systemContentTokensApprox = strToApproxTokens(
    promptDeps.getSystemContent(),
  );
  const toolsTokensApprox = strToApproxTokens(promptDeps.getToolsContentStr());
  return systemContentTokensApprox + toolsTokensApprox;
}

export function warnOnLargePromptOverhead() {
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
    getApproxTokensFromMessages(getState().app.conversation.messages) +
    getPromptOverheadTokensApprox()
  );
}

export function getCurrentPromptTokens() {
  if (getState().app.promptTokens.dirty) {
    return getApproxPromptTokens();
  }
  return getState().app.promptTokens.value;
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
    messages: getApproxTokensFromMessages(getState().app.conversation.messages),
    context: strToApproxTokens(getState().app.contextStr),
    tools: strToApproxTokens(promptDeps.getToolsContentStr()),
    basePrompt: strToApproxTokens(baseAgentPrompt),
    skills: strToApproxTokens(getState().app.skillsStr),
  };

  if (getState().app.promptTokens.dirty) {
    return tokensByAreaApprox;
  }

  const realTokens = getState().app.promptTokens.value;
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

export function orApproxTokens(value: number | undefined, text: string) {
  return value ?? strToApproxTokens(text);
}
