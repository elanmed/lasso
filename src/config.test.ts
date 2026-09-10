import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { actions, getState } from "./state.ts";
import {
  initState,
  initStateFromConfig,
  initStateForDebug,
  initStateRepeatable,
  blockOnMissingConfig,
} from "./config.ts";
import { defaultConfig, DefaultedConfigSchema } from "./config-types.ts";
import { MISSING } from "./deps.ts";
import {
  getGlobalConfigPath,
  getLocalConfigPath,
  getGlobalContextDir,
  getUsageLogPath,
} from "./paths.ts";
import {
  testFs,
  testProcessEnv,
  setupApiCallState,
  setupTestContext,
  mockStdout,
  stripAnsi,
} from "./test-helpers.ts";
import { parseCliArgsDeps } from "./args.ts";
import { dirname } from "node:path";

const testConfig = {
  model: "claude-sonnet-4-6",
  baseURL: "https://api.example.com",
};

describe("config", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    mock.method(Date, "now", () => 0);
    setupTestContext();
    mock.method(parseCliArgsDeps, "getArgv", () => ["node", "script.js"]);
  });

  it("requires edit in the defaulted keymaps", () => {
    const result = DefaultedConfigSchema.safeParse({
      ...defaultConfig,
      keymaps: {},
    });
    assert.equal(result.success, false);
  });

  describe("when local config exists", () => {
    it("uses its model over the global config, default config", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          model: "claude-haiku-4-5",
        }),
      );

      await initState();

      assert.equal(getState().config.model, "claude-haiku-4-5");
    });

    it("uses its subagentModels over the global config, default config", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          subagentModels: ["global-model"],
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          subagentModels: ["local-model"],
        }),
      );

      await initState();

      assert.deepStrictEqual(getState().config.subagentModels, ["local-model"]);
      assert.deepStrictEqual(getState().app.subagentModels, ["local-model"]);
    });

    it("uses its sdkProvider over the global config, default config", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          model: testConfig.model,
          sdkProvider: "openai-compatible",
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          model: testConfig.model,
          sdkProvider: "anthropic",
        }),
      );

      await initState();

      assert.equal(getState().config.sdkProvider, "anthropic");
    });

    it("uses its gateway over the default config", async () => {
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          gateway: "opencode",
        }),
      );

      await initState();

      assert.equal(getState().config.gateway, "opencode");
    });

    it("leaves gateway undefined when not configured", async () => {
      testFs._files.set(getLocalConfigPath(), JSON.stringify(testConfig));

      await initState();

      assert.equal(getState().config.gateway, undefined);
    });

    it("merges its mcps with the global and default config", () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          mcps: {
            global: { type: "stdio", command: "global-mcp" },
            http: { type: "http", url: "https://global.example.com" },
          },
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          mcps: {
            http: {
              type: "http",
              url: "https://mcp.example.com",
              protocolVersion: "2025-03-26",
              headers: { Authorization: "Bearer token" },
            },
            sse: {
              type: "sse",
              url: "https://sse.example.com",
              protocolVersion: "2024-11-05",
            },
            stdio: {
              type: "stdio",
              command: "local-mcp",
              args: ["--debug"],
            },
          },
        }),
      );

      initStateFromConfig();

      assert.deepStrictEqual(getState().config.mcps, {
        global: { type: "stdio", command: "global-mcp" },
        http: {
          type: "http",
          url: "https://mcp.example.com",
          protocolVersion: "2025-03-26",
          headers: { Authorization: "Bearer token" },
        },
        sse: {
          type: "sse",
          url: "https://sse.example.com",
          protocolVersion: "2024-11-05",
        },
        stdio: {
          type: "stdio",
          command: "local-mcp",
          args: ["--debug"],
        },
      });
    });

    it("defaults mcps to an empty object", async () => {
      testFs._files.set(getLocalConfigPath(), JSON.stringify(testConfig));

      await initState();

      assert.deepStrictEqual(getState().config.mcps, {});
    });

    it("uses minimal local config without model over the global config", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          promptPrefix: ">>> ",
        }),
      );

      await initState();

      assert.equal(getState().config.model, testConfig.model);
      assert.equal(getState().config.promptPrefix, ">>> ");
    });

    it("merges pricingPerModel per model, local overriding global", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          model: "test-model",
          pricingPerModel: {
            "global-model": {
              inputPerMillion: 1,
              outputPerMillion: 2,
            },
            "shared-model": {
              inputPerMillion: 10,
              outputPerMillion: 20,
            },
          },
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          model: "test-model",
          pricingPerModel: {
            "local-model": {
              inputPerMillion: 3,
              outputPerMillion: 4,
            },
            "shared-model": {
              inputPerMillion: 30,
              outputPerMillion: 40,
            },
          },
        }),
      );

      await initState();

      assert.deepEqual(getState().config.pricingPerModel, {
        "global-model": {
          inputPerMillion: 1,
          outputPerMillion: 2,
        },
        "shared-model": {
          inputPerMillion: 30,
          outputPerMillion: 40,
        },
        "local-model": {
          inputPerMillion: 3,
          outputPerMillion: 4,
        },
      });
    });
    it("removes pricingPerModel entries set to null in the local config", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          pricingPerModel: {
            "kept-model": {
              inputPerMillion: 1,
              outputPerMillion: 2,
            },
            "cancelled-model": {
              inputPerMillion: 3,
              outputPerMillion: 4,
            },
          },
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          pricingPerModel: {
            "cancelled-model": null,
          },
        }),
      );

      await initState();

      assert.deepEqual(getState().config.pricingPerModel, {
        "kept-model": {
          inputPerMillion: 1,
          outputPerMillion: 2,
        },
      });
    });

    it("merges contextWindowPerModel per model, local overriding global", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          contextWindowPerModel: {
            "global-model": 100_000,
            "shared-model": 200_000,
          },
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          contextWindowPerModel: {
            "local-model": 300_000,
            "shared-model": 400_000,
          },
        }),
      );

      await initState();

      assert.deepEqual(getState().config.contextWindowPerModel, {
        "global-model": 100_000,
        "shared-model": 400_000,
        "local-model": 300_000,
      });
    });

    it("removes contextWindowPerModel entries set to null in the local config", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          contextWindowPerModel: {
            "kept-model": 100_000,
            "cancelled-model": 200_000,
          },
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          contextWindowPerModel: {
            "cancelled-model": null,
          },
        }),
      );

      await initState();

      assert.deepEqual(getState().config.contextWindowPerModel, {
        "kept-model": 100_000,
      });
    });

    it("uses its compactTriggerRatio over the global config, default config", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          compactTriggerRatio: 0.8,
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          compactTriggerRatio: 0.5,
        }),
      );

      await initState();

      assert.strictEqual(getState().config.compactTriggerRatio, 0.5);
    });

    it("uses its compactTargetRatio over the global config, default config", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          compactTargetRatio: 0.4,
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          compactTargetRatio: 0.25,
        }),
      );

      await initState();

      assert.strictEqual(getState().config.compactTargetRatio, 0.25);
    });

    it("uses its keymaps over the global config, default config", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          keymaps: {
            edit: { name: "v", ctrl: false, meta: false, shift: false },
            history: { name: "o", ctrl: false, meta: false, shift: false },
            clear: { name: "j", ctrl: false, meta: false, shift: false },
          },
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          keymaps: {
            edit: { name: "e", ctrl: true, meta: false, shift: false },
            history: { name: "l", ctrl: true, meta: false, shift: false },
            clear: { name: "k", ctrl: true, meta: false, shift: false },
            skills: { name: "s", ctrl: true, meta: false, shift: false },
          },
        }),
      );

      await initState();

      assert.deepEqual(getState().config.keymaps.edit, {
        name: "e",
        ctrl: true,
        meta: false,
        shift: false,
      });
      assert.deepEqual(getState().config.keymaps["history"], {
        name: "l",
        ctrl: true,
        meta: false,
        shift: false,
      });
      assert.deepEqual(getState().config.keymaps["clear"], {
        name: "k",
        ctrl: true,
        meta: false,
        shift: false,
      });
      assert.deepEqual(getState().config.keymaps["skills"], {
        name: "s",
        ctrl: true,
        meta: false,
        shift: false,
      });
    });

    it("uses its customSlashCommandDirs over the global config, default config", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          customSlashCommandDirs: ["/global-dir"],
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          customSlashCommandDirs: ["/local-dir"],
        }),
      );

      await initState();

      assert.deepStrictEqual(getState().config.customSlashCommandDirs, [
        "/local-dir",
      ]);
    });

    it("uses its customSkillDirs over the global config, default config", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          customSkillDirs: ["/global-skills"],
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          customSkillDirs: ["/local-skills"],
        }),
      );

      await initState();

      assert.deepStrictEqual(getState().config.customSkillDirs, [
        "/local-skills",
      ]);
    });

    it("uses its loadingStateFrames over the global config, default config", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          loadingStateFrames: ["⣾", "⣽", "⣻", "⢿"],
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          loadingStateFrames: ["⠋", "⠙", "⠹", "⠸"],
        }),
      );

      await initState();

      assert.deepStrictEqual(getState().config.loadingStateFrames, [
        "⠋",
        "⠙",
        "⠹",
        "⠸",
      ]);
    });

    it("uses its loadingStateFrameDuration over the global config, default config", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          loadingStateFrameDuration: 100,
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          loadingStateFrameDuration: 200,
        }),
      );

      await initState();

      assert.strictEqual(getState().config.loadingStateFrameDuration, 200);
    });

    it("uses its promptPrefix over the global config, default config", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          promptPrefix: "> ",
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          promptPrefix: "🤖 ",
        }),
      );

      await initState();

      assert.strictEqual(getState().config.promptPrefix, "🤖 ");
    });

    it("uses its suppressBatUnavailableWarning over the global config, default config", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          suppressBatUnavailableWarning: true,
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          suppressBatUnavailableWarning: false,
        }),
      );

      await initState();

      assert.strictEqual(
        getState().config.suppressBatUnavailableWarning,
        false,
      );
    });

    it("uses its messageQueueDelimiter over the global config, default config", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          messageQueueDelimiter: "g---\n",
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          messageQueueDelimiter: "L---\n",
        }),
      );

      await initState();

      assert.strictEqual(getState().config.messageQueueDelimiter, "L---\n");
    });

    it("rejects an empty messageQueueDelimiter", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          messageQueueDelimiter: "",
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
        }),
      );

      await assert.rejects(
        initState(),
        /Invalid string: must end with \\"\\n\\"/,
      );
    });

    it("rejects a messageQueueDelimiter not ending with a newline", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          messageQueueDelimiter: "g---",
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
        }),
      );

      await assert.rejects(
        initState(),
        /Invalid string: must end with \\"\\n\\"/,
      );
    });

    it("uses its usageLimit over the global config, default config", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          usageLimit: { duration: "2h", dollarAmount: 10 },
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          usageLimit: { duration: "60m", dollarAmount: 20 },
        }),
      );

      await initState();

      assert.deepStrictEqual(getState().config.usageLimit, {
        duration: "60m",
        dollarAmount: 20,
      });
    });

    it("falls back to global usageLimit when local omits it", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          usageLimit: { duration: "2h", dollarAmount: 10 },
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
        }),
      );

      await initState();

      assert.deepStrictEqual(getState().config.usageLimit, {
        duration: "2h",
        dollarAmount: 10,
      });
    });

    it("rejects config with an unknown key", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          contextPerModel: { "deepseek-v4-flash-free": 4000 },
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
        }),
      );

      await assert.rejects(initState(), /Unrecognized key/);
    });

    it("rejects usageLimit without duration", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          usageLimit: { dollarAmount: 10 },
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
        }),
      );

      await assert.rejects(initState(), /Invalid input: expected string/);
    });

    it("rejects usageLimit without dollarAmount", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          usageLimit: { duration: "2h" },
        }),
      );
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
        }),
      );

      await assert.rejects(initState(), /Invalid input: expected number/);
    });

    it("rejects non-string usageLimit.duration", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          usageLimit: { duration: 3_600_000, dollarAmount: 10 },
        }),
      );

      await assert.rejects(initState(), /Invalid input: expected string/);
    });

    it("rejects usageLimit.duration with an invalid suffix", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          usageLimit: { duration: "10x", dollarAmount: 10 },
        }),
      );

      await assert.rejects(
        initState(),
        /usageLimit\.duration must be of the format/,
      );
    });

    it("rejects usageLimit.duration without a suffix", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          usageLimit: { duration: "3600000", dollarAmount: 10 },
        }),
      );

      await assert.rejects(
        initState(),
        /usageLimit\.duration must be of the format/,
      );
    });

    it("rejects usageLimit.duration with a non-numeric prefix", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          usageLimit: { duration: "abch", dollarAmount: 10 },
        }),
      );

      await assert.rejects(
        initState(),
        /usageLimit\.duration must be of the format/,
      );
    });

    it("rejects usageLimit.duration with a negative prefix", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          usageLimit: { duration: "-2h", dollarAmount: 10 },
        }),
      );

      await assert.rejects(
        initState(),
        /usageLimit\.duration must be of the format/,
      );
    });

    it("rejects non-number usageLimit.dollarAmount", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          usageLimit: { duration: "2h", dollarAmount: "five" },
        }),
      );

      await assert.rejects(initState(), /Invalid input: expected number/);
    });

    it("rejects non-boolean suppressBatUnavailableWarning", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          suppressBatUnavailableWarning: "yes",
        }),
      );

      await assert.rejects(initState(), /Invalid input: expected boolean/);
    });

    it("rejects compactTriggerRatio above 1", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          compactTriggerRatio: 1.5,
        }),
      );

      await assert.rejects(initState(), /Too big: expected number to be <=1/);
    });

    it("rejects compactTriggerRatio below 0", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          compactTriggerRatio: -0.1,
        }),
      );

      await assert.rejects(initState(), /Too small: expected number to be >=0/);
    });

    it("rejects non-number compactTriggerRatio", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          compactTriggerRatio: "half",
        }),
      );

      await assert.rejects(initState(), /Invalid input: expected number/);
    });

    it("rejects compactTargetRatio above 1", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          compactTargetRatio: 1.5,
        }),
      );

      await assert.rejects(initState(), /Too big: expected number to be <=1/);
    });

    it("rejects compactTargetRatio below 0", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          compactTargetRatio: -0.1,
        }),
      );

      await assert.rejects(initState(), /Too small: expected number to be >=0/);
    });

    it("rejects non-number compactTargetRatio", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          compactTargetRatio: "half",
        }),
      );

      await assert.rejects(initState(), /Invalid input: expected number/);
    });

    it("rejects compactTriggerRatio equal to compactTargetRatio", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          compactTriggerRatio: 0.5,
          compactTargetRatio: 0.5,
        }),
      );

      await assert.rejects(
        initState(),
        /compactTriggerRatio \(0\.5\) must be greater than compactTargetRatio \(0\.5\)/,
      );
    });

    it("rejects compactTriggerRatio below compactTargetRatio", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          compactTriggerRatio: 0.3,
          compactTargetRatio: 0.5,
        }),
      );

      await assert.rejects(
        initState(),
        /compactTriggerRatio \(0\.3\) must be greater than compactTargetRatio \(0\.5\)/,
      );
    });

    it("merges partial keymaps with defaults", async () => {
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          keymaps: {
            edit: { name: "v", ctrl: false, meta: false, shift: false },
          },
        }),
      );

      await initState();

      assert.deepEqual(getState().config.keymaps.edit, {
        name: "v",
        ctrl: false,
        meta: false,
        shift: false,
      });
      assert.strictEqual(getState().config.keymaps["history"], undefined);
      assert.strictEqual(getState().config.keymaps["clear"], undefined);
    });

    it("rejects keymap bindings shared with the default config", async () => {
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          keymaps: {
            clear: { name: "g", ctrl: true },
          },
        }),
      );

      await assert.rejects(
        initState(),
        /keymaps must be unique: `edit` and `clear` are both bound to/,
      );
    });

    it("rejects duplicate keymap bindings within the same config", async () => {
      testFs._files.set(
        getLocalConfigPath(),
        JSON.stringify({
          ...testConfig,
          keymaps: {
            clear: { name: "x", ctrl: true },
            history: { name: "x", ctrl: true },
          },
        }),
      );

      await assert.rejects(
        initState(),
        /keymaps must be unique: `clear` and `history` are both bound to/,
      );
    });
  });

  describe("when local config does not exist", () => {
    describe("when the global config exists", () => {
      it("uses its model over the default config", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            model: "claude-haiku-4-5",
          }),
        );

        await initState();
        assert.equal(getState().config.model, "claude-haiku-4-5");
      });

      it("uses its sdkProvider over the default config", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            model: testConfig.model,
            sdkProvider: "anthropic",
          }),
        );

        await initState();
        assert.equal(getState().config.sdkProvider, "anthropic");
      });

      it("warns when baseURL is provided with anthropic sdkProvider", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            model: testConfig.model,
            sdkProvider: "anthropic",
            baseURL: "https://api.example.com",
          }),
        );

        const getCaptured = mockStdout();
        await initState();
        assert.strictEqual(
          stripAnsi(getCaptured()),
          "The `baseURL` option is not used when `sdkProvider=anthropic`\n",
        );
      });

      it("uses its pricingPerModel over the default config", async () => {
        const globalPricing = structuredClone(defaultConfig.pricingPerModel);
        globalPricing["test-model"] = {
          inputPerMillion: 999,
          outputPerMillion: 0,
          cacheReadPerMillion: 0,
          cacheWritePerMillion: 0,
        };

        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            model: "test-model",
            pricingPerModel: globalPricing,
            usageLimit: { duration: "60m", dollarAmount: 10 },
          }),
        );

        await initState();
        assert.deepEqual(getState().config.pricingPerModel, globalPricing);
      });

      it("uses its keymaps over the default config", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            keymaps: {
              edit: { name: "v", ctrl: false, meta: false, shift: false },
              history: {
                name: "o",
                ctrl: false,
                meta: false,
                shift: false,
              },
              clear: { name: "j", ctrl: false, meta: false, shift: false },
            },
          }),
        );

        await initState();

        assert.deepEqual(getState().config.keymaps.edit, {
          name: "v",
          ctrl: false,
          meta: false,
          shift: false,
        });
        assert.deepEqual(getState().config.keymaps["history"], {
          name: "o",
          ctrl: false,
          meta: false,
          shift: false,
        });
        assert.deepEqual(getState().config.keymaps["clear"], {
          name: "j",
          ctrl: false,
          meta: false,
          shift: false,
        });
      });

      it("uses its loadingStateFrames over the default config", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            loadingStateFrames: ["⣾", "⣽", "⣻", "⢿"],
          }),
        );

        await initState();

        assert.deepStrictEqual(getState().config.loadingStateFrames, [
          "⣾",
          "⣽",
          "⣻",
          "⢿",
        ]);
      });

      it("uses its loadingStateFrameDuration over the default config", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            loadingStateFrameDuration: 150,
          }),
        );

        await initState();

        assert.strictEqual(getState().config.loadingStateFrameDuration, 150);
      });

      it("uses its promptPrefix over the default config", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            promptPrefix: "❯ ",
          }),
        );

        await initState();

        assert.strictEqual(getState().config.promptPrefix, "❯ ");
      });

      it("uses its suppressBatUnavailableWarning over the default config", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            suppressBatUnavailableWarning: true,
          }),
        );

        await initState();

        assert.strictEqual(
          getState().config.suppressBatUnavailableWarning,
          true,
        );
      });

      it("uses its usageLimit over the default config", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            usageLimit: { duration: "2h", dollarAmount: 20 },
          }),
        );

        await initState();

        assert.deepStrictEqual(getState().config.usageLimit, {
          duration: "2h",
          dollarAmount: 20,
        });
      });

      it("uses undefined usageLimit when global config omits it", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
          }),
        );

        await initState();

        assert.strictEqual(getState().config.usageLimit, undefined);
      });

      it("uses its customSkillDirs over the default config", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            customSkillDirs: ["/global-skills"],
          }),
        );

        await initState();

        assert.deepStrictEqual(getState().config.customSkillDirs, [
          "/global-skills",
        ]);
      });
    });

    describe("when the global config does not exist", () => {
      it("defaults to MISSING when not configured", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({ baseURL: "https://api.example.com" }),
        );
        await initState();
        assert.strictEqual(getState().config.model, MISSING);
      });

      it("throws when baseURL is not configured for openai-compatible sdkProvider", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            model: "some-model",
            sdkProvider: "openai-compatible",
          }),
        );
        await assert.rejects(
          initState(),
          /A `baseURL` is required when `sdkProvider=openai-compatible`/,
        );
      });
    });
  });

  it("throws when loadingStateFrames have unequal lengths", async () => {
    testFs._files.set(
      getGlobalConfigPath(),
      JSON.stringify({
        ...testConfig,
        loadingStateFrames: ["..", "...", ".."],
      }),
    );

    await assert.rejects(
      initState(),
      /All loadingStateFrames strings must be the same length/,
    );
  });

  it("throws when loadingStateFrames has fewer than 2 entries", async () => {
    testFs._files.set(
      getGlobalConfigPath(),
      JSON.stringify({
        ...testConfig,
        loadingStateFrames: [".."],
      }),
    );

    await assert.rejects(
      initState(),
      /loadingStateFrames must be at least length 2/,
    );
  });

  it("throws when loadingStateFrames is empty", async () => {
    testFs._files.set(
      getGlobalConfigPath(),
      JSON.stringify({
        ...testConfig,
        loadingStateFrames: [],
      }),
    );

    await assert.rejects(
      initState(),
      /loadingStateFrames must be at least length 2/,
    );
  });

  it("accepts loadingStateFrames with equal-length entries", async () => {
    testFs._files.set(
      getGlobalConfigPath(),
      JSON.stringify({
        ...testConfig,
        loadingStateFrames: ["..", "..", ".."],
      }),
    );

    await initState();
    assert.deepStrictEqual(getState().config.loadingStateFrames, [
      "..",
      "..",
      "..",
    ]);
  });

  it("throws on invalid YAML in global config", async () => {
    testFs._files.set(getGlobalConfigPath(), "key: [unclosed");

    await assert.rejects(
      initState(),
      /`\/fake-home\/\.config\/lasso\/settings\.yaml` is invalid YAML!/,
    );
  });

  it("throws on invalid YAML in local config", async () => {
    testFs._files.set(getLocalConfigPath(), "key: [unclosed");

    await assert.rejects(
      initState(),
      /`\/test-cwd\/\.lasso\/settings\.yaml` is invalid YAML!/,
    );
  });

  it("throws on invalid global config option", async () => {
    testFs._files.set(
      getGlobalConfigPath(),
      JSON.stringify({
        ...testConfig,
        invalidOption: true,
      }),
    );

    await assert.rejects(
      initState(),
      /Config at `\/fake-home\/\.config\/lasso\/settings\.yaml` has an invalid option!/,
    );
  });

  it("throws on invalid local config option", async () => {
    testFs._files.set(
      getLocalConfigPath(),
      JSON.stringify({
        ...testConfig,
        invalidOption: true,
      }),
    );

    await assert.rejects(
      initState(),
      /Config at `\/test-cwd\/\.lasso\/settings\.yaml` has an invalid option!/,
    );
  });

  it("sets debug from args", async () => {
    mock.method(parseCliArgsDeps, "getArgv", () => [
      "node",
      "script.js",
      "--debug",
    ]);
    testFs._files.set(
      getGlobalConfigPath(),
      JSON.stringify({
        ...testConfig,
      }),
    );

    await initState();
    assert.equal(getState().app.debugLog, true);
  });

  it("sets contextStr from dep", async () => {
    testFs._dirs.add(getGlobalContextDir());
    testFs._gitLsFilesResults.set("**/AGENTS.md", [
      "/fake-home/.config/lasso/context/AGENTS.md",
    ]);
    testFs._files.set("/fake-home/.config/lasso/context/AGENTS.md", "hello");
    testFs._files.set(
      getGlobalConfigPath(),
      JSON.stringify({
        ...testConfig,
      }),
    );

    await initState();
    assert.equal(
      getState().app.contextStr,
      `# [lasso] AGENTS.md context files

## Path: /fake-home/.config/lasso/context/AGENTS.md

hello
`,
    );
  });

  it("sets local and global config strings from dep", async () => {
    testFs._files.set(
      getGlobalConfigPath(),
      JSON.stringify({ model: "gpt-4" }),
    );
    testFs._files.set(
      getLocalConfigPath(),
      JSON.stringify({ model: "gpt-4", sdkProvider: "anthropic" }),
    );

    await initState();
    assert.equal(
      getState().app.globalConfigStr,
      JSON.stringify({ model: "gpt-4" }),
    );
    assert.equal(
      getState().app.localConfigStr,
      JSON.stringify({ model: "gpt-4", sdkProvider: "anthropic" }),
    );
  });

  it("sets missing local config string from dep to {}", async () => {
    testFs._files.set(
      getGlobalConfigPath(),
      JSON.stringify({
        ...testConfig,
      }),
    );

    await initState();
    assert.equal(getState().app.localConfigStr, "{}");
  });

  it("sets skillsStr from dep", async () => {
    testFs._files.set(
      getGlobalConfigPath(),
      JSON.stringify({
        ...testConfig,
      }),
    );

    await initState();
    assert.equal(getState().app.skillsStr, "");
  });

  it("sets modelUsageForLimitWindow to an empty object", async () => {
    testFs._files.set(
      getGlobalConfigPath(),
      JSON.stringify({
        ...testConfig,
      }),
    );

    await initState();
    assert.deepStrictEqual(getState().app.modelUsageForLimitWindow, {});
    assert.deepStrictEqual(getState().app.modelUsageForSession, {});
  });

  it("loads recent model usages from the usage log", async () => {
    const recent = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
      date: 500_000,
    };
    const expired = {
      inputTokens: 5,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      date: 300_000,
    };
    testFs._dirs.add(dirname(getUsageLogPath()));
    testFs._files.set(
      getUsageLogPath(),
      JSON.stringify({ "gpt-4": [recent, expired] }),
    );
    testFs._files.set(
      getGlobalConfigPath(),
      JSON.stringify({
        ...testConfig,
        usageLimit: { duration: "60m", dollarAmount: 10 },
        pricingPerModel: {
          "claude-sonnet-4-6": {
            inputPerMillion: 3,
            outputPerMillion: 15,
            cacheReadPerMillion: 0.75,
            cacheWritePerMillion: 3.75,
          },
        },
      }),
    );
    mock.method(Date, "now", () => 4_000_000);

    await initState();

    assert.deepStrictEqual(getState().app.modelUsageForLimitWindow, {
      "gpt-4": [recent],
    });
  });

  it("preserves the initialized sessionStartDate", async () => {
    const sessionStartDate = getState().app.sessionStartDate;
    testFs._files.set(
      getGlobalConfigPath(),
      JSON.stringify({
        ...testConfig,
      }),
    );

    await initState();
    assert.strictEqual(getState().app.sessionStartDate, sessionStartDate);
  });

  it("sets debug log path", async () => {
    testFs._files.set(
      getGlobalConfigPath(),
      JSON.stringify({
        ...testConfig,
      }),
    );

    await initState();
    assert.strictEqual(
      getState().app.debugLogPath,
      "/fake-home/.config/lasso/debug/debug-test-uuid.log",
    );
  });

  describe("initStateForDebug", () => {
    it("sets debug flag when --debug is passed", () => {
      mock.method(parseCliArgsDeps, "getArgv", () => [
        "node",
        "script.js",
        "--debug",
      ]);

      initStateForDebug();

      assert.strictEqual(getState().app.debugLog, true);
    });
    it("keeps debug flag off when --debug is not passed", () => {
      initStateForDebug();

      assert.strictEqual(getState().app.debugLog, false);
    });
  });

  describe("initStateRepeatable", () => {
    it("updates config and context without resetting session start date", async () => {
      const sessionStartDate = getState().app.sessionStartDate;
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
        }),
      );

      await initState();
      assert.strictEqual(getState().app.sessionStartDate, sessionStartDate);

      const globalConfigStr = JSON.stringify({
        ...testConfig,
        model: "claude-haiku-4-5",
      });
      testFs._files.set(getGlobalConfigPath(), globalConfigStr);

      await initStateRepeatable();

      assert.strictEqual(getState().app.sessionStartDate, sessionStartDate);
      assert.strictEqual(getState().app.globalConfigStr, globalConfigStr);
      assert.strictEqual(getState().config.model, "claude-haiku-4-5");
    });

    it("does not reset the session start date or debug log path", async () => {
      const sessionStartDate = getState().app.sessionStartDate;
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
        }),
      );

      await initStateRepeatable();

      assert.strictEqual(getState().app.sessionStartDate, sessionStartDate);
      assert.strictEqual(getState().app.debugLogPath, "");
    });
  });

  describe("blockOnMissingConfig", () => {
    beforeEach(() => {
      setupApiCallState();
      actions.setBaseURL("https://api.anthropic.com");
      actions.setModel("claude-sonnet-4-20250514");
    });

    it("returns false when api key, baseURL, and model are set", () => {
      const getCaptured = mockStdout();
      assert.strictEqual(blockOnMissingConfig(), false);
      assert.strictEqual(getCaptured(), "");
    });

    it("returns true and suggests the init slash commands when nothing is set", () => {
      actions.resetState();
      testProcessEnv._clear();
      const getCaptured = mockStdout();
      assert.strictEqual(blockOnMissingConfig(), true);
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `Warning! You're missing required configuration options.
- Set the \`LASSO_API_KEY\` environment variable, e.g. \`export LASSO_API_KEY=...\`
- Set \`sdkProvider\` in your config file (\`openai-compatible\` or \`anthropic\`)
- Set \`model\` in your config file

Run /initlocal or /initglobal to generate a sample config in \`./.lasso\` or \`~/.local/config/lasso\` respectively.
`,
      );
    });

    it("only mentions the missing api key when baseURL and model are set", () => {
      testProcessEnv._clear();
      const getCaptured = mockStdout();
      assert.strictEqual(blockOnMissingConfig(), true);
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `Warning! You're missing required configuration options.
- Set the \`LASSO_API_KEY\` environment variable, e.g. \`export LASSO_API_KEY=...\`
`,
      );
    });
  });
});
