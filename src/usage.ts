import { dirname } from "node:path";
import { z } from "zod";
import { type LanguageModelUsage } from "ai";
import {
  assertAtBuildtime,
  tryCatchAsync,
  getMessageFromError,
  tryCatch,
  createLockUtils,
  getLockQueue,
  getPrettyMoney,
  stringify,
} from "./utils.ts";
import { actions, getState } from "./state.ts";
import { fsDeps } from "./deps.ts";
import { getUsageLogLockPath, getUsageLogPath } from "./paths.ts";
import { print } from "./printing.ts";
import { type ModelPricing, type ModelUsage } from "./schemas.ts";

export type { ModelUsage };

export const ModelUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  date: z.number(),
});

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
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

const DOLLARS_PER_MILLION = 1_000_000;

export function getUsageMoneyForModel(
  usageTokens: TokenUsage,
  pricing: ModelPricing,
) {
  const inputPerMillion = pricing.inputPerMillion;
  const outputPerMillion = pricing.outputPerMillion;
  const cacheReadPerMillion = pricing.cacheReadPerMillion ?? inputPerMillion;
  const cacheWritePerMillion = pricing.cacheWritePerMillion ?? inputPerMillion;

  const uncachedInputTokens = Math.max(
    0,
    usageTokens.inputTokens -
      usageTokens.cacheReadTokens -
      usageTokens.cacheWriteTokens,
  );
  const inputCost =
    (uncachedInputTokens * inputPerMillion) / DOLLARS_PER_MILLION;
  const outputCost =
    (usageTokens.outputTokens * outputPerMillion) / DOLLARS_PER_MILLION;
  const cacheReadCost =
    (usageTokens.cacheReadTokens * cacheReadPerMillion) / DOLLARS_PER_MILLION;
  const cacheWriteCost =
    (usageTokens.cacheWriteTokens * cacheWritePerMillion) / DOLLARS_PER_MILLION;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

export function sumUsageTokens(modelUsage: ModelUsage[]): TokenUsage {
  return modelUsage.reduce<TokenUsage>(
    (accum, curr) => ({
      inputTokens: accum.inputTokens + curr.inputTokens,
      outputTokens: accum.outputTokens + curr.outputTokens,
      cacheReadTokens: accum.cacheReadTokens + curr.cacheReadTokens,
      cacheWriteTokens: accum.cacheWriteTokens + curr.cacheWriteTokens,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  );
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
  actions.usage.appendToModelUsageForSession(defaultedUsage, model);
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
      await tryCatchAsync(fsDeps.writeFile(path, stringify({}, { space: 0 })));
      await lockUtils.deleteLock();
      return;
    }

    const readResult = await tryCatchAsync(fsDeps.readFile(path, "utf8"));
    if (!readResult.ok) {
      print.error(
        `Failed to read the usage log at ${path}. Error: ${getMessageFromError(readResult.error)}`,
      );
      await tryCatchAsync(fsDeps.writeFile(path, stringify({}, { space: 0 })));
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
      await tryCatchAsync(fsDeps.writeFile(path, stringify({}, { space: 0 })));
      await lockUtils.deleteLock();
      return;
    }
    const filtered = filterExpiredModelUsage(parseResult.value, expiredTime);

    await tryCatchAsync(
      fsDeps.writeFile(path, stringify(filtered, { space: 0 })),
    );

    await lockUtils.deleteLock();
    actions.usage.setModelUsageForLimitWindow(filtered);
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

    await tryCatchAsync(
      fsDeps.writeFile(path, stringify(filtered, { space: 0 })),
    );
    await lockUtils.deleteLock();

    actions.usage.setModelUsageForLimitWindow(filtered);
  });
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
