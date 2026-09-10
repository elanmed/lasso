import assert from "node:assert";
import { getState } from "./state.ts";
import { processDeps } from "./deps.ts";
import {
  isUsageLimitDisabled,
  type ModelUsage,
  type TokenUsage,
} from "./usage.ts";

const DOLLARS_PER_MILLION = 1_000_000;

export function getPrettyUsage() {
  const tokenUsage = getPrettyTokenUsage();
  const contextWindowUsage = getPrettyContextWindowUsage();
  if (contextWindowUsage.length > 0) {
    return `${tokenUsage}, ${contextWindowUsage}`;
  }
  return tokenUsage;
}

export function getUsageMoneyForModel(usageTokens: TokenUsage, model: string) {
  const pricing = getState().config.pricingPerModel[model];
  assert(pricing !== undefined);

  const inputPerMillion = pricing.inputPerMillion;
  const outputPerMillion = pricing.outputPerMillion;
  const cacheReadPerMillion = pricing.cacheReadPerMillion ?? inputPerMillion;
  const cacheWritePerMillion = pricing.cacheWritePerMillion ?? inputPerMillion;

  const uncachedInputTokens =
    usageTokens.inputTokens -
    usageTokens.cacheReadTokens -
    usageTokens.cacheWriteTokens;
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

export function getPrettyTokenUsage() {
  const { model } = getState().config;
  const pricing = getState().config.pricingPerModel[model];
  const tokenUsageForSession = sumUsageTokens(
    getState().app.modelUsageForSession[model] ?? [],
  );

  if (pricing === undefined) {
    return `${(tokenUsageForSession.inputTokens + tokenUsageForSession.outputTokens).toLocaleString()} tokens in session`;
  }

  const tokenUsageForLimitWindow = sumUsageTokens(
    getState().app.modelUsageForLimitWindow[model] ?? [],
  );

  const getPrettyMoney = (money: number) =>
    money.toLocaleString("en-US", {
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    });

  const costForSession = getUsageMoneyForModel(tokenUsageForSession, model);
  const { usageLimit } = getState().config;

  if (isUsageLimitDisabled())
    return `$${getPrettyMoney(costForSession)} in session`;

  assert(usageLimit !== undefined);
  const costForLimitWindow = getUsageMoneyForModel(
    tokenUsageForLimitWindow,
    model,
  );
  return `$${getPrettyMoney(costForSession)} in session, $${getPrettyMoney(costForLimitWindow)} of $${String(usageLimit.dollarAmount)} limit`;
}

export function getPrettyContextWindowUsage() {
  const columns = processDeps.stdout.getColumns();
  if (columns !== undefined && columns < 80) return "";

  const { model } = getState().config;
  const contextWindow = getState().config.contextWindowPerModel[model];
  if (contextWindow === undefined) return "";

  const currRatio = getState().app.messageParams.tokens / contextWindow;
  const currPercent = String(Math.floor(currRatio * 100));
  return `${currPercent}% of context window`;
}
