import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import { dirname } from "node:path";
import type { LanguageModelUsage } from "ai";
import {
  ModelUsageSchema,
  filterExpiredModelUsage,
  getUsageMoneyForModel,
  sumUsageTokens,
  appendModelUsage,
  getExpiredTime,
  isUsageLimitDisabled,
  syncInitialModelUsageForLimitWindow,
  syncNewModelUsageForLimitWindow,
  getPrettyTokenUsage,
} from "./usage.ts";

import { actions, getState } from "./state.ts";
import { getUsageLogLockPath, getUsageLogPath } from "./paths.ts";
import {
  setupTestContext,
  testFs,
  mockStdoutWrites,
  RESET,
  RED,
  makeErrnoError,
} from "./test-helpers.ts";
import { fsDeps } from "./deps.ts";

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

describe("usage", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe("appendModelUsage", () => {
    beforeEach(() => {
      setupTestContext();
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
        getState().usage.modelUsageForLimitWindow,
        expectedUsage,
      );
      assert.deepStrictEqual(
        getState().usage.modelUsageForSession,
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
        getState().usage.modelUsageForLimitWindow,
        expectedUsage,
      );
      assert.deepStrictEqual(
        getState().usage.modelUsageForSession,
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
        getState().usage.modelUsageForLimitWindow,
        expectedUsage,
      );
      assert.deepStrictEqual(
        getState().usage.modelUsageForSession,
        expectedUsage,
      );
    });

    it("skips the limit window for a model argument without pricing", async () => {
      mock.method(Date, "now", () => 1_000);

      await appendModelUsage(
        {
          inputTokens: 30,
          outputTokens: 15,
          inputTokenDetails: {
            cacheReadTokens: 3,
            cacheWriteTokens: 1,
          },
        } as LanguageModelUsage,
        "unpriced",
      );

      assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {});
      assert.deepStrictEqual(getState().usage.modelUsageForSession, {
        unpriced: [
          {
            inputTokens: 30,
            outputTokens: 15,
            cacheReadTokens: 3,
            cacheWriteTokens: 1,
            date: 1_000,
          },
        ],
      });
    });

    it("records session usage under the model argument when it differs from the configured model", async () => {
      mock.method(Date, "now", () => 1_000);

      await appendModelUsage(
        {
          inputTokens: 30,
          outputTokens: 15,
          inputTokenDetails: {
            cacheReadTokens: 3,
            cacheWriteTokens: 1,
          },
        } as LanguageModelUsage,
        "claude",
      );

      const expectedUsage = {
        claude: [
          {
            inputTokens: 30,
            outputTokens: 15,
            cacheReadTokens: 3,
            cacheWriteTokens: 1,
            date: 1_000,
          },
        ],
      };
      assert.deepStrictEqual(
        getState().usage.modelUsageForSession,
        expectedUsage,
      );
      assert.deepStrictEqual(
        getState().usage.modelUsageForLimitWindow,
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
        getState().usage.modelUsageForLimitWindow,
        expectedUsage,
      );
      assert.deepStrictEqual(
        getState().usage.modelUsageForSession,
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

      assert.deepStrictEqual(getState().usage.modelUsageForSession, {
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
      assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {});
      assert.strictEqual(testFs._files.has(getUsageLogPath()), false);
    });
  });

  describe("syncNewModelUsageForLimitWindow", () => {
    beforeEach(() => {
      setupTestContext();
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

    describe("writes the usage log", () => {
      it("creates the usage log directory and writes the usage entry", async () => {
        const usage = {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
          date: 500_000,
        };

        await syncNewModelUsageForLimitWindow("gpt-4", usage);

        assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {
          "gpt-4": [usage],
        });
        assert.deepStrictEqual(getState().usage.modelUsageForSession, {});
        assert.strictEqual(
          testFs._files.get(getUsageLogPath()),
          JSON.stringify({ "gpt-4": [usage] }),
        );
      });

      it("warns and preserves state when the usage log directory cannot be created", async () => {
        mock.method(fsDeps, "existsSync", () => false);
        mock.method(fsDeps, "mkdir", () =>
          Promise.reject(new Error("Permission denied")),
        );
        const getWrites = mockStdoutWrites();
        const usage = {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
          date: 500_000,
        };

        await syncNewModelUsageForLimitWindow("gpt-4", usage);

        assert.deepStrictEqual(getWrites(), [
          `${RED}Failed to create the directory: ${dirname(getUsageLogPath())}${RESET}\n`,
        ]);
        assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {});
        assert.strictEqual(testFs._files.has(getUsageLogPath()), false);
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

        assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {
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

      it("serializes concurrent same-process calls and keeps every usage", async () => {
        testFs._dirs.add(dirname(getUsageLogPath()));
        const firstUsage = {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
          date: 1_000_000,
        };
        const secondUsage = {
          inputTokens: 20,
          outputTokens: 8,
          cacheReadTokens: 2,
          cacheWriteTokens: 0,
          date: 2_000_000,
        };
        await Promise.all([
          syncNewModelUsageForLimitWindow("gpt-4", firstUsage),
          syncNewModelUsageForLimitWindow("gpt-4", secondUsage),
        ]);

        assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {
          "gpt-4": [firstUsage, secondUsage],
        });
        assert.strictEqual(
          testFs._files.get(getUsageLogPath()),
          JSON.stringify({ "gpt-4": [firstUsage, secondUsage] }),
        );
      });

      it("prints the error and overwrites a malformed usage log with the new entry", async () => {
        testFs._files.set(getUsageLogPath(), "not-json");
        const getWrites = mockStdoutWrites();
        const usage = {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
          date: 500_000,
        };

        await syncNewModelUsageForLimitWindow("gpt-4", usage);

        assert.deepStrictEqual(getWrites(), [
          `${RED}Failed to parse the usage log at /fake-home/.local/share/lasso/usage.json. Error: Unexpected token 'o', "not-json" is not valid JSON${RESET}\n`,
        ]);
        assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {
          "gpt-4": [usage],
        });
        assert.strictEqual(
          testFs._files.get(getUsageLogPath()),
          JSON.stringify({ "gpt-4": [usage] }),
        );
      });

      it("prints the error and appends the new entry when the usage log cannot be read", async () => {
        testFs._files.set("/fake-home/.local/share/lasso/usage.json", "{}");
        mock.method(fsDeps, "readFile", () =>
          Promise.reject(makeErrnoError("EIO")),
        );
        const getWrites = mockStdoutWrites();
        const usage = {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
          date: 500_000,
        };

        await syncNewModelUsageForLimitWindow("gpt-4", usage);

        assert.deepStrictEqual(getWrites(), [
          `${RED}Failed to read the usage log at /fake-home/.local/share/lasso/usage.json. Error: EIO${RESET}\n`,
        ]);
        assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {
          "gpt-4": [usage],
        });
      });

      it("prints the error and does nothing when the usage log directory cannot be checked", async () => {
        mock.method(fsDeps, "existsSync", () => {
          throw makeErrnoError("EACCES");
        });
        const getWrites = mockStdoutWrites();
        const usage = {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
          date: 500_000,
        };

        await syncNewModelUsageForLimitWindow("gpt-4", usage);

        assert.deepStrictEqual(getWrites(), [
          `${RED}Failed to check if /fake-home/.local/share/lasso exists. Error: EACCES${RESET}\n`,
        ]);
        assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {});
        assert.strictEqual(
          testFs._files.has("/fake-home/.local/share/lasso/usage.json"),
          false,
        );
      });

      it("prints the error and appends the new entry when the usage log existence cannot be checked", async () => {
        const realExistsSync = fsDeps.existsSync;
        mock.method(fsDeps, "existsSync", (path: string) => {
          if (path === "/fake-home/.local/share/lasso/usage.json")
            throw makeErrnoError("EACCES");
          return realExistsSync(path);
        });
        const getWrites = mockStdoutWrites();
        const usage = {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
          date: 500_000,
        };

        await syncNewModelUsageForLimitWindow("gpt-4", usage);

        assert.deepStrictEqual(getWrites(), [
          `${RED}Failed to check if /fake-home/.local/share/lasso/usage.json exists. Error: EACCES${RESET}\n`,
        ]);
        assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {
          "gpt-4": [usage],
        });
      });

      it("appends to state even when the write fails", async () => {
        const realWrite = testFs.writeFile;
        mock.method(fsDeps, "writeFile", (path: string, content: string) => {
          if (path === getUsageLogLockPath()) {
            realWrite(path, content);
            return;
          }
          return Promise.reject(new Error("write failed"));
        });
        const usage = {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
          date: 500_000,
        };

        await syncNewModelUsageForLimitWindow("gpt-4", usage);

        assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {
          "gpt-4": [usage],
        });
      });
    });

    describe("does nothing", () => {
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

        assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {});
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

        assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {});
        assert.strictEqual(testFs._files.has(getUsageLogPath()), false);
      });
    });

    describe("expires old entries", () => {
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

        assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {
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

        assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {
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

        assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {
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
  });

  describe("syncInitialModelUsageForLimitWindow", () => {
    beforeEach(() => {
      setupTestContext();
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

      assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {});
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

      assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {});
      assert.strictEqual(testFs._files.has(getUsageLogPath()), true);
    });

    it("does nothing when the usage log directory does not exist", async () => {
      await syncInitialModelUsageForLimitWindow();

      assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {});
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

        assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {
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

      assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {
        "gpt-4": [boundary],
      });
      assert.strictEqual(
        testFs._files.get(getUsageLogPath()),
        JSON.stringify({ "gpt-4": [boundary] }),
      );
    });

    it("prints the error and does nothing when the usage log directory cannot be checked", async () => {
      mock.method(fsDeps, "existsSync", () => {
        throw makeErrnoError("EACCES");
      });
      const getWrites = mockStdoutWrites();

      await syncInitialModelUsageForLimitWindow();

      assert.deepStrictEqual(getWrites(), [
        `${RED}Failed to check if /fake-home/.local/share/lasso exists. Error: EACCES${RESET}\n`,
      ]);
      assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {});
      assert.strictEqual(
        testFs._files.has("/fake-home/.local/share/lasso/usage.json"),
        false,
      );
    });

    it("prints the error and releases the lock when the usage log existence cannot be checked", async () => {
      testFs._dirs.add("/fake-home/.local/share/lasso");
      const realExistsSync = fsDeps.existsSync;
      mock.method(fsDeps, "existsSync", (path: string) => {
        if (path === "/fake-home/.local/share/lasso/usage.json")
          throw makeErrnoError("EACCES");
        return realExistsSync(path);
      });
      const getWrites = mockStdoutWrites();

      await syncInitialModelUsageForLimitWindow();

      assert.deepStrictEqual(getWrites(), [
        `${RED}Failed to check if /fake-home/.local/share/lasso/usage.json exists. Error: EACCES${RESET}\n`,
      ]);
      assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {});
      assert.strictEqual(testFs._files.has(getUsageLogLockPath()), false);
    });

    it("does not print an error when the usage log does not exist", async () => {
      testFs._dirs.add("/fake-home/.local/share/lasso");
      const getWrites = mockStdoutWrites();

      await syncInitialModelUsageForLimitWindow();

      assert.deepStrictEqual(getWrites(), []);
      assert.strictEqual(
        testFs._files.get("/fake-home/.local/share/lasso/usage.json"),
        `{}`,
      );
    });

    it("prints the error and overwrites a malformed usage log with an empty object", async () => {
      testFs._dirs.add(dirname(getUsageLogPath()));
      testFs._files.set(getUsageLogPath(), "not-json");
      const getWrites = mockStdoutWrites();

      await syncInitialModelUsageForLimitWindow();

      assert.deepStrictEqual(getWrites(), [
        `${RED}Failed to parse the usage log at /fake-home/.local/share/lasso/usage.json. Error: Unexpected token 'o', "not-json" is not valid JSON${RESET}\n`,
      ]);
      assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {});
      assert.strictEqual(testFs._files.get(getUsageLogPath()), `{}`);
      assert.strictEqual(testFs._files.has(getUsageLogLockPath()), false);
    });

    it("prints the error and overwrites an unreadable usage log with an empty object and releases the lock", async () => {
      testFs._dirs.add(dirname(getUsageLogPath()));
      testFs._files.set("/fake-home/.local/share/lasso/usage.json", "{}");
      mock.method(fsDeps, "readFile", () =>
        Promise.reject(makeErrnoError("EIO")),
      );
      const getWrites = mockStdoutWrites();

      await syncInitialModelUsageForLimitWindow();

      assert.deepStrictEqual(getWrites(), [
        `${RED}Failed to read the usage log at /fake-home/.local/share/lasso/usage.json. Error: EIO${RESET}\n`,
      ]);
      assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {});
      assert.strictEqual(testFs._files.get(getUsageLogPath()), `{}`);
      assert.strictEqual(testFs._files.has(getUsageLogLockPath()), false);
    });
  });

  describe("isUsageLimitDisabled", () => {
    beforeEach(() => {
      setupTestContext();
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

    it("checks the model argument instead of the configured model", () => {
      actions.setModel("gpt-4");
      actions.setPricingPerModel({
        claude: {
          inputPerMillion: 1,
          outputPerMillion: 5,
        },
      });
      actions.setUsageLimit({ duration: "60m", dollarAmount: 10 });
      assert.strictEqual(isUsageLimitDisabled("claude"), false);
      assert.strictEqual(isUsageLimitDisabled("gpt-4"), true);
    });
  });

  describe("getExpiredTime", () => {
    beforeEach(() => {
      setupTestContext();
      mock.method(Date, "now", () => 1_000_000);
    });

    it("throws when the usage limit is undefined", () => {
      actions.setUsageLimit(undefined);
      assert.throws(() => getExpiredTime());
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

describe("usage-format", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe("getPrettyTokenUsage", () => {
    beforeEach(() => {
      setupTestContext();
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

    describe("calculates costs", () => {
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
    });

    describe("usage limits", () => {
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
    });

    describe("totals and formatting", () => {
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
  });

  describe("getPrettyTokenUsage no pricing configured", () => {
    beforeEach(() => {
      setupTestContext();
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
