import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { initMcpState } from "./mcp.ts";
import { actions, getState } from "./state.ts";
import { defaultConfig, MISSING } from "./schemas.ts";
import { stringify } from "./utils.ts";
import {
  makeFakeMcpClient,
  makeFakeRl,
  makeStartupPerformanceLogger,
  setupTestContext,
  testFs,
} from "./test-helpers.ts";

describe("state", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext({ model: null, sdkProvider: null });
  });

  describe("initial and reset state", () => {
    it("reset-state writes debug-log entry using pre-reset debug settings", async () => {
      const debugLogPath = "/fake-home/.config/lasso/debug/debug-test-uuid.log";
      testFs._dirs.add("/fake-home/.config/lasso/debug");
      testFs._files.set(debugLogPath, "");
      actions.debug.setLogPath(debugLogPath);
      actions.debug.setLog(true);
      actions.abortControllers.setQuestion(new AbortController());
      actions.resetState();
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(
        testFs._files.get(debugLogPath),
        `1970-01-01T00:00:00.000Z :: dispatch set-question-abort-controller: before=null, after=[object AbortController]
1970-01-01T00:00:00.000Z :: dispatch reset-state: before=[truncating], after=${stringify(getState())}
`,
      );
    });

    const assertInitialState = () => {
      assert.equal(getState().debug.debugLog, false);
      assert.equal(getState().debug.debugLogPath, "");
      assert.equal(getState().session.sessionFilePath, "");
      assert.equal(getState().session.sessionStartDate, 0);
      assert.equal(getState().session.sessionId, "test-uuid");
      assert.deepStrictEqual(getState().conversation.messages, []);
      assert.deepStrictEqual(getState().conversation.summaries, []);
      assert.deepStrictEqual(getState().conversation.transcript, []);
      assert.deepStrictEqual(getState().conversation.toolEditDiffs, []);
      assert.deepStrictEqual(getState().usage.requestInputTokens, {
        value: 0,
        stale: true,
        charLength: 0,
      });
      assert.deepStrictEqual(getState().usage.modelUsageForSession, {});
      assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {});
      assert.strictEqual(getState().usage.apiStartTime, null);
      assert.strictEqual(getState().usage.apiEndTime, null);
      assert.deepStrictEqual(getState().content.contextEntries, []);
      assert.strictEqual(getState().content.contextStr, "");
      assert.strictEqual(getState().content.globalConfigStr, "");
      assert.strictEqual(getState().content.localConfigStr, "");
      assert.strictEqual(getState().content.skillsStr, "");
      assert.deepStrictEqual(getState().content.skills, []);
      assert.deepStrictEqual(getState().content.subagentModels, []);
      assert.deepStrictEqual(getState().content.slashCommands, []);
      assert.deepStrictEqual(getState().content.configWarningMessages, []);
      assert.strictEqual(getState().content.batAvailable, false);
      assert.strictEqual(getState().terminal.bufferedStdoutWhileEditorOpen, "");
      assert.strictEqual(getState().terminal.editorInputValue, null);
      assert.strictEqual(getState().terminal.isInitializing, false);
      assert.strictEqual(
        getState().terminal.isNonBlockingProcessOngoing,
        false,
      );
      assert.strictEqual(getState().terminal.isRecording, false);
      assert.strictEqual(getState().terminal.isSteering, false);
      assert.strictEqual(
        getState().terminal.bufferedInputWhileInitializing,
        "",
      );
      assert.strictEqual(getState().terminal.stdoutTail, "");
      assert.strictEqual(getState().terminal.rl, null);
      assert.strictEqual(getState().terminal.loadingStateTimeout, null);
      assert.strictEqual(getState().terminal.loadingStateFrameIdx, 0);
      assert.deepStrictEqual(getState().config, {
        model: MISSING,
        baseURL: undefined,
        sdkProvider: MISSING,
        transcriptionSdkProvider: undefined,
        transcriptionModel: undefined,
        transcriptionBaseURL: undefined,
        gateway: undefined,
        pricingPerModel: structuredClone(defaultConfig.pricingPerModel),
        contextWindowPerModel: structuredClone(
          defaultConfig.contextWindowPerModel,
        ),
        keymaps: structuredClone(defaultConfig.keymaps),
        customSlashCommandDirs: structuredClone(
          defaultConfig.customSlashCommandDirs,
        ),
        customSkillDirs: structuredClone(defaultConfig.customSkillDirs),
        subagentModels: structuredClone(defaultConfig.subagentModels),
        loadingStateFrameDuration: defaultConfig.loadingStateFrameDuration,
        loadingStateFrames: structuredClone(defaultConfig.loadingStateFrames),
        promptPrefix: defaultConfig.promptPrefix,
        suppressConfigWarnings: defaultConfig.suppressConfigWarnings,
        asciiOnly: defaultConfig.asciiOnly,
        suppressStartupDurations: defaultConfig.suppressStartupDurations,
        suppressToolEditDiffs: defaultConfig.suppressToolEditDiffs,
        compactWithStructuredOutput: defaultConfig.compactWithStructuredOutput,
        messageQueueDelimiter: defaultConfig.messageQueueDelimiter,
        reasoning: defaultConfig.reasoning,
        mcps: structuredClone(defaultConfig.mcps),
        usageLimit: undefined,
      });
      assert.deepStrictEqual(getState().mcp.clients, {});
      assert.deepStrictEqual(getState().mcp.tools, {});
      assert.deepStrictEqual(getState().abortControllers, {
        question: null,
        apiStream: null,
        executeUserInput: null,
        interruptWithEditorContent: null,
        recordProcess: null,
        transcription: null,
      });
    };

    it("resetState restores initial state after mutations", () => {
      actions.conversation.setMessages([{ role: "user", content: "hi" }]);
      actions.usage.setRequestInputTokens(7);
      actions.usage.setRequestInputTokensStale(true);
      actions.terminal.setEditorInputValue("draft");
      actions.terminal.setIsInitializing(true);
      actions.terminal.setIsSteering(true);
      actions.terminal.appendBufferedInputWhileInitializing("buffered");
      actions.content.setSlashCommands([
        {
          name: "custom",
          filePath: "/test-cwd/.lasso/commands/custom.md",
          content: "custom command content",
        },
      ]);
      actions.terminal.appendStdoutTail("out\n");
      actions.debug.setLog(true);
      actions.debug.setLogPath("/fake-home/lasso/debug.log");
      actions.content.setContextEntries([
        { filePath: "/a/AGENTS.md", content: "A" },
      ]);
      actions.content.setContextStr("# context");
      actions.content.setGlobalConfigStr("global");
      actions.content.setLocalConfigStr("local");
      actions.content.setSkillsStr("skills");
      actions.content.setSkills([
        {
          name: "demo",
          description: "a demo skill",
          dir: "/skills/demo",
          content: "demo content",
        },
      ]);
      actions.conversation.appendToolEditDiff({
        fileName: "/test/file.ts",
        diffStdout: "diff output",
      });
      actions.config.setModel("claude-haiku-4-5");
      actions.config.setSubagentModels(["fast-model"]);
      actions.config.setSdkProvider("anthropic");
      actions.config.setTranscriptionSdkProvider("openai");
      actions.config.setTranscriptionModel("gpt-4o-transcribe");
      actions.config.setTranscriptionBaseURL("https://api.example.com");
      actions.config.setGateway("opencode");
      actions.config.setBaseURL("https://api.example.com");
      actions.config.setPricingPerModel({
        "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 2 },
      });
      actions.config.setContextWindowPerModel({ "claude-haiku-4-5": 200000 });
      actions.config.setKeymaps({ edit: { name: "e", ctrl: true } });
      actions.config.setCustomSlashCommandDirs(["/commands"]);
      actions.config.setCustomSkillDirs(["/skills"]);
      actions.usage.setModelUsageForLimitWindow({ "claude-haiku-4-5": [] });
      actions.usage.setModelUsageForSession({ "gpt-4": [] });
      const rl = makeFakeRl({ question: () => Promise.resolve("") });
      actions.terminal.setRl(rl);
      const timeout = setTimeout(() => undefined, 1_000);
      actions.terminal.setLoadingStateTimeout(timeout);
      actions.abortControllers.setQuestion(new AbortController());
      actions.abortControllers.setApiStream(new AbortController());
      actions.abortControllers.setInterruptWithEditorContent(
        new AbortController(),
      );
      actions.abortControllers.setRecordProcess(new AbortController());
      actions.abortControllers.setTranscription(new AbortController());
      actions.resetState();
      clearTimeout(timeout);

      assertInitialState();
    });

    it("initial state", assertInitialState);
  });

  describe("conversation state", () => {
    it("set-session-file-path", () => {
      assert.equal(getState().session.sessionFilePath, "");
      actions.session.setFilePath("/tmp/session.json");
      assert.equal(getState().session.sessionFilePath, "/tmp/session.json");
    });

    it("set-conversation-messages", () => {
      assert.deepStrictEqual(getState().conversation.messages, []);
      actions.conversation.setMessages([{ role: "user", content: "hello" }]);
      assert.deepStrictEqual(getState().conversation.summaries, []);
      assert.deepStrictEqual(getState().conversation.messages, [
        { role: "user", content: "hello" },
      ]);
    });

    it("keeps messages separate from summarized messages", () => {
      const summaryMessage = { role: "assistant", content: "summary" };
      const userMessage = { role: "user", content: "hello" };
      actions.conversation.setMessages([summaryMessage, userMessage]);
      actions.conversation.setSummaries([
        { compacted: "summary", compactedAt: 0, tokens: 1 },
      ]);

      assert.deepStrictEqual(getState().conversation.unsummarizedMessages, [
        userMessage,
      ]);
      assert.deepStrictEqual(getState().conversation.messages, [
        summaryMessage,
        userMessage,
      ]);

      actions.conversation.setSummaries([]);
      assert.deepStrictEqual(getState().conversation.unsummarizedMessages, [
        summaryMessage,
        userMessage,
      ]);
    });

    it("set-transcript", () => {
      assert.deepStrictEqual(getState().conversation.transcript, []);
      actions.conversation.setTranscript([
        { timestamp: 0, role: "user", message: "hello" },
      ]);
      assert.deepStrictEqual(getState().conversation.transcript, [
        { timestamp: 0, role: "user", message: "hello" },
      ]);
    });
  });

  describe("transcribe settings", () => {
    it("set-transcription-sdk-provider", () => {
      assert.equal(getState().config.transcriptionSdkProvider, undefined);
      actions.config.setTranscriptionSdkProvider("openai");
      assert.equal(getState().config.transcriptionSdkProvider, "openai");
    });

    it("set-transcription-model", () => {
      assert.equal(getState().config.transcriptionModel, undefined);
      actions.config.setTranscriptionModel("gpt-4o-transcribe");
      actions.config.setTranscriptionBaseURL("https://api.example.com");
      assert.equal(getState().config.transcriptionModel, "gpt-4o-transcribe");
    });
  });

  describe("transcription settings", () => {
    it("set-transcription-sdk-provider", () => {
      assert.equal(getState().config.transcriptionSdkProvider, undefined);
      actions.config.setTranscriptionSdkProvider("openai");
      assert.equal(getState().config.transcriptionSdkProvider, "openai");
    });

    it("set-transcription-model", () => {
      assert.equal(getState().config.transcriptionModel, undefined);
      actions.config.setTranscriptionModel("gpt-4o-transcribe");
      actions.config.setTranscriptionBaseURL("https://api.example.com");
      assert.equal(getState().config.transcriptionModel, "gpt-4o-transcribe");
    });

    it("set-transcription-base-url", () => {
      assert.equal(getState().config.transcriptionBaseURL, undefined);
      actions.config.setTranscriptionBaseURL("https://api.example.com/v1");
      assert.equal(
        getState().config.transcriptionBaseURL,
        "https://api.example.com/v1",
      );
    });
  });

  describe("request input tokens", () => {
    it("set-request-input-tokens", () => {
      assert.equal(getState().usage.requestInputTokens.value, 0);
      actions.usage.setRequestInputTokens(42);
      assert.equal(getState().usage.requestInputTokens.value, 42);
    });

    it("set-request-input-tokens-stale", () => {
      assert.equal(getState().usage.requestInputTokens.stale, true);
      actions.usage.setRequestInputTokensStale(false);
      assert.equal(getState().usage.requestInputTokens.stale, false);
    });

    it("set-request-input-tokens-char-length", () => {
      assert.deepStrictEqual(getState().usage.requestInputTokens, {
        value: 0,
        stale: true,
        charLength: 0,
      });
      actions.usage.setRequestInputTokensCharLength(123);
      assert.deepStrictEqual(getState().usage.requestInputTokens, {
        value: 0,
        stale: true,
        charLength: 123,
      });
    });
  });

  describe("recording state", () => {
    it("set-is-recording", () => {
      assert.equal(getState().terminal.isRecording, false);
      actions.terminal.setIsRecording(true);
      assert.equal(getState().terminal.isRecording, true);
      actions.terminal.setIsRecording(false);
      assert.equal(getState().terminal.isRecording, false);
    });
  });

  describe("steering state", () => {
    it("set-is-steering", () => {
      assert.equal(getState().terminal.isSteering, false);
      actions.terminal.setIsSteering(true);
      assert.equal(getState().terminal.isSteering, true);
      actions.terminal.setIsSteering(false);
      assert.equal(getState().terminal.isSteering, false);
    });
  });

  describe("initializing state", () => {
    it("set-is-initializing", () => {
      assert.equal(getState().terminal.isInitializing, false);
      actions.terminal.setIsInitializing(true);
      assert.equal(getState().terminal.isInitializing, true);
      actions.terminal.setIsInitializing(false);
      assert.equal(getState().terminal.isInitializing, false);
    });

    it("set-is-non-blocking-process-ongoing", () => {
      assert.equal(getState().terminal.isNonBlockingProcessOngoing, false);
      actions.terminal.setIsNonBlockingProcessOngoing(true);
      assert.equal(getState().terminal.isNonBlockingProcessOngoing, true);
      actions.terminal.setIsNonBlockingProcessOngoing(false);
      assert.equal(getState().terminal.isNonBlockingProcessOngoing, false);
    });

    it("append-buffered-input-while-initializing accumulates inputs", () => {
      assert.equal(getState().terminal.bufferedInputWhileInitializing, "");
      actions.terminal.appendBufferedInputWhileInitializing("he");
      actions.terminal.appendBufferedInputWhileInitializing("llo");
      assert.equal(getState().terminal.bufferedInputWhileInitializing, "hello");
    });

    it("reset-buffered-input-while-initializing", () => {
      actions.terminal.appendBufferedInputWhileInitializing("abc");
      actions.terminal.resetBufferedInputWhileInitializing();
      assert.equal(getState().terminal.bufferedInputWhileInitializing, "");
    });

    it("append-buffered-stdout-while-editor-open accumulates lines", () => {
      assert.equal(getState().terminal.bufferedStdoutWhileEditorOpen, "");
      actions.terminal.appendBufferedStdoutWhileEditorOpen("he");
      actions.terminal.appendBufferedStdoutWhileEditorOpen("llo");
      assert.equal(getState().terminal.bufferedStdoutWhileEditorOpen, "hello");
    });

    it("reset-buffered-stdout-while-editor-open", () => {
      actions.terminal.appendBufferedStdoutWhileEditorOpen("abc");
      actions.terminal.resetBufferedStdoutWhileEditorOpen();
      assert.equal(getState().terminal.bufferedStdoutWhileEditorOpen, "");
    });
  });

  describe("model settings", () => {
    it("set-model", () => {
      assert.equal(getState().config.model, MISSING);
      actions.config.setModel("claude-haiku-4-5");
      assert.equal(getState().config.model, "claude-haiku-4-5");
    });

    it("set-subagent-models", () => {
      assert.deepStrictEqual(getState().config.subagentModels, []);
      actions.config.setSubagentModels(["fast-model", "strong-model"]);
      assert.deepStrictEqual(getState().config.subagentModels, [
        "fast-model",
        "strong-model",
      ]);
    });

    it("set-sdk-provider", () => {
      assert.equal(getState().config.sdkProvider, MISSING);
      actions.config.setSdkProvider("anthropic");
      assert.equal(getState().config.sdkProvider, "anthropic");
    });

    it("set-gateway", () => {
      assert.equal(getState().config.gateway, undefined);
      actions.config.setGateway("opencode");
      assert.equal(getState().config.gateway, "opencode");
      actions.config.setGateway(undefined);
      assert.equal(getState().config.gateway, undefined);
    });

    it("set-base-url", () => {
      assert.equal(getState().config.baseURL, undefined);
      actions.config.setBaseURL("https://api.example.com/v1");
      assert.equal(getState().config.baseURL, "https://api.example.com/v1");
    });
  });

  describe("mcp settings", () => {
    it("set-mcps", () => {
      assert.deepStrictEqual(getState().config.mcps, {});
      actions.config.setMcps({
        local: { type: "stdio", command: "local-mcp", args: ["--debug"] },
      });
      assert.deepStrictEqual(getState().config.mcps, {
        local: { type: "stdio", command: "local-mcp", args: ["--debug"] },
      });
    });

    it("mcp state closes all clients when initialized", async () => {
      const closeFirst = mock.fn(() => undefined);
      const closeSecond = mock.fn(() => undefined);
      const firstClient = makeFakeMcpClient({ close: closeFirst });
      const secondClient = makeFakeMcpClient({ close: closeSecond });
      actions.mcp.setClientsAndTools(
        { first: firstClient, second: secondClient },
        {},
      );

      const performanceLogger = makeStartupPerformanceLogger();
      await initMcpState({ performanceLogger });

      assert.equal(closeFirst.mock.callCount(), 1);
      assert.equal(closeSecond.mock.callCount(), 1);
      assert.deepStrictEqual(getState().mcp.clients, {});
      assert.deepStrictEqual(getState().mcp.tools, {});
    });
  });

  describe("pricing and context window", () => {
    it("set-pricing-per-model", () => {
      const newPricing = structuredClone(defaultConfig.pricingPerModel);
      newPricing["test-model"] = {
        inputPerMillion: 999,
        outputPerMillion: 0,
        cacheReadPerMillion: 0,
        cacheWritePerMillion: 0,
      };
      actions.config.setPricingPerModel(newPricing);
      assert.deepStrictEqual(getState().config.pricingPerModel, newPricing);
    });

    it("set-context-window-per-model", () => {
      assert.deepStrictEqual(getState().config.contextWindowPerModel, {});
      actions.config.setContextWindowPerModel({ "test-model": 200_000 });
      assert.deepStrictEqual(getState().config.contextWindowPerModel, {
        "test-model": 200_000,
      });
    });
  });

  describe("input handling", () => {
    it("set-keymaps", () => {
      actions.config.setKeymaps({
        edit: { name: "v", ctrl: false, meta: false, shift: false },
        skills: { name: "s", ctrl: false, meta: false, shift: false },
      });
      assert.deepStrictEqual(getState().config.keymaps, {
        edit: { name: "v", ctrl: false, meta: false, shift: false },
        skills: { name: "s", ctrl: false, meta: false, shift: false },
      });
    });

    it("set-question-abort-controller", () => {
      assert.equal(getState().abortControllers.question, null);
      const controller = new AbortController();
      actions.abortControllers.setQuestion(controller);
      assert.equal(getState().abortControllers.question, controller);
    });

    it("set-api-stream-abort-controller", () => {
      assert.equal(getState().abortControllers.apiStream, null);
      const controller = new AbortController();
      actions.abortControllers.setApiStream(controller);
      assert.equal(getState().abortControllers.apiStream, controller);
    });

    it("set-execute-user-input-abort-controller", () => {
      assert.equal(getState().abortControllers.executeUserInput, null);
      const controller = new AbortController();
      actions.abortControllers.setExecuteUserInput(controller);
      assert.equal(getState().abortControllers.executeUserInput, controller);
    });

    it("set-interrupt-with-editor-abort-controller", () => {
      assert.equal(
        getState().abortControllers.interruptWithEditorContent,
        null,
      );
      const controller = new AbortController();
      actions.abortControllers.setInterruptWithEditorContent(controller);
      assert.equal(
        getState().abortControllers.interruptWithEditorContent,
        controller,
      );
    });

    it("set-record-process-abort-controller", () => {
      assert.equal(getState().abortControllers.recordProcess, null);
      const controller = new AbortController();
      actions.abortControllers.setRecordProcess(controller);
      assert.equal(getState().abortControllers.recordProcess, controller);
    });

    it("set-editor-input-value", () => {
      assert.equal(getState().terminal.editorInputValue, null);
      actions.terminal.setEditorInputValue("test content");
      assert.equal(getState().terminal.editorInputValue, "test content");
      actions.terminal.setEditorInputValue(null);
      assert.equal(getState().terminal.editorInputValue, null);
      assert.throws(() => actions.terminal.setEditorInputValue(""));
    });

    it("append-editor-input-value sets when null and appends by concatenating", () => {
      assert.equal(getState().terminal.editorInputValue, null);
      actions.terminal.appendEditorInputValue("first");
      assert.equal(getState().terminal.editorInputValue, "first");
      actions.terminal.appendEditorInputValue(
        `${defaultConfig.messageQueueDelimiter}second`,
      );
      assert.strictEqual(
        getState().terminal.editorInputValue,
        `first${defaultConfig.messageQueueDelimiter}second`,
      );
      assert.throws(() => actions.terminal.appendEditorInputValue(""));
    });
  });

  describe("debug log", () => {
    it("set-debug-log", () => {
      assert.equal(getState().debug.debugLog, false);
      actions.debug.setLog(true);
      assert.equal(getState().debug.debugLog, true);
    });

    it("set-debug-log-path", () => {
      assert.equal(getState().debug.debugLogPath, "");
      actions.debug.setLogPath("/fake-home/.config/lasso/debug-test-uuid.log");
      assert.equal(
        getState().debug.debugLogPath,
        "/fake-home/.config/lasso/debug-test-uuid.log",
      );
    });
  });

  describe("config strings", () => {
    it("set-context-str", () => {
      assert.equal(getState().content.contextStr, "");
      actions.content.setContextStr("FILEPATH: context\nhello");
      assert.equal(
        getState().content.contextStr,
        `FILEPATH: context
hello`,
      );
    });

    it("set-global-config-str", () => {
      assert.equal(getState().content.globalConfigStr, "");
      actions.content.setGlobalConfigStr("model: gpt-4");
      assert.equal(getState().content.globalConfigStr, "model: gpt-4");
    });

    it("set-local-config-str", () => {
      assert.equal(getState().content.localConfigStr, "");
      actions.content.setLocalConfigStr("model: claude");
      assert.equal(getState().content.localConfigStr, "model: claude");
    });

    it("set-skills-str", () => {
      assert.equal(getState().content.skillsStr, "");
      actions.content.setSkillsStr("- skill: desc");
      assert.equal(getState().content.skillsStr, "- skill: desc");
    });
  });

  describe("config-warning-messages", () => {
    it("starts empty", () => {
      assert.deepStrictEqual(getState().content.configWarningMessages, []);
    });

    it("appends warning messages in order", () => {
      actions.content.appendConfigWarningMessage("unknown key: foo");
      actions.content.appendConfigWarningMessage("deprecated key: bar");
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "unknown key: foo",
        "deprecated key: bar",
      ]);
    });

    it("reset clears the warning messages", () => {
      actions.content.appendConfigWarningMessage("unknown key: foo");
      actions.content.resetConfigWarningMessages();
      assert.deepStrictEqual(getState().content.configWarningMessages, []);
    });

    it("reset keeps appending working", () => {
      actions.content.appendConfigWarningMessage("before reset");
      actions.content.resetConfigWarningMessages();
      actions.content.appendConfigWarningMessage("after reset");
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "after reset",
      ]);
    });
  });

  describe("append-tool-edit-diff", () => {
    it("appends a single diff", () => {
      assert.deepStrictEqual(getState().conversation.toolEditDiffs, []);
      actions.conversation.appendToolEditDiff({
        fileName: "/test/file.ts",
        diffStdout: "diff output",
      });
      assert.deepStrictEqual(getState().conversation.toolEditDiffs, [
        {
          fileName: "/test/file.ts",
          diffStdout: "diff output",
        },
      ]);
    });

    it("appends multiple diffs in order", () => {
      actions.conversation.appendToolEditDiff({
        fileName: "/a.ts",
        diffStdout: "a diff",
      });
      actions.conversation.appendToolEditDiff({
        fileName: "/b.ts",
        diffStdout: "b diff",
      });
      assert.deepStrictEqual(getState().conversation.toolEditDiffs, [
        { fileName: "/a.ts", diffStdout: "a diff" },
        { fileName: "/b.ts", diffStdout: "b diff" },
      ]);
    });
  });

  it("reset-tool-edit-diffs", () => {
    actions.conversation.resetToolEditDiffs();
    assert.deepStrictEqual(getState().conversation.toolEditDiffs, []);
  });

  describe("set-context-entries", () => {
    it("sets the context entries array", () => {
      assert.deepStrictEqual(getState().content.contextEntries, []);
      actions.content.setContextEntries([
        { filePath: "/test/AGENTS.md", content: "# Instructions" },
      ]);
      assert.deepStrictEqual(getState().content.contextEntries, [
        { filePath: "/test/AGENTS.md", content: "# Instructions" },
      ]);
    });

    it("replaces existing context entries", () => {
      actions.content.setContextEntries([
        { filePath: "/a/AGENTS.md", content: "A" },
      ]);
      actions.content.setContextEntries([
        { filePath: "/b/AGENTS.md", content: "B" },
      ]);
      assert.equal(getState().content.contextEntries.length, 1);
      const entry = getState().content.contextEntries[0];
      assert(entry !== undefined);
      assert.equal(entry.filePath, "/b/AGENTS.md");
    });
  });

  describe("set-skills", () => {
    it("sets the skills array", () => {
      assert.deepStrictEqual(getState().content.skills, []);
      actions.content.setSkills([
        {
          name: "deploy",
          description: "Deploy skill",
          dir: "/skills/deploy",
          content: "# Deploy instructions",
        },
      ]);
      assert.deepStrictEqual(getState().content.skills, [
        {
          name: "deploy",
          description: "Deploy skill",
          dir: "/skills/deploy",
          content: "# Deploy instructions",
        },
      ]);
    });

    it("replaces existing skills", () => {
      actions.content.setSkills([
        {
          name: "a",
          description: "Skill A",
          dir: "/a",
          content: "content a",
        },
      ]);
      actions.content.setSkills([
        {
          name: "b",
          description: "Skill B",
          dir: "/b",
          content: "content b",
        },
      ]);
      assert.equal(getState().content.skills.length, 1);
      const skill = getState().content.skills[0];
      assert(skill !== undefined);
      assert.equal(skill.name, "b");
    });
  });

  describe("slash commands and skills", () => {
    it("set-slash-commands", () => {
      assert.deepStrictEqual(getState().content.slashCommands, []);
      actions.content.setSlashCommands([
        { name: "test", filePath: "/test.md", content: "test content" },
        { name: "deploy", filePath: "/deploy.md", content: "deploy content" },
      ]);
      assert.deepStrictEqual(getState().content.slashCommands, [
        { name: "test", filePath: "/test.md", content: "test content" },
        { name: "deploy", filePath: "/deploy.md", content: "deploy content" },
      ]);
    });

    it("set-custom-slash-command-dirs", () => {
      assert.deepStrictEqual(getState().config.customSlashCommandDirs, []);
      actions.config.setCustomSlashCommandDirs(["/my-commands", "/more"]);
      assert.deepStrictEqual(getState().config.customSlashCommandDirs, [
        "/my-commands",
        "/more",
      ]);
    });

    it("set-custom-skill-dirs", () => {
      assert.deepStrictEqual(getState().config.customSkillDirs, []);
      actions.config.setCustomSkillDirs(["/my-skills", "/more"]);
      assert.deepStrictEqual(getState().config.customSkillDirs, [
        "/my-skills",
        "/more",
      ]);
    });
  });

  it("reset-stdout-tail", () => {
    actions.terminal.appendStdoutTail("line1\n");
    actions.terminal.appendStdoutTail("line2\n");
    assert.equal(getState().terminal.stdoutTail, "2\n");
    actions.terminal.resetStdout();
    assert.equal(getState().terminal.stdoutTail, "");
  });

  describe("append-stdout-tail", () => {
    it("appends single line", () => {
      assert.equal(getState().terminal.stdoutTail, "");
      actions.terminal.appendStdoutTail("line1\n");
      assert.equal(getState().terminal.stdoutTail, "1\n");
    });

    it("appends multiple lines in order", () => {
      assert.equal(getState().terminal.stdoutTail, "");
      actions.terminal.appendStdoutTail("line1\n");
      actions.terminal.appendStdoutTail("line2\n");
      actions.terminal.appendStdoutTail("line3\n");
      assert.equal(getState().terminal.stdoutTail, "3\n");
    });
  });

  describe("readline and api timing", () => {
    it("set-rl", () => {
      assert.equal(getState().terminal.rl, null);
      const fakeRl = makeFakeRl();
      actions.terminal.setRl(fakeRl);
      assert.equal(getState().terminal.rl, fakeRl);
    });

    it("set-api-start-time", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(42_000_000_000));
      assert.equal(getState().usage.apiStartTime, null);
      actions.usage.setApiStartTime();
      assert.strictEqual(getState().usage.apiStartTime, 42_000_000_000n);
    });

    it("set-api-end-time", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(99_000_000_000));
      assert.equal(getState().usage.apiEndTime, null);
      actions.usage.setApiEndTime();
      assert.strictEqual(getState().usage.apiEndTime, 99_000_000_000n);
    });
  });

  describe("loading state frames", () => {
    it("set-loading-state-frames", () => {
      assert.deepStrictEqual(getState().config.loadingStateFrames, [
        "|",
        "/",
        "-",
        "\\",
      ]);
      actions.config.setLoadingStateFrames(["⠋", "⠙", "⠹", "⠸"]);
      assert.deepStrictEqual(getState().config.loadingStateFrames, [
        "⠋",
        "⠙",
        "⠹",
        "⠸",
      ]);
    });

    it("set-loading-state-frame-duration", () => {
      assert.equal(getState().config.loadingStateFrameDuration, 80);
      actions.config.setLoadingStateFrameDuration(120);
      assert.strictEqual(getState().config.loadingStateFrameDuration, 120);
    });
  });

  describe("settings", () => {
    it("set-prompt-prefix", () => {
      assert.strictEqual(getState().config.promptPrefix, "> ");
      actions.config.setPromptPrefix("🤖 ");
      assert.strictEqual(getState().config.promptPrefix, "🤖 ");
    });

    it("set-suppress-config-warnings", () => {
      assert.strictEqual(getState().config.suppressConfigWarnings, false);
      actions.config.setSuppressConfigWarnings(true);
      assert.strictEqual(getState().config.suppressConfigWarnings, true);
    });

    it("set-suppress-tool-edit-diffs", () => {
      assert.strictEqual(getState().config.suppressToolEditDiffs, false);
      actions.config.setSuppressToolEditDiffs(true);
      assert.strictEqual(getState().config.suppressToolEditDiffs, true);
    });

    it("set-message-queue-delimiter", () => {
      assert.strictEqual(getState().config.messageQueueDelimiter, "l---\n");
      actions.config.setMessageQueueDelimiter("---");
      assert.strictEqual(getState().config.messageQueueDelimiter, "---");
    });

    it("set-ascii-only", () => {
      assert.strictEqual(getState().config.asciiOnly, false);
      actions.config.setAsciiOnly(true);
      assert.strictEqual(getState().config.asciiOnly, true);
    });

    it("set-compact-with-structured-output", () => {
      assert.strictEqual(getState().config.compactWithStructuredOutput, true);
      actions.config.setCompactWithStructuredOutput(false);
      assert.strictEqual(getState().config.compactWithStructuredOutput, false);
    });

    it("set-reasoning", () => {
      assert.strictEqual(getState().config.reasoning, "provider-default");
      actions.config.setReasoning("high");
      assert.strictEqual(getState().config.reasoning, "high");
    });
  });

  describe("usage limits", () => {
    it("set-usage-limit", () => {
      assert.strictEqual(getState().config.usageLimit, undefined);
      actions.config.setUsageLimit({ duration: "60m", dollarAmount: 5 });
      assert.deepStrictEqual(getState().config.usageLimit, {
        duration: "60m",
        dollarAmount: 5,
      });
      actions.config.setUsageLimit(undefined);
      assert.strictEqual(getState().config.usageLimit, undefined);
    });

    it("set-model-usage-for-limit-window", () => {
      assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {});

      actions.usage.setModelUsageForLimitWindow({
        "gpt-4": [
          {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
            date: 1_000,
          },
        ],
      });

      assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {
        "gpt-4": [
          {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
            date: 1_000,
          },
        ],
      });
    });

    it("set-model-usage-for-session", () => {
      assert.deepStrictEqual(getState().usage.modelUsageForSession, {});

      actions.usage.setModelUsageForSession({
        "gpt-4": [
          {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
            date: 1_000,
          },
        ],
      });

      assert.deepStrictEqual(getState().usage.modelUsageForSession, {
        "gpt-4": [
          {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
            date: 1_000,
          },
        ],
      });
    });

    it("append-to-model-usage-for-session", () => {
      actions.config.setModel("gpt-4");
      const first = {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        date: 1_000,
      };
      actions.usage.appendToModelUsageForSession(first, "gpt-4");

      actions.config.setModel("claude");
      const second = {
        inputTokens: 3,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        date: 2_000,
      };
      actions.usage.appendToModelUsageForSession(second, "claude");

      assert.deepStrictEqual(getState().usage.modelUsageForSession, {
        "gpt-4": [first],
        claude: [second],
      });
    });
  });

  describe("loading state reset and timeout", () => {
    it("reset-loading-state-frame-idx", () => {
      actions.terminal.incrementLoadingStateFrameIdx();
      actions.terminal.incrementLoadingStateFrameIdx();
      assert.strictEqual(getState().terminal.loadingStateFrameIdx, 2);
      actions.terminal.resetLoadingStateFrameIdx();
      assert.strictEqual(getState().terminal.loadingStateFrameIdx, 0);
    });

    it("set-loading-state-timeout", () => {
      assert.equal(getState().terminal.loadingStateTimeout, null);
      const timeout = setTimeout(() => undefined, 1_000);
      actions.terminal.setLoadingStateTimeout(timeout);
      assert.equal(getState().terminal.loadingStateTimeout, timeout);
      clearTimeout(timeout);
      actions.terminal.setLoadingStateTimeout(null);
      assert.equal(getState().terminal.loadingStateTimeout, null);
    });
  });
});
