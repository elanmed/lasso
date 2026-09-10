import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import type { LanguageModelUsage } from "ai";

import {
  getPrettyContextWindowUsage,
  getPrettyTokenUsage,
  getPrettyUsage,
  getUsageMoneyForModel,
  sumUsageTokens,
} from "./usage-format.ts";
import { actions } from "./state.ts";
import { appendModelUsage } from "./usage.ts";
import { setupFakeDeps } from "./test-helpers.ts";
import { processDeps } from "./deps.ts";

describe("usage-format", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe("getPrettyUsage", () => {
    beforeEach(() => {
      setupFakeDeps();
      actions.resetState();
    });

    it("returns just token usage when the model has no context window configured", () => {
      actions.setModel("unknown-model");
      const result = getPrettyUsage();
      assert.strictEqual(result, "0 tokens in session");
    });

    it("includes context window usage when configured", () => {
      actions.setModel("test-model");
      actions.setContextWindowPerModel({ "test-model": 10_000 });
      actions.appendToMessageParams({ role: "user", content: "hi" });
      actions.setMessageParamTokens(5_000);
      const result = getPrettyUsage();
      assert.strictEqual(result, "0 tokens in session, 50% of context window");
    });
  });

  describe("getPrettyTokenUsage", () => {
    beforeEach(() => {
      setupFakeDeps();
      actions.resetState();
      actions.setPricingPerModel({
        "claude-haiku-4-5": {
          inputPerMillion: 1,
          outputPerMillion: 5,
          cacheReadPerMillion: 0.25,
          cacheWritePerMillion: 1.25,
        },
        "claude-sonnet-4-6": {
          inputPerMillion: 3,
          outputPerMillion: 15,
          cacheReadPerMillion: 0.75,
          cacheWritePerMillion: 3.75,
        },
        "claude-opus-4-6": {
          inputPerMillion: 5,
          outputPerMillion: 25,
          cacheReadPerMillion: 1.25,
          cacheWritePerMillion: 6.25,
        },
      });
      actions.setUsageLimit({ duration: "60m", dollarAmount: 10 });
    });

    it("known model with no modelUsage returns $0.0000", () => {
      actions.setModel("claude-haiku-4-5");
      const result = getPrettyTokenUsage();
      assert.equal(result, "$0.000 in session, $0.000 of $10 limit");
    });

    it("calculates prompt token costs correctly", async () => {
      // haiku: input=$1/M, 2_000_000 prompt = $2.0000
      actions.setModel("claude-haiku-4-5");

      await appendModelUsage({
        inputTokens: 2_000_000,
        outputTokens: 0,
        inputTokenDetails: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      } as LanguageModelUsage);
      const result = getPrettyTokenUsage();
      assert.equal(result, "$2.000 in session, $2.000 of $10 limit");
    });

    it("calculates completion token costs correctly", async () => {
      // haiku: output=$5/M, 600_000 completion = $3.0000
      actions.setModel("claude-haiku-4-5");
      await appendModelUsage({
        inputTokens: 0,
        outputTokens: 600_000,
        inputTokenDetails: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      } as LanguageModelUsage);
      const result = getPrettyTokenUsage();
      assert.equal(result, "$3.000 in session, $3.000 of $10 limit");
    });

    it("calculates cache read token costs correctly", async () => {
      // haiku: cacheRead=$0.25/M
      // 1_000_000 input tokens, all cache reads = $0.25
      actions.setModel("claude-haiku-4-5");
      await appendModelUsage({
        inputTokens: 1_000_000,
        outputTokens: 0,
        inputTokenDetails: {
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 0,
        },
      } as LanguageModelUsage);
      const result = getPrettyTokenUsage();
      assert.equal(result, "$0.250 in session, $0.250 of $10 limit");
    });

    it("calculates cache write token costs correctly", async () => {
      // haiku: cacheWrite=$1.25/M
      // 1_000_000 input tokens, all cache writes = $1.25
      actions.setModel("claude-haiku-4-5");
      await appendModelUsage({
        inputTokens: 1_000_000,
        outputTokens: 0,
        inputTokenDetails: {
          cacheReadTokens: 0,
          cacheWriteTokens: 1_000_000,
        },
      } as LanguageModelUsage);
      const result = getPrettyTokenUsage();
      assert.equal(result, "$1.250 in session, $1.250 of $10 limit");
    });

    it("calculates combined input, output, and cache costs correctly", async () => {
      // haiku: input=$1/M, output=$5/M, cacheRead=$0.25/M, cacheWrite=$1.25/M
      // 900_000 input (500_000 uncached + 300_000 cacheRead + 100_000 cacheWrite) + 200_000 output
      // = $0.50 + $1.00 + $0.075 + $0.125 = $1.70
      actions.setModel("claude-haiku-4-5");
      await appendModelUsage({
        inputTokens: 900_000,
        outputTokens: 200_000,
        inputTokenDetails: {
          cacheReadTokens: 300_000,
          cacheWriteTokens: 100_000,
        },
      } as LanguageModelUsage);
      const result = getPrettyTokenUsage();
      assert.equal(result, "$1.700 in session, $1.700 of $10 limit");
    });

    it("shows cost against the dollar limit when configured", async () => {
      actions.setModel("claude-haiku-4-5");
      actions.setUsageLimit({ duration: "60m", dollarAmount: 10 });
      await appendModelUsage({
        inputTokens: 900_000,
        outputTokens: 200_000,
        inputTokenDetails: {
          cacheReadTokens: 300_000,
          cacheWriteTokens: 100_000,
        },
      } as LanguageModelUsage);
      const result = getPrettyTokenUsage();
      assert.equal(result, "$1.700 in session, $1.700 of $10 limit");
    });

    it("shows session and limit window costs separately when they differ", async () => {
      actions.setModel("claude-haiku-4-5");
      await appendModelUsage({
        inputTokens: 900_000,
        outputTokens: 200_000,
        inputTokenDetails: {
          cacheReadTokens: 300_000,
          cacheWriteTokens: 100_000,
        },
      } as LanguageModelUsage);
      actions.setModelUsageForLimitWindow({
        "claude-haiku-4-5": [
          {
            inputTokens: 100_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            date: 1_000,
          },
        ],
      });
      const result = getPrettyTokenUsage();
      assert.equal(result, "$1.700 in session, $0.100 of $10 limit");
    });

    it("shows only session cost when the usage limit is disabled", async () => {
      actions.setModel("claude-haiku-4-5");
      actions.setUsageLimit(undefined);
      await appendModelUsage({
        inputTokens: 900_000,
        outputTokens: 200_000,
        inputTokenDetails: {
          cacheReadTokens: 300_000,
          cacheWriteTokens: 100_000,
        },
      } as LanguageModelUsage);
      const result = getPrettyTokenUsage();
      assert.equal(result, "$1.700 in session");
    });

    it("accumulates all token types across multiple modelUsage", async () => {
      // haiku: input=$1/M, output=$5/M, cacheRead=$0.25/M, cacheWrite=$1.25/M
      // usage1: 800_000 input (200_000 uncached + 400_000 cacheRead + 200_000 cacheWrite) + 100_000 output
      //   = $0.20 + $0.50 + $0.10 + $0.25 = $1.05
      // usage2: 1_600_000 input (500_000 uncached + 500_000 cacheRead + 600_000 cacheWrite) + 200_000 output
      //   = $0.50 + $1.00 + $0.125 + $0.75 = $2.375
      // total = $3.425
      actions.setModel("claude-haiku-4-5");
      await appendModelUsage({
        inputTokens: 800_000,
        outputTokens: 100_000,
        inputTokenDetails: {
          cacheReadTokens: 400_000,
          cacheWriteTokens: 200_000,
        },
      } as LanguageModelUsage);
      await appendModelUsage({
        inputTokens: 1_600_000,
        outputTokens: 200_000,
        inputTokenDetails: {
          cacheReadTokens: 500_000,
          cacheWriteTokens: 600_000,
        },
      } as LanguageModelUsage);
      const result = getPrettyTokenUsage();
      assert.equal(result, "$3.425 in session, $3.425 of $10 limit");
    });

    it("falls back to the input price when cache pricing is omitted", async () => {
      actions.setPricingPerModel({
        "test-model": {
          inputPerMillion: 2,
          outputPerMillion: 10,
        },
      });
      actions.setModel("test-model");
      await appendModelUsage({
        inputTokens: 2_000_000,
        outputTokens: 0,
        inputTokenDetails: {
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 500_000,
        },
      } as LanguageModelUsage);
      const result = getPrettyTokenUsage();
      assert.equal(result, "$4.000 in session, $4.000 of $10 limit");
    });

    it("formats cost with commas for large totals", async () => {
      // opus: input=$5/M
      // 200_000_000 input tokens = (200_000_000 * 5) / 1_000_000 = $1,000.0000
      actions.setModel("claude-opus-4-6");
      await appendModelUsage({
        inputTokens: 200_000_000,
        outputTokens: 0,
        inputTokenDetails: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      } as LanguageModelUsage);
      const result = getPrettyTokenUsage();
      assert.equal(result, "$1,000.000 in session, $1,000.000 of $10 limit");
    });

    it("formats cost with commas for very large totals across multiple modelUsage", async () => {
      // opus: input=$5/M, output=$25/M
      // usage1: 300_000_000 input + 40_000_000 output = $1,500 + $1,000 = $2,500
      // usage2: 400_000_000 input + 120_000_000 output = $2,000 + $3,000 = $5,000
      // total = $7,500.000
      actions.setModel("claude-opus-4-6");
      await appendModelUsage({
        inputTokens: 300_000_000,
        outputTokens: 40_000_000,
        inputTokenDetails: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      } as LanguageModelUsage);
      await appendModelUsage({
        inputTokens: 400_000_000,
        outputTokens: 120_000_000,
        inputTokenDetails: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      } as LanguageModelUsage);
      const result = getPrettyTokenUsage();
      assert.equal(result, "$7,500.000 in session, $7,500.000 of $10 limit");
    });
  });

  describe("getPrettyContextWindowUsage", () => {
    beforeEach(() => {
      setupFakeDeps();
      actions.resetState();
    });

    it("returns empty string when the model has no context window configured", () => {
      actions.setModel("unknown-model");
      const result = getPrettyContextWindowUsage();
      assert.strictEqual(result, "");
    });

    it("returns 0% when no tokens are used", () => {
      actions.setModel("test-model");
      actions.setContextWindowPerModel({ "test-model": 10_000 });
      const result = getPrettyContextWindowUsage();
      assert.strictEqual(result, "0% of context window");
    });

    it("returns the percent of the context window used", () => {
      actions.setModel("test-model");
      actions.setContextWindowPerModel({ "test-model": 10_000 });
      actions.appendToMessageParams({ role: "user", content: "hi" });
      actions.setMessageParamTokens(5_000);
      const result = getPrettyContextWindowUsage();
      assert.strictEqual(result, "50% of context window");
    });

    it("floors partial percents", () => {
      actions.setModel("test-model");
      actions.setContextWindowPerModel({ "test-model": 10_000 });
      actions.appendToMessageParams({ role: "user", content: "hi" });
      actions.setMessageParamTokens(1_666);
      const result = getPrettyContextWindowUsage();
      assert.strictEqual(result, "16% of context window");
    });

    it("returns percents above 100", () => {
      actions.setModel("test-model");
      actions.setContextWindowPerModel({ "test-model": 10_000 });
      actions.appendToMessageParams({ role: "user", content: "hi" });
      actions.setMessageParamTokens(15_000);
      const result = getPrettyContextWindowUsage();
      assert.strictEqual(result, "150% of context window");
    });

    it("returns empty string when there are fewer than 80 columns", () => {
      mock.method(processDeps.stdout, "getColumns", () => 79);
      actions.setModel("test-model");
      actions.setContextWindowPerModel({ "test-model": 10_000 });
      const result = getPrettyContextWindowUsage();
      assert.strictEqual(result, "");
    });

    it("returns the percent when there are at least 80 columns", () => {
      mock.method(processDeps.stdout, "getColumns", () => 80);
      actions.setModel("test-model");
      actions.setContextWindowPerModel({ "test-model": 10_000 });
      const result = getPrettyContextWindowUsage();
      assert.strictEqual(result, "0% of context window");
    });
  });

  describe("getUsageMoneyForModel", () => {
    beforeEach(() => {
      setupFakeDeps();
      actions.resetState();
      actions.setModel("gpt-4");
      actions.setPricingPerModel({
        "gpt-4": {
          inputPerMillion: 1,
          outputPerMillion: 5,
          cacheReadPerMillion: 0.25,
          cacheWritePerMillion: 1.25,
        },
      });
    });

    it("throws when the model has no pricing configured", () => {
      actions.setPricingPerModel({});
      assert.throws(
        () =>
          getUsageMoneyForModel(
            {
              inputTokens: 1,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            "gpt-4",
          ),
        /pricing/,
      );
    });

    it("computes the total cost from all token types", () => {
      const result = getUsageMoneyForModel(
        {
          inputTokens: 900_000,
          outputTokens: 200_000,
          cacheReadTokens: 300_000,
          cacheWriteTokens: 100_000,
        },
        "gpt-4",
      );
      assert.strictEqual(result, 1.7);
    });

    it("falls back to the input price when cache pricing is omitted", () => {
      actions.setPricingPerModel({
        "gpt-4": {
          inputPerMillion: 2,
          outputPerMillion: 10,
        },
      });
      const result = getUsageMoneyForModel(
        {
          inputTokens: 2_000_000,
          outputTokens: 0,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 500_000,
        },
        "gpt-4",
      );
      assert.strictEqual(result, 4);
    });
  });

  describe("sumUsageTokens", () => {
    it("returns all zeros for an empty array", () => {
      const result = sumUsageTokens([]);
      assert.deepStrictEqual(result, {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });

    it("sums all token types across multiple entries", () => {
      const result = sumUsageTokens([
        {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
          date: 1_000,
        },
        {
          inputTokens: 150,
          outputTokens: 80,
          cacheReadTokens: 20,
          cacheWriteTokens: 10,
          date: 2_000,
        },
      ]);
      assert.deepStrictEqual(result, {
        inputTokens: 250,
        outputTokens: 130,
        cacheReadTokens: 30,
        cacheWriteTokens: 15,
      });
    });
  });

  describe("getPrettyTokenUsage no pricing configured", () => {
    beforeEach(() => {
      setupFakeDeps();
      actions.resetState();
    });

    it("returns token counts for no modelUsage", () => {
      actions.setModel("unknown-model");
      const result = getPrettyTokenUsage();
      assert.equal(result, "0 tokens in session");
    });

    it("returns token counts for modelUsage with no pricing configured", async () => {
      actions.setModel("unknown-model");
      await appendModelUsage({
        inputTokens: 100,
        outputTokens: 50,
        inputTokenDetails: {
          cacheReadTokens: 25,
          cacheWriteTokens: 10,
        },
      } as LanguageModelUsage);
      const result = getPrettyTokenUsage();
      assert.equal(result, "150 tokens in session");
    });

    it("formats token counts with commas for numbers above 999", async () => {
      actions.setModel("unknown-model");
      await appendModelUsage({
        inputTokens: 1_500,
        outputTokens: 2_500,
        inputTokenDetails: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      } as LanguageModelUsage);
      const result = getPrettyTokenUsage();
      assert.equal(result, "4,000 tokens in session");
    });

    it("formats token counts with commas for very large numbers", async () => {
      actions.setModel("unknown-model");
      await appendModelUsage({
        inputTokens: 1_234_567,
        outputTokens: 9_876_543,
        inputTokenDetails: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      } as LanguageModelUsage);
      const result = getPrettyTokenUsage();
      assert.equal(result, "11,111,110 tokens in session");
    });

    it("accumulates token counts across multiple modelUsage and formats with commas", async () => {
      actions.setModel("unknown-model");
      await appendModelUsage({
        inputTokens: 50_000,
        outputTokens: 10_000,
        inputTokenDetails: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      } as LanguageModelUsage);
      await appendModelUsage({
        inputTokens: 125_000,
        outputTokens: 25_000,
        inputTokenDetails: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      } as LanguageModelUsage);
      const result = getPrettyTokenUsage();
      assert.equal(result, "210,000 tokens in session");
    });
  });
});
