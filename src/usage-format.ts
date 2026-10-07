import { getState } from "./state.ts";
import { assertAtBuildtime } from "./assert.ts";
import { decimalToPercent } from "./utils.ts";
import { defaultContextWindow, getCurrentPromptTokens } from "./usage.ts";
import {
  isUsageLimitDisabled,
  type ModelUsage,
  type TokenUsage,
} from "./usage.ts";

const DOLLARS_PER_MILLION = 1_000_000;

export function getUsageMoneyForModel(usageTokens: TokenUsage, model: string) {
  const pricing = getState().config.pricingPerModel[model];
  assertAtBuildtime(pricing !== undefined);

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
  return modelUsage.reduce<{
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }>(
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

export function getPrettyMoney(money: number) {
  return money.toLocaleString("en-US", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
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

  const costForSession = getUsageMoneyForModel(tokenUsageForSession, model);
  const { usageLimit } = getState().config;

  if (isUsageLimitDisabled()) {
    return `$${getPrettyMoney(costForSession)} in session`;
  }

  assertAtBuildtime(usageLimit !== undefined);
  const costForLimitWindow = getUsageMoneyForModel(
    tokenUsageForLimitWindow,
    model,
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
