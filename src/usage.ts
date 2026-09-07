import { z } from "zod";
import { actions, getState } from "./state.ts";
import { createLockUtils, tryCatch } from "./utils.ts";
import { fsDeps, processDeps } from "./deps.ts";
import assert from "node:assert";
import type { LanguageModelUsage } from "ai";
import { getUsageLogLockPath, getUsageLogPath } from "./paths.ts";
import { dirname } from "node:path";

function printWarning(message: string) {
  const output = `${message}\n`;
  processDeps.stdout.write(output);
  actions.appendToStdout(output);
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
  assert(usageLimit !== undefined);

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
  assert(usageLimit !== undefined);
  const expiredTime = getExpiredTime();

  const path = getUsageLogPath();
  const dir = dirname(path);
  if (!fsDeps.existsSync(dir)) return;

  const lockUtils = createLockUtils(getUsageLogLockPath());
  const created = await lockUtils.createLock();
  if (!created) {
    return printWarning(
      `Failed to acquire a lock for ${getUsageLogLockPath()}`,
    );
  }

  const readResult = tryCatch(() => fsDeps.readFileSync(path).toString());
  if (!readResult.ok) {
    tryCatch(() => fsDeps.writeFileSync(path, JSON.stringify({})));
    return;
  }

  const parseResult = tryCatch(() =>
    ModelUsageMapSchema.parse(JSON.parse(readResult.value)),
  );
  if (!parseResult.ok) {
    tryCatch(() => fsDeps.writeFileSync(path, JSON.stringify({})));
    return;
  }
  const filtered = filterExpiredModelUsage(parseResult.value, expiredTime);

  tryCatch(() => fsDeps.writeFileSync(path, JSON.stringify(filtered)));

  lockUtils.deleteLock();
  actions.setModelUsageForLimitWindow(filtered);
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
    tryCatch(() => fsDeps.mkdirSync(dir, { recursive: true }));
  }

  const lockUtils = createLockUtils(getUsageLogLockPath());
  const created = await lockUtils.createLock();
  if (!created) {
    return printWarning(
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
}
