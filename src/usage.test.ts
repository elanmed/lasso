import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import {
  appendModelUsage,
  filterExpiredModelUsage,
  getExpiredTime,
  isUsageLimitDisabled,
  syncInitialModelUsageForLimitWindow,
  syncNewModelUsageForLimitWindow,
} from "./usage.ts";
import { actions, getState } from "./state.ts";
import { fsDeps } from "./deps.ts";
import { dirname } from "node:path";
import type { LanguageModelUsage } from "ai";
import { setupFakeDeps, testFs } from "./test-helpers.ts";
import { getUsageLogLockPath, getUsageLogPath } from "./paths.ts";

describe("usage", () => {
  describe("appendModelUsage", () => {
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
        claude: {
          inputPerMillion: 1,
          outputPerMillion: 5,
          cacheReadPerMillion: 0.25,
          cacheWritePerMillion: 1.25,
        },
      });
      actions.setUsageLimit({ duration: "60m", dollarAmount: 10 });
    });

    it("appends the full usage on the first call", async () => {
      mock.method(Date, "now", () => 1_000);

      await appendModelUsage({
        inputTokens: 100,
        outputTokens: 50,
        inputTokenDetails: {
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
        },
      } as LanguageModelUsage);

      const expectedUsage = {
        "gpt-4": [
          {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
            date: 1_000,
          },
        ],
      };
      assert.deepStrictEqual(
        getState().app.modelUsageForLimitWindow,
        expectedUsage,
      );
      assert.deepStrictEqual(
        getState().app.modelUsageForSession,
        expectedUsage,
      );
    });

    it("appends the full usage on subsequent calls", async () => {
      let now = 1_000;
      mock.method(Date, "now", () => now);

      await appendModelUsage({
        inputTokens: 100,
        outputTokens: 50,
        inputTokenDetails: {
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
        },
      } as LanguageModelUsage);

      now = 2_000;
      await appendModelUsage({
        inputTokens: 150,
        outputTokens: 80,
        inputTokenDetails: {
          cacheReadTokens: 20,
          cacheWriteTokens: 10,
        },
      } as LanguageModelUsage);

      const expectedUsage = {
        "gpt-4": [
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
        ],
      };
      assert.deepStrictEqual(
        getState().app.modelUsageForLimitWindow,
        expectedUsage,
      );
      assert.deepStrictEqual(
        getState().app.modelUsageForSession,
        expectedUsage,
      );
    });

    it("tracks different models separately", async () => {
      let now = 1_000;
      mock.method(Date, "now", () => now);

      await appendModelUsage({
        inputTokens: 100,
        outputTokens: 50,
        inputTokenDetails: {
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
        },
      } as LanguageModelUsage);

      now = 2_000;
      actions.setModel("claude");
      await appendModelUsage({
        inputTokens: 30,
        outputTokens: 15,
        inputTokenDetails: {
          cacheReadTokens: 3,
          cacheWriteTokens: 1,
        },
      } as LanguageModelUsage);

      const expectedUsage = {
        "gpt-4": [
          {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
            date: 1_000,
          },
        ],
        claude: [
          {
            inputTokens: 30,
            outputTokens: 15,
            cacheReadTokens: 3,
            cacheWriteTokens: 1,
            date: 2_000,
          },
        ],
      };
      assert.deepStrictEqual(
        getState().app.modelUsageForLimitWindow,
        expectedUsage,
      );
      assert.deepStrictEqual(
        getState().app.modelUsageForSession,
        expectedUsage,
      );
    });

    it("defaults missing token detail values to 0", async () => {
      mock.method(Date, "now", () => 1_000);

      await appendModelUsage({
        inputTokens: 100,
        outputTokens: 50,
        inputTokenDetails: {
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
      } as LanguageModelUsage);

      const expectedUsage = {
        "gpt-4": [
          {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            date: 1_000,
          },
        ],
      };
      assert.deepStrictEqual(
        getState().app.modelUsageForLimitWindow,
        expectedUsage,
      );
      assert.deepStrictEqual(
        getState().app.modelUsageForSession,
        expectedUsage,
      );
    });

    it("appends to session usage only when the usage limit is disabled", async () => {
      mock.method(Date, "now", () => 1_000);
      actions.setPricingPerModel({});
      actions.setUsageLimit(undefined);

      await appendModelUsage({
        inputTokens: 100,
        outputTokens: 50,
        inputTokenDetails: {
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
        },
      } as LanguageModelUsage);

      assert.deepStrictEqual(getState().app.modelUsageForSession, {
        "gpt-4": [
          {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
            date: 1_000,
          },
        ],
      });
      assert.deepStrictEqual(getState().app.modelUsageForLimitWindow, {});
      assert.strictEqual(testFs._files.has(getUsageLogPath()), false);
    });
  });

  describe("syncNewModelUsageForLimitWindow", () => {
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
      actions.setUsageLimit({ duration: "60m", dollarAmount: 10 });
      mock.method(Date, "now", () => 4_000_000);
    });

    it("creates the usage log directory and writes the usage entry", async () => {
      const usage = {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        date: 500_000,
      };

      await syncNewModelUsageForLimitWindow("gpt-4", usage);

      assert.deepStrictEqual(getState().app.modelUsageForLimitWindow, {
        "gpt-4": [usage],
      });
      assert.deepStrictEqual(getState().app.modelUsageForSession, {});
      assert.strictEqual(
        testFs._files.get(getUsageLogPath()),
        JSON.stringify({ "gpt-4": [usage] }),
      );
    });

    it("appends to an existing usage log", async () => {
      testFs._files.set(
        getUsageLogPath(),
        `{
  "gpt-4": [
    {
      "inputTokens": 5,
      "outputTokens": 2,
      "cacheReadTokens": 0,
      "cacheWriteTokens": 0,
      "date": 500000
    }
  ]
}`,
      );
      const usage = {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        date: 1_000_000,
      };

      await syncNewModelUsageForLimitWindow("gpt-4", usage);

      assert.deepStrictEqual(getState().app.modelUsageForLimitWindow, {
        "gpt-4": [
          {
            inputTokens: 5,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            date: 500_000,
          },
          usage,
        ],
      });
      assert.strictEqual(
        testFs._files.get(getUsageLogPath()),
        JSON.stringify({
          "gpt-4": [
            {
              inputTokens: 5,
              outputTokens: 2,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              date: 500_000,
            },
            usage,
          ],
        }),
      );
    });

    it("overwrites a malformed usage log with the new entry", async () => {
      testFs._files.set(getUsageLogPath(), "not-json");
      const usage = {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        date: 500_000,
      };

      await syncNewModelUsageForLimitWindow("gpt-4", usage);

      assert.deepStrictEqual(getState().app.modelUsageForLimitWindow, {
        "gpt-4": [usage],
      });
      assert.strictEqual(
        testFs._files.get(getUsageLogPath()),
        JSON.stringify({ "gpt-4": [usage] }),
      );
    });

    it("appends to state even when the write fails", async () => {
      const realWrite = testFs.writeFileSync;
      mock.method(fsDeps, "writeFileSync", (path: string, content: string) => {
        if (path === getUsageLogLockPath()) {
          realWrite(path, content);
          return;
        }
        throw new Error("write failed");
      });
      const usage = {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        date: 500_000,
      };

      await syncNewModelUsageForLimitWindow("gpt-4", usage);

      assert.deepStrictEqual(getState().app.modelUsageForLimitWindow, {
        "gpt-4": [usage],
      });
    });

    it("does nothing when the usage limit is disabled", async () => {
      actions.setPricingPerModel({});
      actions.setUsageLimit(undefined);
      const usage = {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        date: 1_000,
      };

      await syncNewModelUsageForLimitWindow("gpt-4", usage);

      assert.deepStrictEqual(getState().app.modelUsageForLimitWindow, {});
      assert.strictEqual(testFs._files.has(getUsageLogPath()), false);
    });

    it("does nothing when the model has no pricing configured", async () => {
      actions.setPricingPerModel({});
      const usage = {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        date: 500_000,
      };

      await syncNewModelUsageForLimitWindow("gpt-4", usage);

      assert.deepStrictEqual(getState().app.modelUsageForLimitWindow, {});
      assert.strictEqual(testFs._files.has(getUsageLogPath()), false);
    });

    it("filters expired entries from the log and state", async () => {
      testFs._files.set(
        getUsageLogPath(),
        JSON.stringify({
          "gpt-4": [
            {
              inputTokens: 5,
              outputTokens: 2,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              date: 500_000,
            },
            {
              inputTokens: 7,
              outputTokens: 3,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              date: 300_000,
            },
          ],
        }),
      );
      const usage = {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        date: 1_000_000,
      };

      await syncNewModelUsageForLimitWindow("gpt-4", usage);

      assert.deepStrictEqual(getState().app.modelUsageForLimitWindow, {
        "gpt-4": [
          {
            inputTokens: 5,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            date: 500_000,
          },
          usage,
        ],
      });
      assert.strictEqual(
        testFs._files.get(getUsageLogPath()),
        JSON.stringify({
          "gpt-4": [
            {
              inputTokens: 5,
              outputTokens: 2,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              date: 500_000,
            },
            usage,
          ],
        }),
      );
    });

    it("keeps usage exactly at the duration boundary", async () => {
      testFs._files.set(
        getUsageLogPath(),
        JSON.stringify({
          "gpt-4": [
            {
              inputTokens: 5,
              outputTokens: 2,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              date: 400_000,
            },
          ],
        }),
      );
      const usage = {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        date: 1_000_000,
      };

      await syncNewModelUsageForLimitWindow("gpt-4", usage);

      assert.deepStrictEqual(getState().app.modelUsageForLimitWindow, {
        "gpt-4": [
          {
            inputTokens: 5,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            date: 400_000,
          },
          usage,
        ],
      });
    });

    it("drops models whose entries are all expired", async () => {
      testFs._files.set(
        getUsageLogPath(),
        JSON.stringify({
          "gpt-4": [
            {
              inputTokens: 5,
              outputTokens: 2,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              date: 500_000,
            },
          ],
          claude: [
            {
              inputTokens: 5,
              outputTokens: 2,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              date: 100_000,
            },
          ],
        }),
      );
      const usage = {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        date: 1_000_000,
      };

      await syncNewModelUsageForLimitWindow("gpt-4", usage);

      assert.deepStrictEqual(getState().app.modelUsageForLimitWindow, {
        "gpt-4": [
          {
            inputTokens: 5,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            date: 500_000,
          },
          usage,
        ],
      });
    });
  });

  describe("syncInitialModelUsageForLimitWindow", () => {
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
      actions.setUsageLimit({ duration: "60m", dollarAmount: 10 });
    });

    it("does nothing when all usage limit options are undefined", async () => {
      actions.setPricingPerModel({});
      actions.setUsageLimit(undefined);

      await syncInitialModelUsageForLimitWindow();

      assert.deepStrictEqual(getState().app.modelUsageForLimitWindow, {});
    });

    it("does nothing when the model has no pricing configured", async () => {
      actions.setPricingPerModel({});
      testFs._dirs.add(dirname(getUsageLogPath()));
      testFs._files.set(
        getUsageLogPath(),
        JSON.stringify({
          "gpt-4": [
            {
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 1,
              cacheWriteTokens: 0,
              date: 500,
            },
          ],
        }),
      );

      await syncInitialModelUsageForLimitWindow();

      assert.deepStrictEqual(getState().app.modelUsageForLimitWindow, {});
      assert.strictEqual(testFs._files.has(getUsageLogPath()), true);
    });

    it("does nothing when the usage log directory does not exist", async () => {
      await syncInitialModelUsageForLimitWindow();

      assert.deepStrictEqual(getState().app.modelUsageForLimitWindow, {});
    });

    it("filters modelUsage according to each duration suffix", async () => {
      const now = 1_000_000_000;
      const cases = [
        ["100s", 100_000],
        ["10m", 600_000],
        ["2h", 7_200_000],
        ["3d", 259_200_000],
      ] as const;

      for (const [duration, windowMs] of cases) {
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
        actions.setUsageLimit({ duration, dollarAmount: 10 });
        const recent = {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
          date: now - windowMs + 1,
        };
        const expired = {
          inputTokens: 5,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          date: now - windowMs - 1,
        };
        testFs._dirs.add(dirname(getUsageLogPath()));
        testFs._files.set(
          getUsageLogPath(),
          JSON.stringify({ "gpt-4": [recent, expired] }),
        );
        mock.method(Date, "now", () => now);

        await syncInitialModelUsageForLimitWindow();

        assert.deepStrictEqual(getState().app.modelUsageForLimitWindow, {
          "gpt-4": [recent],
        });
        assert.strictEqual(
          testFs._files.get(getUsageLogPath()),
          JSON.stringify({ "gpt-4": [recent] }),
        );
      }
    });

    it("keeps modelUsage exactly at the duration boundary", async () => {
      const boundary = {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        date: 400_000,
      };
      testFs._dirs.add(dirname(getUsageLogPath()));
      testFs._files.set(
        getUsageLogPath(),
        JSON.stringify({ "gpt-4": [boundary] }),
      );
      mock.method(Date, "now", () => 4_000_000);

      await syncInitialModelUsageForLimitWindow();

      assert.deepStrictEqual(getState().app.modelUsageForLimitWindow, {
        "gpt-4": [boundary],
      });
      assert.strictEqual(
        testFs._files.get(getUsageLogPath()),
        JSON.stringify({ "gpt-4": [boundary] }),
      );
    });

    it("overwrites a malformed usage log with an empty object", async () => {
      testFs._dirs.add(dirname(getUsageLogPath()));
      testFs._files.set(getUsageLogPath(), "not-json");

      await syncInitialModelUsageForLimitWindow();

      assert.deepStrictEqual(getState().app.modelUsageForLimitWindow, {});
      assert.strictEqual(testFs._files.get(getUsageLogPath()), `{}`);
    });
  });

  describe("isUsageLimitDisabled", () => {
    beforeEach(() => {
      setupFakeDeps();
      actions.resetState();
    });

    it("returns true when the model has no pricing configured", () => {
      actions.setModel("unknown-model");
      assert.strictEqual(isUsageLimitDisabled(), true);
    });

    it("returns true when the usage limit is undefined", () => {
      actions.setModel("gpt-4");
      actions.setPricingPerModel({
        "gpt-4": {
          inputPerMillion: 1,
          outputPerMillion: 5,
        },
      });
      assert.strictEqual(isUsageLimitDisabled(), true);
    });

    it("returns false when pricing and usage limit are configured", () => {
      actions.setModel("gpt-4");
      actions.setPricingPerModel({
        "gpt-4": {
          inputPerMillion: 1,
          outputPerMillion: 5,
        },
      });
      actions.setUsageLimit({ duration: "60m", dollarAmount: 10 });
      assert.strictEqual(isUsageLimitDisabled(), false);
    });
  });

  describe("filterExpiredModelUsage", () => {
    it("returns an empty object for an empty map", () => {
      const result = filterExpiredModelUsage({}, 100);
      assert.deepStrictEqual(result, {});
    });

    it("keeps entries at or after the expired time and drops older ones", () => {
      const map = {
        "gpt-4": [
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
      const result = filterExpiredModelUsage(map, 150);
      assert.deepStrictEqual(result, {
        "gpt-4": [map["gpt-4"][1]],
      });
    });

    it("drops models whose entries are all expired", () => {
      const map = {
        "gpt-4": [
          {
            inputTokens: 1,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            date: 100,
          },
        ],
        claude: [
          {
            inputTokens: 2,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            date: 200,
          },
        ],
      };
      const result = filterExpiredModelUsage(map, 150);
      assert.deepStrictEqual(result, {
        claude: [map.claude[0]],
      });
    });
  });

  describe("getExpiredTime", () => {
    beforeEach(() => {
      setupFakeDeps();
      actions.resetState();
      mock.method(Date, "now", () => 1_000_000);
    });

    it("throws when the usage limit is undefined", () => {
      actions.setUsageLimit(undefined);
      assert.throws(() => getExpiredTime(), /usageLimit/);
    });

    it("computes the expired time for seconds", () => {
      actions.setUsageLimit({ duration: "100s", dollarAmount: 10 });
      assert.strictEqual(getExpiredTime(), 1_000_000 - 100_000);
    });

    it("computes the expired time for minutes", () => {
      actions.setUsageLimit({ duration: "10m", dollarAmount: 10 });
      assert.strictEqual(getExpiredTime(), 1_000_000 - 600_000);
    });

    it("computes the expired time for hours", () => {
      actions.setUsageLimit({ duration: "2h", dollarAmount: 10 });
      assert.strictEqual(getExpiredTime(), 1_000_000 - 7_200_000);
    });

    it("computes the expired time for days", () => {
      actions.setUsageLimit({ duration: "3d", dollarAmount: 10 });
      assert.strictEqual(getExpiredTime(), 1_000_000 - 259_200_000);
    });
  });
});
