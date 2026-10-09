import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { actions, getState, promptDeps, SessionFileSchema } from "./state.ts";
import { getBaseAgentPrompt } from "./prompts.ts";
import { stringify } from "./utils.ts";
import { defaultConfig } from "./config-types.ts";
import { MISSING } from "./missing.ts";
import {
  makeFakeMcpClient,
  makeFakeRl,
  makeStartupPerformanceLogger,
  setupTestContext,
  testFs,
} from "./test-helpers.ts";
import { initMcpState } from "./mcp.ts";

const realGetSystemContent = promptDeps.getSystemContent;
const realGetToolsContentStr = promptDeps.getToolsContentStr;

describe("state", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext({ model: null, sdkProvider: null });
  });

  describe("system content", () => {
    it("getSystemContent joins prompt, context, and skills with blank lines", () => {
      mock.method(promptDeps, "getSystemContent", realGetSystemContent);
      actions.setContextStr("ctx body");
      actions.setSkillsStr("skills body");
      assert.strictEqual(
        promptDeps.getSystemContent(),
        `${getBaseAgentPrompt([])}

ctx body

skills body`,
      );
    });

    it("getToolsContentStr returns an empty string by default", () => {
      mock.method(promptDeps, "getToolsContentStr", realGetToolsContentStr);
      assert.strictEqual(promptDeps.getToolsContentStr(), "");
    });
  });

  describe("initial and reset state", () => {
    it("reset-state writes debug-log entry using pre-reset debug settings", async () => {
      const debugLogPath = "/fake-home/.config/lasso/debug/debug-test-uuid.log";
      testFs._dirs.add("/fake-home/.config/lasso/debug");
      testFs._files.set(debugLogPath, "");
      actions.setDebugLogPath(debugLogPath);
      actions.setDebugLog(true);
      actions.setQuestionAbortController(new AbortController());
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
      assert.deepStrictEqual(getState().usage.promptTokens, {
        value: 0,
        dirty: true,
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
        suppressBatUnavailableWarning:
          defaultConfig.suppressBatUnavailableWarning,
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
        interruptWithEditorContent: null,
        recordProcess: null,
        transcription: null,
      });
    };

    it("resetState restores initial state after mutations", () => {
      actions.setConversationMessages([{ role: "user", content: "hi" }]);
      actions.setPromptTokens(7);
      actions.setPromptTokensDirty(true);
      actions.setEditorInputValue("draft");
      actions.setIsInitializing(true);
      actions.appendBufferedInputWhileInitializing("buffered");
      actions.setSlashCommands([
        {
          name: "custom",
          filePath: "/test-cwd/.lasso/commands/custom.md",
          content: "custom command content",
        },
      ]);
      actions.appendStdoutTail("out\n");
      actions.setDebugLog(true);
      actions.setDebugLogPath("/fake-home/lasso/debug.log");
      actions.setContextEntries([{ filePath: "/a/AGENTS.md", content: "A" }]);
      actions.setContextStr("# context");
      actions.setGlobalConfigStr("global");
      actions.setLocalConfigStr("local");
      actions.setSkillsStr("skills");
      actions.setSkills([
        {
          name: "demo",
          description: "a demo skill",
          dir: "/skills/demo",
          content: "demo content",
        },
      ]);
      actions.appendToolEditDiff({
        fileName: "/test/file.ts",
        diffStdout: "diff output",
      });
      actions.setModel("claude-haiku-4-5");
      actions.setSubagentModels(["fast-model"]);
      actions.setSdkProvider("anthropic");
      actions.setTranscriptionSdkProvider("openai");
      actions.setTranscriptionModel("gpt-4o-transcribe");
      actions.setTranscriptionBaseURL("https://api.example.com");
      actions.setGateway("opencode");
      actions.setBaseURL("https://api.example.com");
      actions.setPricingPerModel({
        "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 2 },
      });
      actions.setContextWindowPerModel({ "claude-haiku-4-5": 200000 });
      actions.setKeymaps({ edit: { name: "e", ctrl: true } });
      actions.setCustomSlashCommandDirs(["/commands"]);
      actions.setCustomSkillDirs(["/skills"]);
      actions.setModelUsageForLimitWindow({ "claude-haiku-4-5": [] });
      actions.setModelUsageForSession({ "gpt-4": [] });
      const rl = makeFakeRl({ question: () => Promise.resolve("") });
      actions.setRl(rl);
      const timeout = setTimeout(() => undefined, 1_000);
      actions.setLoadingStateTimeout(timeout);
      actions.setQuestionAbortController(new AbortController());
      actions.setApiStreamAbortController(new AbortController());
      actions.setInterruptWithEditorAbortController(new AbortController());
      actions.setRecordProcessAbortController(new AbortController());
      actions.setTranscriptionAbortController(new AbortController());
      actions.resetState();
      clearTimeout(timeout);

      assertInitialState();
    });

    it("initial state", assertInitialState);
  });

  describe("conversation state", () => {
    it("set-session-file-path", () => {
      assert.equal(getState().session.sessionFilePath, "");
      actions.setSessionFilePath("/tmp/session.json");
      assert.equal(getState().session.sessionFilePath, "/tmp/session.json");
    });

    it("set-conversation-messages", () => {
      assert.deepStrictEqual(getState().conversation.messages, []);
      actions.setConversationMessages([{ role: "user", content: "hello" }]);
      assert.deepStrictEqual(getState().conversation.summaries, []);
      assert.deepStrictEqual(getState().conversation.messages, [
        { role: "user", content: "hello" },
      ]);
    });

    it("set-transcript", () => {
      assert.deepStrictEqual(getState().conversation.transcript, []);
      actions.setTranscript([{ timestamp: 0, role: "user", message: "hello" }]);
      assert.deepStrictEqual(getState().conversation.transcript, [
        { timestamp: 0, role: "user", message: "hello" },
      ]);
    });
  });

  describe("transcribe settings", () => {
    it("set-transcription-sdk-provider", () => {
      assert.equal(getState().config.transcriptionSdkProvider, undefined);
      actions.setTranscriptionSdkProvider("openai");
      assert.equal(getState().config.transcriptionSdkProvider, "openai");
    });

    it("set-transcription-model", () => {
      assert.equal(getState().config.transcriptionModel, undefined);
      actions.setTranscriptionModel("gpt-4o-transcribe");
      actions.setTranscriptionBaseURL("https://api.example.com");
      assert.equal(getState().config.transcriptionModel, "gpt-4o-transcribe");
    });
  });

  describe("transcription settings", () => {
    it("set-transcription-sdk-provider", () => {
      assert.equal(getState().config.transcriptionSdkProvider, undefined);
      actions.setTranscriptionSdkProvider("openai");
      assert.equal(getState().config.transcriptionSdkProvider, "openai");
    });

    it("set-transcription-model", () => {
      assert.equal(getState().config.transcriptionModel, undefined);
      actions.setTranscriptionModel("gpt-4o-transcribe");
      actions.setTranscriptionBaseURL("https://api.example.com");
      assert.equal(getState().config.transcriptionModel, "gpt-4o-transcribe");
    });

    it("set-transcription-base-url", () => {
      assert.equal(getState().config.transcriptionBaseURL, undefined);
      actions.setTranscriptionBaseURL("https://api.example.com/v1");
      assert.equal(
        getState().config.transcriptionBaseURL,
        "https://api.example.com/v1",
      );
    });
  });

  describe("prompt tokens", () => {
    it("set-prompt-tokens", () => {
      assert.equal(getState().usage.promptTokens.value, 0);
      actions.setPromptTokens(42);
      assert.equal(getState().usage.promptTokens.value, 42);
    });

    it("set-prompt-tokens-dirty", () => {
      assert.equal(getState().usage.promptTokens.dirty, true);
      actions.setPromptTokensDirty(false);
      assert.equal(getState().usage.promptTokens.dirty, false);
    });
  });

  describe("recording state", () => {
    it("set-is-recording", () => {
      assert.equal(getState().terminal.isRecording, false);
      actions.setIsRecording(true);
      assert.equal(getState().terminal.isRecording, true);
      actions.setIsRecording(false);
      assert.equal(getState().terminal.isRecording, false);
    });
  });

  describe("initializing state", () => {
    it("set-is-initializing", () => {
      assert.equal(getState().terminal.isInitializing, false);
      actions.setIsInitializing(true);
      assert.equal(getState().terminal.isInitializing, true);
      actions.setIsInitializing(false);
      assert.equal(getState().terminal.isInitializing, false);
    });

    it("set-is-non-blocking-process-ongoing", () => {
      assert.equal(getState().terminal.isNonBlockingProcessOngoing, false);
      actions.setIsNonBlockingProcessOngoing(true);
      assert.equal(getState().terminal.isNonBlockingProcessOngoing, true);
      actions.setIsNonBlockingProcessOngoing(false);
      assert.equal(getState().terminal.isNonBlockingProcessOngoing, false);
    });

    it("append-buffered-input-while-initializing accumulates inputs", () => {
      assert.equal(getState().terminal.bufferedInputWhileInitializing, "");
      actions.appendBufferedInputWhileInitializing("he");
      actions.appendBufferedInputWhileInitializing("llo");
      assert.equal(getState().terminal.bufferedInputWhileInitializing, "hello");
    });

    it("reset-buffered-input-while-initializing", () => {
      actions.appendBufferedInputWhileInitializing("abc");
      actions.resetBufferedInputWhileInitializing();
      assert.equal(getState().terminal.bufferedInputWhileInitializing, "");
    });

    it("append-buffered-stdout-while-editor-open accumulates lines", () => {
      assert.equal(getState().terminal.bufferedStdoutWhileEditorOpen, "");
      actions.appendBufferedStdoutWhileEditorOpen("he");
      actions.appendBufferedStdoutWhileEditorOpen("llo");
      assert.equal(getState().terminal.bufferedStdoutWhileEditorOpen, "hello");
    });

    it("reset-buffered-stdout-while-editor-open", () => {
      actions.appendBufferedStdoutWhileEditorOpen("abc");
      actions.resetBufferedStdoutWhileEditorOpen();
      assert.equal(getState().terminal.bufferedStdoutWhileEditorOpen, "");
    });
  });

  describe("model settings", () => {
    it("set-model", () => {
      assert.equal(getState().config.model, MISSING);
      actions.setModel("claude-haiku-4-5");
      assert.equal(getState().config.model, "claude-haiku-4-5");
    });

    it("set-subagent-models", () => {
      assert.deepStrictEqual(getState().config.subagentModels, []);
      actions.setSubagentModels(["fast-model", "strong-model"]);
      assert.deepStrictEqual(getState().config.subagentModels, [
        "fast-model",
        "strong-model",
      ]);
    });

    it("set-sdk-provider", () => {
      assert.equal(getState().config.sdkProvider, MISSING);
      actions.setSdkProvider("anthropic");
      assert.equal(getState().config.sdkProvider, "anthropic");
    });

    it("set-gateway", () => {
      assert.equal(getState().config.gateway, undefined);
      actions.setGateway("opencode");
      assert.equal(getState().config.gateway, "opencode");
      actions.setGateway(undefined);
      assert.equal(getState().config.gateway, undefined);
    });

    it("set-base-url", () => {
      assert.equal(getState().config.baseURL, undefined);
      actions.setBaseURL("https://api.example.com/v1");
      assert.equal(getState().config.baseURL, "https://api.example.com/v1");
    });
  });

  describe("mcp settings", () => {
    it("set-mcps", () => {
      assert.deepStrictEqual(getState().config.mcps, {});
      actions.setMcps({
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
      actions.setMcp({ first: firstClient, second: secondClient }, {});

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
      actions.setPricingPerModel(newPricing);
      assert.deepStrictEqual(getState().config.pricingPerModel, newPricing);
    });

    it("set-context-window-per-model", () => {
      assert.deepStrictEqual(getState().config.contextWindowPerModel, {});
      actions.setContextWindowPerModel({ "test-model": 200_000 });
      assert.deepStrictEqual(getState().config.contextWindowPerModel, {
        "test-model": 200_000,
      });
    });
  });

  describe("input handling", () => {
    it("set-keymaps", () => {
      actions.setKeymaps({
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
      actions.setQuestionAbortController(controller);
      assert.equal(getState().abortControllers.question, controller);
    });

    it("set-api-stream-abort-controller", () => {
      assert.equal(getState().abortControllers.apiStream, null);
      const controller = new AbortController();
      actions.setApiStreamAbortController(controller);
      assert.equal(getState().abortControllers.apiStream, controller);
    });

    it("set-interrupt-with-editor-abort-controller", () => {
      assert.equal(
        getState().abortControllers.interruptWithEditorContent,
        null,
      );
      const controller = new AbortController();
      actions.setInterruptWithEditorAbortController(controller);
      assert.equal(
        getState().abortControllers.interruptWithEditorContent,
        controller,
      );
    });

    it("set-record-process-abort-controller", () => {
      assert.equal(getState().abortControllers.recordProcess, null);
      const controller = new AbortController();
      actions.setRecordProcessAbortController(controller);
      assert.equal(getState().abortControllers.recordProcess, controller);
    });

    it("set-editor-input-value", () => {
      assert.equal(getState().terminal.editorInputValue, null);
      actions.setEditorInputValue("test content");
      assert.equal(getState().terminal.editorInputValue, "test content");
      actions.setEditorInputValue(null);
      assert.equal(getState().terminal.editorInputValue, null);
      assert.throws(() => actions.setEditorInputValue(""));
    });

    it("append-editor-input-value sets when null and appends by concatenating", () => {
      assert.equal(getState().terminal.editorInputValue, null);
      actions.appendEditorInputValue("first");
      assert.equal(getState().terminal.editorInputValue, "first");
      actions.appendEditorInputValue(
        `${defaultConfig.messageQueueDelimiter}second`,
      );
      assert.strictEqual(
        getState().terminal.editorInputValue,
        `first${defaultConfig.messageQueueDelimiter}second`,
      );
      assert.throws(() => actions.appendEditorInputValue(""));
    });
  });

  describe("debug log", () => {
    it("set-debug-log", () => {
      assert.equal(getState().debug.debugLog, false);
      actions.setDebugLog(true);
      assert.equal(getState().debug.debugLog, true);
    });

    it("set-debug-log-path", () => {
      assert.equal(getState().debug.debugLogPath, "");
      actions.setDebugLogPath("/fake-home/.config/lasso/debug-test-uuid.log");
      assert.equal(
        getState().debug.debugLogPath,
        "/fake-home/.config/lasso/debug-test-uuid.log",
      );
    });
  });

  describe("config strings", () => {
    it("set-context-str", () => {
      assert.equal(getState().content.contextStr, "");
      actions.setContextStr("FILEPATH: context\nhello");
      assert.equal(
        getState().content.contextStr,
        `FILEPATH: context
hello`,
      );
    });

    it("set-global-config-str", () => {
      assert.equal(getState().content.globalConfigStr, "");
      actions.setGlobalConfigStr("model: gpt-4");
      assert.equal(getState().content.globalConfigStr, "model: gpt-4");
    });

    it("set-local-config-str", () => {
      assert.equal(getState().content.localConfigStr, "");
      actions.setLocalConfigStr("model: claude");
      assert.equal(getState().content.localConfigStr, "model: claude");
    });

    it("set-skills-str", () => {
      assert.equal(getState().content.skillsStr, "");
      actions.setSkillsStr("- skill: desc");
      assert.equal(getState().content.skillsStr, "- skill: desc");
    });
  });

  describe("config-warning-messages", () => {
    it("starts empty", () => {
      assert.deepStrictEqual(getState().content.configWarningMessages, []);
    });

    it("appends warning messages in order", () => {
      actions.appendConfigWarningMessage("unknown key: foo");
      actions.appendConfigWarningMessage("deprecated key: bar");
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "unknown key: foo",
        "deprecated key: bar",
      ]);
    });

    it("reset clears the warning messages", () => {
      actions.appendConfigWarningMessage("unknown key: foo");
      actions.resetConfigWarningMessages();
      assert.deepStrictEqual(getState().content.configWarningMessages, []);
    });

    it("reset keeps appending working", () => {
      actions.appendConfigWarningMessage("before reset");
      actions.resetConfigWarningMessages();
      actions.appendConfigWarningMessage("after reset");
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "after reset",
      ]);
    });
  });

  describe("append-tool-edit-diff", () => {
    it("appends a single diff", () => {
      assert.deepStrictEqual(getState().conversation.toolEditDiffs, []);
      actions.appendToolEditDiff({
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
      actions.appendToolEditDiff({ fileName: "/a.ts", diffStdout: "a diff" });
      actions.appendToolEditDiff({ fileName: "/b.ts", diffStdout: "b diff" });
      assert.deepStrictEqual(getState().conversation.toolEditDiffs, [
        { fileName: "/a.ts", diffStdout: "a diff" },
        { fileName: "/b.ts", diffStdout: "b diff" },
      ]);
    });
  });

  it("reset-tool-edit-diffs", () => {
    actions.resetToolEditDiffs();
    assert.deepStrictEqual(getState().conversation.toolEditDiffs, []);
  });

  describe("set-context-entries", () => {
    it("sets the context entries array", () => {
      assert.deepStrictEqual(getState().content.contextEntries, []);
      actions.setContextEntries([
        { filePath: "/test/AGENTS.md", content: "# Instructions" },
      ]);
      assert.deepStrictEqual(getState().content.contextEntries, [
        { filePath: "/test/AGENTS.md", content: "# Instructions" },
      ]);
    });

    it("replaces existing context entries", () => {
      actions.setContextEntries([{ filePath: "/a/AGENTS.md", content: "A" }]);
      actions.setContextEntries([{ filePath: "/b/AGENTS.md", content: "B" }]);
      assert.equal(getState().content.contextEntries.length, 1);
      const entry = getState().content.contextEntries[0];
      assert(entry !== undefined);
      assert.equal(entry.filePath, "/b/AGENTS.md");
    });
  });

  describe("set-skills", () => {
    it("sets the skills array", () => {
      assert.deepStrictEqual(getState().content.skills, []);
      actions.setSkills([
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
      actions.setSkills([
        {
          name: "a",
          description: "Skill A",
          dir: "/a",
          content: "content a",
        },
      ]);
      actions.setSkills([
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
      actions.setSlashCommands([
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
      actions.setCustomSlashCommandDirs(["/my-commands", "/more"]);
      assert.deepStrictEqual(getState().config.customSlashCommandDirs, [
        "/my-commands",
        "/more",
      ]);
    });

    it("set-custom-skill-dirs", () => {
      assert.deepStrictEqual(getState().config.customSkillDirs, []);
      actions.setCustomSkillDirs(["/my-skills", "/more"]);
      assert.deepStrictEqual(getState().config.customSkillDirs, [
        "/my-skills",
        "/more",
      ]);
    });
  });

  it("reset-stdout-tail", () => {
    actions.appendStdoutTail("line1\n");
    actions.appendStdoutTail("line2\n");
    assert.equal(getState().terminal.stdoutTail, "2\n");
    actions.resetStdout();
    assert.equal(getState().terminal.stdoutTail, "");
  });

  describe("append-stdout-tail", () => {
    it("appends single line", () => {
      assert.equal(getState().terminal.stdoutTail, "");
      actions.appendStdoutTail("line1\n");
      assert.equal(getState().terminal.stdoutTail, "1\n");
    });

    it("appends multiple lines in order", () => {
      assert.equal(getState().terminal.stdoutTail, "");
      actions.appendStdoutTail("line1\n");
      actions.appendStdoutTail("line2\n");
      actions.appendStdoutTail("line3\n");
      assert.equal(getState().terminal.stdoutTail, "3\n");
    });
  });

  describe("readline and api timing", () => {
    it("set-rl", () => {
      assert.equal(getState().terminal.rl, null);
      const fakeRl = makeFakeRl();
      actions.setRl(fakeRl);
      assert.equal(getState().terminal.rl, fakeRl);
    });

    it("set-api-start-time", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(42_000_000_000));
      assert.equal(getState().usage.apiStartTime, null);
      actions.setApiStartTime();
      assert.strictEqual(getState().usage.apiStartTime, 42_000_000_000n);
    });

    it("set-api-end-time", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(99_000_000_000));
      assert.equal(getState().usage.apiEndTime, null);
      actions.setApiEndTime();
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
      actions.setLoadingStateFrames(["⠋", "⠙", "⠹", "⠸"]);
      assert.deepStrictEqual(getState().config.loadingStateFrames, [
        "⠋",
        "⠙",
        "⠹",
        "⠸",
      ]);
    });

    it("set-loading-state-frame-duration", () => {
      assert.equal(getState().config.loadingStateFrameDuration, 80);
      actions.setLoadingStateFrameDuration(120);
      assert.strictEqual(getState().config.loadingStateFrameDuration, 120);
    });
  });

  describe("settings", () => {
    it("set-prompt-prefix", () => {
      assert.strictEqual(getState().config.promptPrefix, "> ");
      actions.setPromptPrefix("🤖 ");
      assert.strictEqual(getState().config.promptPrefix, "🤖 ");
    });

    it("set-suppress-bat-unavailable-warning", () => {
      assert.strictEqual(
        getState().config.suppressBatUnavailableWarning,
        false,
      );
      actions.setSuppressBatUnavailableWarning(true);
      assert.strictEqual(getState().config.suppressBatUnavailableWarning, true);
    });

    it("set-suppress-tool-edit-diffs", () => {
      assert.strictEqual(getState().config.suppressToolEditDiffs, false);
      actions.setSuppressToolEditDiffs(true);
      assert.strictEqual(getState().config.suppressToolEditDiffs, true);
    });

    it("set-message-queue-delimiter", () => {
      assert.strictEqual(getState().config.messageQueueDelimiter, "l---\n");
      actions.setMessageQueueDelimiter("---");
      assert.strictEqual(getState().config.messageQueueDelimiter, "---");
    });

    it("set-ascii-only", () => {
      assert.strictEqual(getState().config.asciiOnly, false);
      actions.setAsciiOnly(true);
      assert.strictEqual(getState().config.asciiOnly, true);
    });

    it("set-compact-with-structured-output", () => {
      assert.strictEqual(getState().config.compactWithStructuredOutput, true);
      actions.setCompactWithStructuredOutput(false);
      assert.strictEqual(getState().config.compactWithStructuredOutput, false);
    });

    it("set-reasoning", () => {
      assert.strictEqual(getState().config.reasoning, "provider-default");
      actions.setReasoning("high");
      assert.strictEqual(getState().config.reasoning, "high");
    });
  });

  describe("usage limits", () => {
    it("set-usage-limit", () => {
      assert.strictEqual(getState().config.usageLimit, undefined);
      actions.setUsageLimit({ duration: "60m", dollarAmount: 5 });
      assert.deepStrictEqual(getState().config.usageLimit, {
        duration: "60m",
        dollarAmount: 5,
      });
      actions.setUsageLimit(undefined);
      assert.strictEqual(getState().config.usageLimit, undefined);
    });

    it("set-model-usage-for-limit-window", () => {
      assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {});

      actions.setModelUsageForLimitWindow({
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

      actions.setModelUsageForSession({
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
      actions.setModel("gpt-4");
      const first = {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        date: 1_000,
      };
      actions.appendToModelUsageForSession(first);

      actions.setModel("claude");
      const second = {
        inputTokens: 3,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        date: 2_000,
      };
      actions.appendToModelUsageForSession(second);

      assert.deepStrictEqual(getState().usage.modelUsageForSession, {
        "gpt-4": [first],
        claude: [second],
      });
    });
  });

  describe("loading state reset and timeout", () => {
    it("reset-loading-state-frame-idx", () => {
      actions.incrementLoadingStateFrameIdx();
      actions.incrementLoadingStateFrameIdx();
      assert.strictEqual(getState().terminal.loadingStateFrameIdx, 2);
      actions.resetLoadingStateFrameIdx();
      assert.strictEqual(getState().terminal.loadingStateFrameIdx, 0);
    });

    it("set-loading-state-timeout", () => {
      assert.equal(getState().terminal.loadingStateTimeout, null);
      const timeout = setTimeout(() => undefined, 1_000);
      actions.setLoadingStateTimeout(timeout);
      assert.equal(getState().terminal.loadingStateTimeout, timeout);
      clearTimeout(timeout);
      actions.setLoadingStateTimeout(null);
      assert.equal(getState().terminal.loadingStateTimeout, null);
    });
  });

  describe("SessionFileSchema", () => {
    it("parses a valid session file", () => {
      assert.deepStrictEqual(
        SessionFileSchema.parse({
          messages: [{ role: "user", content: "hello" }],
          summaries: [{ compacted: "summary", compactedAt: 123, tokens: 456 }],
          transcript: [{ timestamp: 0, role: "user", message: "hello" }],
        }),
        {
          messages: [{ role: "user", content: "hello" }],
          summaries: [{ compacted: "summary", compactedAt: 123, tokens: 456 }],
          transcript: [{ timestamp: 0, role: "user", message: "hello" }],
        },
      );
    });

    it("rejects an invalid transcript role", () => {
      const result = SessionFileSchema.safeParse({
        messages: [],
        summaries: [],
        transcript: [{ timestamp: 0, role: "system", message: "hello" }],
      });
      assert.strictEqual(result.success, false);
    });

    it("rejects an invalid summary shape", () => {
      const result = SessionFileSchema.safeParse({
        messages: [],
        summaries: [{ compacted: 1, compactedAt: 123, tokens: 456 }],
        transcript: [],
      });
      assert.strictEqual(result.success, false);
    });

    it("allows extra fields on messages", () => {
      assert.deepStrictEqual(
        SessionFileSchema.parse({
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "hello" }],
              name: "assistant",
            },
          ],
          summaries: [],
          transcript: [],
        }),
        {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "hello" }],
              name: "assistant",
            },
          ],
          summaries: [],
          transcript: [],
        },
      );
    });

    it("rejects a message without content", () => {
      const result = SessionFileSchema.safeParse({
        messages: [{ role: "user" }],
        summaries: [],
        transcript: [],
      });
      assert.strictEqual(result.success, false);
    });

    it("rejects extra fields on summaries", () => {
      const result = SessionFileSchema.safeParse({
        messages: [],
        summaries: [
          { compacted: "summary", compactedAt: 123, tokens: 456, extra: 1 },
        ],
        transcript: [],
      });
      assert.strictEqual(result.success, false);
    });

    it("rejects extra fields on transcript entries", () => {
      const result = SessionFileSchema.safeParse({
        messages: [],
        summaries: [],
        transcript: [
          { timestamp: 0, role: "user", message: "hello", extra: 1 },
        ],
      });
      assert.strictEqual(result.success, false);
    });
  });
});
