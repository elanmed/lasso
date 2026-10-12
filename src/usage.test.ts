import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ModelUsageSchema,
  filterExpiredModelUsage,
  getUsageMoneyForModel,
  sumUsageTokens,
} from "./usage.ts";

describe("ModelUsageSchema", () => {
  it("parses model usage", () => {
    assert.deepStrictEqual(
      ModelUsageSchema.parse({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        date: 123,
      }),
      {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        date: 123,
      },
    );
  });

  it("rejects model usage without a date", () => {
    const result = ModelUsageSchema.safeParse({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    });
    assert.strictEqual(result.success, false);
  });
});

describe("filterExpiredModelUsage", () => {
  it("returns an empty object for an empty map", () => {
    assert.deepStrictEqual(filterExpiredModelUsage({}, 100), {});
  });

  it("keeps entries at or after the expiration time", () => {
    const map = {
      model: [
        {
          inputTokens: 1,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          date: 100,
        },
        {
          inputTokens: 2,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          date: 200,
        },
      ],
    };
    assert.deepStrictEqual(filterExpiredModelUsage(map, 150), {
      model: [map.model[1]],
    });
  });

  it("drops models whose entries are all expired", () => {
    const map = {
      model: [
        {
          inputTokens: 1,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          date: 100,
        },
      ],
    };
    assert.deepStrictEqual(filterExpiredModelUsage(map, 150), {});
  });
});

describe("getUsageMoneyForModel", () => {
  it("computes cost across input, output, and cache tokens", () => {
    const result = getUsageMoneyForModel(
      {
        inputTokens: 900_000,
        outputTokens: 200_000,
        cacheReadTokens: 300_000,
        cacheWriteTokens: 100_000,
      },
      {
        inputPerMillion: 1,
        outputPerMillion: 5,
        cacheReadPerMillion: 0.25,
        cacheWritePerMillion: 1.25,
      },
    );
    assert.strictEqual(result, 1.7);
  });

  it("clamps uncached input tokens to zero when cache tokens exceed input tokens", () => {
    const result = getUsageMoneyForModel(
      {
        inputTokens: 100_000,
        outputTokens: 0,
        cacheReadTokens: 300_000,
        cacheWriteTokens: 100_000,
      },
      {
        inputPerMillion: 1,
        outputPerMillion: 5,
        cacheReadPerMillion: 0.25,
        cacheWritePerMillion: 1.25,
      },
    );
    assert.strictEqual(result, 0.2);
  });

  it("uses the input price when cache prices are omitted", () => {
    const result = getUsageMoneyForModel(
      {
        inputTokens: 2_000_000,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 500_000,
      },
      { inputPerMillion: 2, outputPerMillion: 10 },
    );
    assert.strictEqual(result, 4);
  });
});

describe("sumUsageTokens", () => {
  it("returns all zeros for an empty array", () => {
    assert.deepStrictEqual(sumUsageTokens([]), {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("sums each token type across entries", () => {
    assert.deepStrictEqual(
      sumUsageTokens([
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
      ]),
      {
        inputTokens: 250,
        outputTokens: 130,
        cacheReadTokens: 30,
        cacheWriteTokens: 15,
      },
    );
  });
});
