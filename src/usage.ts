import { z } from "zod";
import { type ModelPricing } from "./schemas.ts";

export const ModelUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  date: z.number(),
});

export type ModelUsage = z.infer<typeof ModelUsageSchema>;

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
