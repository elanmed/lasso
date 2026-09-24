import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import type { ModelMessage } from "ai";
import { safeStringify, strToApproxTokens } from "./utils.ts";
import { actions, getState, type MCPToolSet } from "./state.ts";
import {
  maybeCompact,
  getConversationSummary,
  getMergedSummaries,
  resolveApiCall,
  warnOnLargePromptOverhead,
} from "./api.ts";
import { harnessTools, getTools } from "./tools.ts";
import {
  setupTestContext,
  testFs,
  mockExec,
  mockStdout,
  stripAnsi,
  makeGenerateTextResult,
  mockGenerateText,
  makeMcpTool,
  makeFakeRl,
  getCapturedTool,
  getCapturedMessages,
  makeMockUsage,
  makeAbortError,
  mockGenerateTextResults,
} from "./test-helpers.ts";
import { aiDeps } from "./deps.ts";
import { promptDeps } from "./state.ts";

describe("api", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext({ model: "claude-sonnet-4-20250514" });
    actions.setToolsContentStr(safeStringify(getTools()));
    actions.setBaseURL("https://api.anthropic.com");
    actions.setContextStr("");
    actions.setSkillsStr("");
    mock.method(aiDeps, "generateText", () =>
      Promise.resolve(makeGenerateTextResult()),
    );
  });

  describe("resolveApiCall", () => {
    it("returns text on success", async () => {
      actions.setChatHistoryPath("/tmp/test-history.log");
      const result = await resolveApiCall("hello");
      assert.strictEqual(result, "response text");
      assert.strictEqual(
        testFs._files.get("/tmp/test-history.log"),
        `
1970-01-01T00:00:00.000Z  *assistant*
response text

---
`,
      );
    });

    it("returns null on non-abort error", async () => {
      mock.method(aiDeps, "generateText", () =>
        Promise.reject(new Error("network error")),
      );
      const result = await resolveApiCall("hello");
      assert.strictEqual(result, null);
    });

    it("passes harness and MCP tools to generateText", async () => {
      let capturedOptions: Record<string, unknown> | undefined;
      const mcpTool = makeMcpTool();
      const mcpTools: MCPToolSet = { mcp_tool: mcpTool };
      actions.setMcp({}, mcpTools);
      mockGenerateText((options: Record<string, unknown>) => {
        capturedOptions = options;
        return Promise.resolve(makeGenerateTextResult());
      });

      await resolveApiCall("hello");

      assert.strictEqual(getCapturedTool(capturedOptions, "mcp_tool"), mcpTool);
      getCapturedTool(capturedOptions, "bash");
    });

    it("passes the configured reasoning to generateText", async () => {
      const captured: Record<string, unknown>[] = [];
      mockGenerateText((options: Record<string, unknown>) => {
        captured.push(options);
        return Promise.resolve(makeGenerateTextResult());
      });

      await resolveApiCall("hello");
      assert.strictEqual(captured[0]?.["reasoning"], "provider-default");

      actions.setReasoning("high");
      await resolveApiCall("hello");
      assert.strictEqual(captured[1]?.["reasoning"], "high");
    });

    it("resets the tool edit diffs at the start of the api call", async () => {
      actions.appendToolEditDiff({
        fileName: "/old.ts",
        diffStdout: "old diff",
      });
      mockGenerateText(() => Promise.resolve(makeGenerateTextResult()));
      await resolveApiCall("hello");
      assert.deepStrictEqual(getState().app.toolEditDiffs, []);
    });

    it("prints the [mcp] prefix on mcp tool call start", async () => {
      const getCaptured = mockStdout();
      actions.setMcp({}, { mcp_tool: makeMcpTool() });
      mockGenerateText((options: Record<string, unknown>) => {
        const onStart = options["onToolExecutionStart"] as (
          arg: Record<string, unknown>,
        ) => void;
        onStart({
          toolCall: {
            toolName: "mcp_tool",
            toolCallId: "call-9",
            input: { a: 1 },
          },
        });
        return Promise.resolve(makeGenerateTextResult());
      });
      await resolveApiCall("hello");
      assert.strictEqual(stripAnsi(getCaptured()), `[mcp] mcp_tool: {"a":1}\n`);
    });

    it("prints load_skill details on tool call start", async () => {
      const getCaptured = mockStdout();
      mockGenerateText((options: Record<string, unknown>) => {
        const onStart = options["onToolExecutionStart"] as (
          arg: Record<string, unknown>,
        ) => void;
        onStart({
          toolCall: {
            toolName: "load_skill",
            toolCallId: "call-10",
            input: { name: "demo" },
          },
        });
        return Promise.resolve(makeGenerateTextResult());
      });
      await resolveApiCall("hello");
      assert.strictEqual(stripAnsi(getCaptured()), `load_skill: demo\n`);
    });

    it("prints web_fetch_html and web_fetch_json details on tool call start", async () => {
      const getCaptured = mockStdout();
      mockGenerateText((options: Record<string, unknown>) => {
        const onStart = options["onToolExecutionStart"] as (
          arg: Record<string, unknown>,
        ) => void;
        onStart({
          toolCall: {
            toolName: "web_fetch_html",
            toolCallId: "call-11",
            input: { href: "https://example.com" },
          },
        });
        onStart({
          toolCall: {
            toolName: "web_fetch_json",
            toolCallId: "call-12",
            input: { href: "https://example.com/api" },
          },
        });
        return Promise.resolve(makeGenerateTextResult());
      });
      await resolveApiCall("hello");
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `web_fetch_html: https://example.com\nweb_fetch_json: https://example.com/api\n`,
      );
    });

    it("prints one indented line per subagent task on tool call start", async () => {
      const getCaptured = mockStdout();
      mockGenerateText((options: Record<string, unknown>) => {
        const onStart = options["onToolExecutionStart"] as (
          arg: Record<string, unknown>,
        ) => void;
        onStart({
          toolCall: {
            toolName: "create_subagent",
            toolCallId: "call-13",
            input: {
              tasks: [
                {
                  prompt: "investigate tests",
                  access: "read-only",
                  model: "claude-sonnet-4-20250514",
                },
                {
                  prompt: "write code",
                  access: "read-write",
                  model: "claude-sonnet-4-20250514",
                },
              ],
            },
          },
        });
        return Promise.resolve(makeGenerateTextResult());
      });
      await resolveApiCall("hello");
      const lines = stripAnsi(getCaptured()).trimEnd().split("\n");
      const firstLine = lines[0];
      const secondLine = lines[1];
      assert(firstLine !== undefined);
      assert(secondLine !== undefined);
      assert.strictEqual(
        firstLine,
        "   create_subagent: [claude-sonnet-4-20250514] investigate tests",
      );
      assert.strictEqual(
        secondLine,
        "   create_subagent: [claude-sonnet-4-20250514] write code",
      );
    });

    it("resolves the queued editor input when the api call is interrupted", async () => {
      actions.setChatHistoryPath("/tmp/test-history.log");
      actions.setRl(makeFakeRl());
      actions.setEditorInputValue("queued input");
      const err = makeAbortError();
      mock.method(aiDeps, "generateText", () => Promise.reject(err));
      const getCaptured = mockStdout();
      const result = await resolveApiCall("hello");
      assert.strictEqual(result, null);
      assert.strictEqual(getState().app.editorInputValue, "queued input");
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `You have queued messages! Edit them with {"name":"g","ctrl":true} or press enter to continue\n`,
      );
    });

    it("returns null on abort error", async () => {
      const err = makeAbortError();
      mock.method(aiDeps, "generateText", () => Promise.reject(err));
      const result = await resolveApiCall("hello");
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [],
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: "[Interrupted before a response was generated]",
          },
        ],
      });
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: 0,
        dirty: true,
      });
    });

    it("leaves the stored token value untouched when marking dirty on abort", async () => {
      actions.setPromptTokens(50);
      const err = makeAbortError();
      mock.method(aiDeps, "generateText", () => Promise.reject(err));
      const result = await resolveApiCall("hello");
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: 50,
        dirty: true,
      });
    });

    it("appends usage and messages on success", async () => {
      mock.method(aiDeps, "generateText", () =>
        Promise.resolve(
          makeGenerateTextResult({
            usage: makeMockUsage({
              inputTokens: 42,
              outputTokens: 7,
              cacheReadTokens: 3,
              cacheWriteTokens: 1,
            }),
            responseMessages: [
              { role: "assistant", content: "tool call" },
              { role: "tool", content: "tool result" },
            ],
          }),
        ),
      );
      await resolveApiCall("hello");
      assert.deepStrictEqual(getState().app.modelUsageForSession, {
        "claude-sonnet-4-20250514": [
          {
            inputTokens: 42,
            outputTokens: 7,
            cacheReadTokens: 3,
            cacheWriteTokens: 1,
            date: 0,
          },
        ],
      });
      assert.deepStrictEqual(getState().app.modelUsageForLimitWindow, {});
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [],
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "tool call" },
          { role: "tool", content: "tool result" },
        ],
      });
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: 49,
        dirty: false,
      });
    });

    it("sets tokens to input plus output tokens on each call", async () => {
      await resolveApiCall("first");
      assert.strictEqual(getState().app.promptTokens.value, 15);

      mock.method(aiDeps, "generateText", () =>
        Promise.resolve(
          makeGenerateTextResult({
            usage: makeMockUsage({ inputTokens: 14, outputTokens: 3 }),
            responseMessages: [{ role: "assistant", content: "answer" }],
          }),
        ),
      );
      await resolveApiCall("second");
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [],
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
          { role: "assistant", content: "answer" },
        ],
      });
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: 17,
        dirty: false,
      });
    });

    it("re-baselines tokens from usage when stale after model switch", async () => {
      actions.appendToConversation({ role: "user", content: "existing" });
      actions.setPromptTokens(100);
      actions.setPromptTokensDirty(true);
      mock.method(aiDeps, "generateText", () =>
        Promise.resolve(
          makeGenerateTextResult({
            usage: makeMockUsage({ inputTokens: 50, outputTokens: 5 }),
            responseMessages: [{ role: "assistant", content: "answer" }],
          }),
        ),
      );
      await resolveApiCall("hello");
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [],
        messages: [
          { role: "user", content: "existing" },
          { role: "user", content: "hello" },
          { role: "assistant", content: "answer" },
        ],
      });
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: 55,
        dirty: false,
      });
    });

    it("creates temp file on tool call start for writing bash tools", async () => {
      testFs._files.set("/test/file.txt", "original content");
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        const onStart = opts["onToolExecutionStart"] as (
          arg: Record<string, unknown>,
        ) => void;
        onStart({
          toolCall: {
            toolName: "bash",
            toolCallId: "call-1",
            input: {
              fileSystemAccessType: "create-update-delete",
              filePath: "/test/file.txt",
              command: "write",
            },
          },
        });
        return makeGenerateTextResult();
      });
      await resolveApiCall("edit file");
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), true);
    });

    it("does not create temp file for read-only bash tools", async () => {
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        const onStart = opts["onToolExecutionStart"] as (
          arg: Record<string, unknown>,
        ) => void;
        onStart({
          toolCall: {
            toolName: "bash",
            toolCallId: "call-3",
            input: {
              fileSystemAccessType: "read",
              command: "ls",
            },
          },
        });
        return makeGenerateTextResult();
      });
      await resolveApiCall("run command");
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
    });

    it("prints diff and cleans up on tool call finish success", async () => {
      const getCaptured = mockStdout();
      testFs._files.set("/test/file.txt", "modified content");
      mock.method(
        aiDeps,
        "generateText",
        async (opts: Record<string, unknown>) => {
          const onStart = opts["onToolExecutionStart"] as (
            arg: Record<string, unknown>,
          ) => void;
          const onFinish = opts["onToolExecutionEnd"] as (
            arg: Record<string, unknown>,
          ) => Promise<void>;
          onStart({
            toolCall: {
              toolName: "bash",
              toolCallId: "call-1",
              input: {
                fileSystemAccessType: "create-update-delete",
                filePath: "/test/file.txt",
                command: "write",
              },
            },
          });
          await onFinish({
            toolCall: {
              toolName: "bash",
              toolCallId: "call-1",
              input: {
                fileSystemAccessType: "create-update-delete",
                filePath: "/test/file.txt",
                command: "write",
              },
            },
            toolOutput: { type: "tool-result" },
          });
          return makeGenerateTextResult();
        },
      );
      mockExec({ stdout: "+added line" });
      await resolveApiCall("edit file");
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `bash: write

━━ File change: /test/file.txt ━━
+added line

`,
      );
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
    });

    it("cleans up without printing diff on tool call finish failure", async () => {
      testFs._files.set("/test/file.txt", "content");
      mock.method(
        aiDeps,
        "generateText",
        async (opts: Record<string, unknown>) => {
          const onStart = opts["onToolExecutionStart"] as (
            arg: Record<string, unknown>,
          ) => void;
          const onFinish = opts["onToolExecutionEnd"] as (
            arg: Record<string, unknown>,
          ) => Promise<void>;
          onStart({
            toolCall: {
              toolName: "bash",
              toolCallId: "call-1",
              input: {
                fileSystemAccessType: "create-update-delete",
                filePath: "/test/file.txt",
                command: "write",
              },
            },
          });
          await onFinish({
            toolCall: {
              toolName: "bash",
              toolCallId: "call-1",
              input: {
                fileSystemAccessType: "create-update-delete",
                filePath: "/test/file.txt",
                command: "write",
              },
            },
            toolOutput: { type: "tool-error" },
          });
          return makeGenerateTextResult();
        },
      );
      await resolveApiCall("edit file");
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
    });

    it("passes system content to the api call", async () => {
      const systemContent = "system-content";
      mock.method(promptDeps, "getSystemContent", () => systemContent);
      let capturedInstructions: string | undefined;
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        capturedInstructions = opts["instructions"] as string;
        return makeGenerateTextResult();
      });
      await resolveApiCall("hello");
      assert.strictEqual(capturedInstructions, systemContent);
    });

    it("includes previous messages in request", async () => {
      actions.appendToConversation({ role: "user", content: "previous" });
      actions.appendToConversation({ role: "assistant", content: "response" });
      let capturedOpts: Record<string, unknown> | undefined;
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return makeGenerateTextResult();
      });
      const getMessages = () => getCapturedMessages(capturedOpts);
      await resolveApiCall("hello");
      assert.strictEqual(getMessages().length, 3);
      assert.deepStrictEqual(getMessages()[0], {
        role: "user",
        content: "previous",
      });
      assert.deepStrictEqual(getMessages()[1], {
        role: "assistant",
        content: "response",
      });
      assert.deepStrictEqual(getMessages()[2], {
        role: "user",
        content: "hello",
      });
    });
  });

  describe("warnOnLargePromptOverhead", () => {
    beforeEach(() => {
      actions.setContextWindowPerModel({ "claude-sonnet-4-20250514": 100_000 });
    });

    function getPromptOverheadRatio() {
      return (
        (strToApproxTokens(promptDeps.getSystemContent()) +
          strToApproxTokens(safeStringify(harnessTools))) /
        100_000
      );
    }

    it("returns early without a warning when the model has no context window", () => {
      actions.setContextWindowPerModel({});
      const getCaptured = mockStdout();
      warnOnLargePromptOverhead();
      assert.strictEqual(stripAnsi(getCaptured()), "");
    });

    it("does not warn when prompt overhead is below the dedicated share", () => {
      mock.method(promptDeps, "getSystemContent", () => "s".repeat(30_000));
      const getCaptured = mockStdout();
      warnOnLargePromptOverhead();
      assert.strictEqual(getPromptOverheadRatio() < 0.5, true);
      assert.strictEqual(stripAnsi(getCaptured()), "");
    });

    it("warns when prompt overhead reaches the dedicated share", () => {
      const systemContent = "s".repeat(150_000);
      mock.method(promptDeps, "getSystemContent", () => systemContent);
      const getCaptured = mockStdout();
      warnOnLargePromptOverhead();
      assert.strictEqual(getPromptOverheadRatio() >= 0.5, true);
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `The current set of context, skills, and tools is 51.09% of the 100,000 token context window!

Lasso reserves 50% of the context window for compacted summaries and 30% for prompt overhead. As is, the prompt overhead may breach the llm's context window and cause API calls to be rejected. Consider converting some of your context to skills and minimizing MCP servers.\n`,
      );
    });
  });

  describe("maybeCompact", () => {
    beforeEach(() => {
      actions.setContextWindowPerModel({ "claude-sonnet-4-20250514": 100_000 });
    });

    const getApproxAdditions = () =>
      strToApproxTokens(
        safeStringify({ ...harnessTools, ...getState().mcp.tools }),
      ) + strToApproxTokens(promptDeps.getSystemContent());

    it("returns early when below the compact threshold", async () => {
      actions.appendToConversation({ role: "user", content: "hi" });
      actions.setPromptTokens(60_000);
      let called = false;
      mock.method(aiDeps, "generateText", () => {
        called = true;
        return Promise.resolve(makeGenerateTextResult());
      });
      await maybeCompact("hi");
      assert.strictEqual(called, false);
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [],
        messages: [{ role: "user", content: "hi" }],
      });
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: 60_000,
        dirty: false,
      });
    });

    it("uses approximated tokens when stale to decide compaction", async () => {
      const longUserContent = "a".repeat(240_000);
      actions.appendToConversation({
        role: "user",
        content: longUserContent,
      });
      actions.setPromptTokens(0);
      actions.setPromptTokensDirty(true);
      let capturedOpts: Record<string, unknown> | undefined;
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return Promise.resolve(
          makeGenerateTextResult({
            output: { compacted: "compacted summary" },
            usage: makeMockUsage(),
          }),
        );
      });
      const getMessages = () => getCapturedMessages(capturedOpts);
      await maybeCompact("hi");
      assert.strictEqual(getMessages().length, 1);
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [
          { compacted: "compacted summary", compactedAt: 0, tokens: 25_000 },
        ],
        messages: [{ role: "assistant", content: "compacted summary" }],
      });
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: 25_000 + getApproxAdditions(),
        dirty: false,
      });
    });

    it("returns early when approximated tokens are below the compact threshold only even when stale", async () => {
      const longUserContent = "a".repeat(20_000);
      actions.appendToConversation({
        role: "user",
        content: longUserContent,
      });
      actions.setPromptTokens(2_000);
      actions.setPromptTokensDirty(true);
      let called = false;
      mock.method(aiDeps, "generateText", () => {
        called = true;
        return Promise.resolve(makeGenerateTextResult());
      });
      await maybeCompact("hi");
      assert.strictEqual(called, false);
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [],
        messages: [{ role: "user", content: longUserContent }],
      });
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: 2_000,
        dirty: true,
      });
    });

    it("includes the system prompt in the stale approximation when deciding compaction", async () => {
      const systemContent = "s".repeat(100_000);
      mock.method(promptDeps, "getSystemContent", () => systemContent);
      const longUserContent = "a".repeat(150_000);
      actions.appendToConversation({
        role: "user",
        content: longUserContent,
      });
      actions.setPromptTokens(0);
      actions.setPromptTokensDirty(true);
      let called = false;
      mock.method(aiDeps, "generateText", () => {
        called = true;
        return Promise.resolve(
          makeGenerateTextResult({ output: { compacted: "" } }),
        );
      });
      await maybeCompact("hi");
      const systemContentTokensApprox = strToApproxTokens(systemContent);
      assert.strictEqual(strToApproxTokens(longUserContent) < 70_000, true);
      assert.strictEqual(
        strToApproxTokens(longUserContent) + systemContentTokensApprox >=
          70_000,
        true,
      );
      assert.strictEqual(called, true);
    });

    it("includes the tools in the stale approximation when deciding compaction", async () => {
      const longUserContent = "a".repeat(237_000);
      actions.appendToConversation({
        role: "user",
        content: longUserContent,
      });
      actions.setPromptTokens(0);
      actions.setPromptTokensDirty(true);
      let called = false;
      mock.method(aiDeps, "generateText", () => {
        called = true;
        return Promise.resolve(
          makeGenerateTextResult({ output: { compacted: "" } }),
        );
      });
      await maybeCompact("hi");
      const toolsTokensApprox = strToApproxTokens(safeStringify(harnessTools));
      assert.strictEqual(strToApproxTokens(longUserContent) < 80_000, true);
      assert.strictEqual(
        strToApproxTokens(longUserContent) + toolsTokensApprox >= 80_000,
        true,
      );
      assert.strictEqual(called, true);
    });

    it("includes mcp tools in the tokens after compaction", async () => {
      actions.setMcp({}, { mcp_tool: makeMcpTool() });
      actions.setToolsContentStr(safeStringify(getTools()));
      actions.appendToConversation({ role: "user", content: "hi" });
      actions.setPromptTokens(85_000);
      mock.method(aiDeps, "generateText", () =>
        Promise.resolve(
          makeGenerateTextResult({
            output: { compacted: "compacted summary" },
            usage: makeMockUsage(),
          }),
        ),
      );
      await maybeCompact("hi");
      const withMcpTools = strToApproxTokens(
        safeStringify({ ...harnessTools, ...getState().mcp.tools }),
      );
      const withoutMcpTools = strToApproxTokens(safeStringify(harnessTools));
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [
          { compacted: "compacted summary", compactedAt: 0, tokens: 25_000 },
        ],
        messages: [{ role: "assistant", content: "compacted summary" }],
      });
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: 25_000 + withMcpTools,
        dirty: false,
      });
      assert.strictEqual(withMcpTools > withoutMcpTools, true);
    });

    it("excludes image and file parts from the stale approximation", async () => {
      actions.appendToConversation({
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "image/png",
            data: "a".repeat(300_000),
          },
          { type: "text", text: "after image" },
        ],
      });
      actions.setPromptTokens(0);
      actions.setPromptTokensDirty(true);
      let called = false;
      mock.method(aiDeps, "generateText", () => {
        called = true;
        return Promise.resolve(makeGenerateTextResult());
      });
      await maybeCompact("hi");
      assert.strictEqual(called, false);
    });

    it("compacts the conversation when above the threshold", async () => {
      actions.appendToConversation({ role: "user", content: "hi" });
      actions.setPromptTokens(85_000);
      let capturedOpts: Record<string, unknown> | undefined;
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return Promise.resolve(
          makeGenerateTextResult({
            output: { compacted: "compacted summary" },
            usage: makeMockUsage(),
          }),
        );
      });
      const getMessages = () => getCapturedMessages(capturedOpts);
      await maybeCompact("hi");
      assert.strictEqual(getMessages().length, 1);
      const capturedMessage = getMessages()[0];
      assert(capturedMessage !== undefined);
      assert.strictEqual(
        capturedMessage.content,
        `Compact the following conversation. Output a maximum of 90000 characters:\n[{"role":"user","content":"hi"}]\n`,
      );
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [
          { compacted: "compacted summary", compactedAt: 0, tokens: 25_000 },
        ],
        messages: [{ role: "assistant", content: "compacted summary" }],
      });
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: 25_000 + getApproxAdditions(),
        dirty: false,
      });
      assert.deepStrictEqual(getState().app.modelUsageForSession, {
        "claude-sonnet-4-20250514": [
          {
            inputTokens: 0,
            outputTokens: 25_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            date: 0,
          },
        ],
      });
    });

    it("compacts when the user input pushes tokens over the threshold", async () => {
      actions.appendToConversation({ role: "user", content: "hi" });
      actions.setPromptTokens(80_000);
      let capturedOpts: Record<string, unknown> | undefined;
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return Promise.resolve(
          makeGenerateTextResult({
            output: { compacted: "compacted summary" },
            usage: makeMockUsage(),
          }),
        );
      });

      // 300 chars ≈ 100 tokens, pushing 80_000 over the 0.8 trigger (80_000 tokens).
      const getMessages = () => getCapturedMessages(capturedOpts);
      await maybeCompact("x".repeat(300));

      assert.strictEqual(getMessages().length, 1);
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [
          { compacted: "compacted summary", compactedAt: 0, tokens: 25_000 },
        ],
        messages: [{ role: "assistant", content: "compacted summary" }],
      });
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: 25_000 + getApproxAdditions(),
        dirty: false,
      });
    });

    it("keeps messages when generateText fails", async () => {
      actions.appendToConversation({ role: "user", content: "hi" });
      actions.setPromptTokens(85_000);
      mock.method(aiDeps, "generateText", () =>
        Promise.reject(new Error("network error")),
      );
      await maybeCompact("hi");
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [],
        messages: [{ role: "user", content: "hi" }],
      });
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: 85_000,
        dirty: false,
      });
    });

    it("resolves the queued editor input when compaction is aborted", async () => {
      const getCaptured = mockStdout();
      actions.appendToConversation({ role: "user", content: "hi" });
      actions.setPromptTokens(85_000);
      actions.setRl(makeFakeRl());
      actions.setEditorInputValue("queued input");
      const err = makeAbortError();
      mock.method(aiDeps, "generateText", () => Promise.reject(err));
      await maybeCompact("hi");
      assert.strictEqual(getState().abortControllers.apiStream, null);
      assert.strictEqual(getState().app.editorInputValue, "queued input");
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `Compacting…\nYou have queued messages! Edit them with {"name":"g","ctrl":true} or press enter to continue\n`,
      );
    });

    it("keeps messages on abort error during compaction", async () => {
      const getCaptured = mockStdout();
      actions.appendToConversation({ role: "user", content: "hi" });
      actions.setPromptTokens(85_000);
      const err = makeAbortError();
      mock.method(aiDeps, "generateText", () => Promise.reject(err));
      await maybeCompact("hi");
      assert.strictEqual(getState().abortControllers.apiStream, null);
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [],
        messages: [{ role: "user", content: "hi" }],
      });
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: 85_000,
        dirty: false,
      });
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `Compacting…
`,
      );
    });

    it("resets messages before the api call so the summary and new user input are both sent", async () => {
      actions.appendToConversation({ role: "user", content: "old" });
      actions.setPromptTokens(85_000);
      const calls: ModelMessage[][] = [];
      let callCount = 0;
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        calls.push(opts["messages"] as ModelMessage[]);
        const overrides = (() => {
          if (callCount === 0) {
            return {
              output: { compacted: "compacted summary" },
              usage: makeMockUsage({ outputTokens: 25 }),
            };
          }
          return {
            text: "answer text",
            usage: makeMockUsage({ outputTokens: 25 }),
            responseMessages: [{ role: "assistant", content: "answer text" }],
          };
        })();
        callCount = callCount + 1;
        return Promise.resolve(makeGenerateTextResult(overrides));
      });
      await maybeCompact("new input");
      await resolveApiCall("new input");
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [
          { compacted: "compacted summary", compactedAt: 0, tokens: 25 },
        ],
        messages: [
          { role: "assistant", content: "compacted summary" },
          { role: "user", content: "new input" },
          { role: "assistant", content: "answer text" },
        ],
      });
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: 25,
        dirty: false,
      });
      const compactionCall = calls[0];
      assert(compactionCall !== undefined);
      assert.deepStrictEqual(compactionCall, [
        {
          role: "user",
          content: `Compact the following conversation. Output a maximum of 90000 characters:\n[{"role":"user","content":"old"}]\n`,
        },
      ]);
      assert.strictEqual(calls.length, 2);
      const apiCall = calls[1];
      assert(apiCall !== undefined);
      assert.deepStrictEqual(apiCall, [
        { role: "assistant", content: "compacted summary" },
        { role: "user", content: "new input" },
      ]);
    });

    it("merges existing summaries when at the summary max during compaction", async () => {
      for (const i of [1, 2, 3, 4, 5]) {
        actions.setSummaries([
          ...getState().app.conversation.summaries,
          { compacted: `summary ${String(i)}`, compactedAt: i, tokens: 100 },
        ]);
        actions.appendToConversation({
          role: "assistant",
          content: `summary ${String(i)}`,
        });
      }
      actions.appendToConversation({ role: "user", content: "hi" });
      actions.setPromptTokens(85_000);
      const generate = mockGenerateTextResults([
        {
          output: { compacted: "compacted summary" },
          usage: makeMockUsage({ outputTokens: 20 }),
        },
        {
          output: { compacted: "merged summary" },
          usage: makeMockUsage({ outputTokens: 15 }),
        },
      ]);
      await maybeCompact("hi");
      assert.strictEqual(generate.callCount(), 2);
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [
          { compacted: "merged summary", compactedAt: 0, tokens: 15 },
          { compacted: "summary 3", compactedAt: 3, tokens: 100 },
          { compacted: "summary 4", compactedAt: 4, tokens: 100 },
          { compacted: "summary 5", compactedAt: 5, tokens: 100 },
          { compacted: "compacted summary", compactedAt: 0, tokens: 20 },
        ],
        messages: [
          { role: "assistant", content: "merged summary" },
          { role: "assistant", content: "summary 3" },
          { role: "assistant", content: "summary 4" },
          { role: "assistant", content: "summary 5" },
          { role: "assistant", content: "compacted summary" },
        ],
      });
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: 15 + 300 + 20 + getApproxAdditions(),
        dirty: false,
      });
    });

    it("keeps the existing summaries when merging fails during compaction", async () => {
      for (const i of [1, 2, 3, 4, 5]) {
        actions.setSummaries([
          ...getState().app.conversation.summaries,
          { compacted: `summary ${String(i)}`, compactedAt: i, tokens: 100 },
        ]);
        actions.appendToConversation({
          role: "assistant",
          content: `summary ${String(i)}`,
        });
      }
      actions.appendToConversation({ role: "user", content: "hi" });
      actions.setPromptTokens(85_000);
      const generate = mockGenerateTextResults([
        {
          output: { compacted: "compacted summary" },
          usage: makeMockUsage({ outputTokens: 20 }),
        },
        new Error("network error"),
      ]);
      await maybeCompact("hi");
      assert.strictEqual(generate.callCount(), 2);
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [
          { compacted: "summary 1", compactedAt: 1, tokens: 100 },
          { compacted: "summary 2", compactedAt: 2, tokens: 100 },
          { compacted: "summary 3", compactedAt: 3, tokens: 100 },
          { compacted: "summary 4", compactedAt: 4, tokens: 100 },
          { compacted: "summary 5", compactedAt: 5, tokens: 100 },
          { compacted: "compacted summary", compactedAt: 0, tokens: 20 },
        ],
        messages: [
          { role: "assistant", content: "summary 1" },
          { role: "assistant", content: "summary 2" },
          { role: "assistant", content: "summary 3" },
          { role: "assistant", content: "summary 4" },
          { role: "assistant", content: "summary 5" },
          { role: "assistant", content: "compacted summary" },
        ],
      });
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: 500 + 20 + getApproxAdditions(),
        dirty: false,
      });
    });
  });

  describe("getConversationSummary", () => {
    beforeEach(() => {
      actions.setContextWindowPerModel({ "claude-sonnet-4-20250514": 100_000 });
      mock.method(Date, "now", () => 42);
    });

    const usage = makeMockUsage();

    const seedConversation = () => {
      actions.setSummaries([
        { compacted: "prior summary", compactedAt: 1, tokens: 10 },
      ]);
      actions.appendToConversation({
        role: "assistant",
        content: "prior summary",
      });
      actions.appendToConversation({
        role: "user",
        content: "not yet summarized",
      });
      actions.setPromptTokens(85_000);
    };

    it("sends the unsummarized messages as a compact prompt to the api", async () => {
      seedConversation();
      let capturedOpts: Record<string, unknown> | undefined;
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return Promise.resolve(
          makeGenerateTextResult({
            output: { compacted: "compacted summary" },
            usage,
          }),
        );
      });
      const getMessages = () => getCapturedMessages(capturedOpts);
      await getConversationSummary();
      assert.strictEqual(getMessages().length, 1);
      const capturedMessage = getMessages()[0];
      assert(capturedMessage !== undefined);
      assert.strictEqual(
        capturedMessage.content,
        `Compact the following conversation. Output a maximum of 90000 characters:\n[{"role":"user","content":"not yet summarized"}]\n`,
      );
    });

    it("returns the compacted summary with usage tokens on success", async () => {
      seedConversation();
      mock.method(aiDeps, "generateText", () =>
        Promise.resolve(
          makeGenerateTextResult({
            output: { compacted: "compacted summary" },
            usage,
          }),
        ),
      );
      const result = await getConversationSummary();
      assert.deepStrictEqual(result, {
        compacted: "compacted summary",
        compactedAt: 42,
        tokens: 25_000,
      });
      assert.deepStrictEqual(getState().app.modelUsageForSession, {
        "claude-sonnet-4-20250514": [
          {
            inputTokens: 0,
            outputTokens: 25_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            date: 42,
          },
        ],
      });
    });

    it("uses a structured output schema when compactWithStructuredOutput is true", async () => {
      seedConversation();
      let capturedOpts: Record<string, unknown> | undefined;
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return Promise.resolve(
          makeGenerateTextResult({
            output: { compacted: "compacted summary" },
            usage,
          }),
        );
      });
      await getConversationSummary();
      assert(capturedOpts !== undefined);
      assert.strictEqual("output" in capturedOpts, true);
    });

    it("uses the plain text result when compactWithStructuredOutput is false", async () => {
      seedConversation();
      actions.setCompactWithStructuredOutput(false);
      let capturedOpts: Record<string, unknown> | undefined;
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return Promise.resolve(
          makeGenerateTextResult({ text: "plain summary", usage }),
        );
      });
      const result = await getConversationSummary();
      assert(capturedOpts !== undefined);
      assert.strictEqual("output" in capturedOpts, false);
      assert.deepStrictEqual(result, {
        compacted: "plain summary",
        compactedAt: 42,
        tokens: 25_000,
      });
    });

    it("falls back to approximated tokens when usage has no outputTokens", async () => {
      seedConversation();
      mock.method(aiDeps, "generateText", () =>
        Promise.resolve(
          makeGenerateTextResult({
            output: { compacted: "four chars ≈ one token" },
            usage: makeMockUsage({ outputTokens: undefined }),
          }),
        ),
      );
      const result = await getConversationSummary();
      assert.deepStrictEqual(result, {
        compacted: "four chars ≈ one token",
        compactedAt: 42,
        tokens: strToApproxTokens("four chars ≈ one token"),
      });
    });

    it("returns null and does not touch messages when generateText fails", async () => {
      seedConversation();
      mock.method(aiDeps, "generateText", () =>
        Promise.reject(new Error("network error")),
      );
      const result = await getConversationSummary();
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [{ compacted: "prior summary", compactedAt: 1, tokens: 10 }],
        messages: [
          { role: "assistant", content: "prior summary" },
          { role: "user", content: "not yet summarized" },
        ],
      });
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: 85_000,
        dirty: false,
      });
    });

    it("returns null and does not touch messages on abort error", async () => {
      const getCaptured = mockStdout();
      seedConversation();
      const err = makeAbortError();
      mock.method(aiDeps, "generateText", () => Promise.reject(err));
      const result = await getConversationSummary();
      assert.strictEqual(result, null);
      assert.strictEqual(getState().abortControllers.apiStream, null);
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [{ compacted: "prior summary", compactedAt: 1, tokens: 10 }],
        messages: [
          { role: "assistant", content: "prior summary" },
          { role: "user", content: "not yet summarized" },
        ],
      });
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: 85_000,
        dirty: false,
      });
      assert.strictEqual(stripAnsi(getCaptured()), "");
    });

    it("resolves the queued editor input on abort error", async () => {
      seedConversation();
      actions.setRl(makeFakeRl());
      actions.setEditorInputValue("queued input");
      const getCaptured = mockStdout();
      const err = makeAbortError();
      mock.method(aiDeps, "generateText", () => Promise.reject(err));
      const result = await getConversationSummary();
      assert.strictEqual(result, null);
      assert.strictEqual(getState().app.editorInputValue, "queued input");
      assert.strictEqual(getState().abortControllers.apiStream, null);
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `You have queued messages! Edit them with {"name":"g","ctrl":true} or press enter to continue\n`,
      );
    });
  });

  describe("getMergedSummaries", () => {
    beforeEach(() => {
      actions.setContextWindowPerModel({ "claude-sonnet-4-20250514": 100_000 });
      mock.method(Date, "now", () => 42);
    });

    const usage = makeMockUsage();

    const seedSummaries = () => {
      for (const i of [1, 2, 3, 4, 5]) {
        actions.setSummaries([
          ...getState().app.conversation.summaries,
          { compacted: `summary ${String(i)}`, compactedAt: i, tokens: 100 },
        ]);
        actions.appendToConversation({
          role: "assistant",
          content: `summary ${String(i)}`,
        });
      }
    };

    it("returns the existing summaries without calling the api when below the summary max", async () => {
      actions.setSummaries([
        { compacted: "summary", compactedAt: 1, tokens: 100 },
      ]);
      let called = false;
      mock.method(aiDeps, "generateText", () => {
        called = true;
        return Promise.resolve(makeGenerateTextResult());
      });
      const result = await getMergedSummaries();
      assert.strictEqual(called, false);
      assert.deepStrictEqual(result, [
        { compacted: "summary", compactedAt: 1, tokens: 100 },
      ]);
    });

    it("merges the two summaries with the smallest largerCompactedAt when at the summary max", async () => {
      seedSummaries();
      let capturedOpts: Record<string, unknown> | undefined;
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return Promise.resolve(
          makeGenerateTextResult({
            output: { compacted: "merged summary" },
            usage,
          }),
        );
      });
      const getMessages = () => getCapturedMessages(capturedOpts);
      const result = await getMergedSummaries();
      const capturedMessage = getMessages()[0];
      assert(capturedMessage !== undefined);
      assert.strictEqual(
        capturedMessage.content,
        `Merge the following two summaries into one. Output a maximum of 30000 characters:\n["summary 1","summary 2"]\n`,
      );
      assert.deepStrictEqual(result, [
        { compacted: "merged summary", compactedAt: 42, tokens: 25_000 },
        { compacted: "summary 3", compactedAt: 3, tokens: 100 },
        { compacted: "summary 4", compactedAt: 4, tokens: 100 },
        { compacted: "summary 5", compactedAt: 5, tokens: 100 },
      ]);
      assert.deepStrictEqual(getState().app.conversation.summaries, [
        { compacted: "summary 1", compactedAt: 1, tokens: 100 },
        { compacted: "summary 2", compactedAt: 2, tokens: 100 },
        { compacted: "summary 3", compactedAt: 3, tokens: 100 },
        { compacted: "summary 4", compactedAt: 4, tokens: 100 },
        { compacted: "summary 5", compactedAt: 5, tokens: 100 },
      ]);
      assert.deepStrictEqual(getState().app.modelUsageForSession, {
        "claude-sonnet-4-20250514": [
          {
            inputTokens: 0,
            outputTokens: 25_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            date: 42,
          },
        ],
      });
    });

    it("does not mutate the existing state summaries when merging", async () => {
      seedSummaries();
      mock.method(aiDeps, "generateText", () =>
        Promise.resolve(
          makeGenerateTextResult({
            output: { compacted: "merged summary" },
            usage,
          }),
        ),
      );
      await getMergedSummaries();
      assert.deepStrictEqual(getState().app.conversation.summaries, [
        { compacted: "summary 1", compactedAt: 1, tokens: 100 },
        { compacted: "summary 2", compactedAt: 2, tokens: 100 },
        { compacted: "summary 3", compactedAt: 3, tokens: 100 },
        { compacted: "summary 4", compactedAt: 4, tokens: 100 },
        { compacted: "summary 5", compactedAt: 5, tokens: 100 },
      ]);
    });

    it("uses a structured output schema when compactWithStructuredOutput is true", async () => {
      seedSummaries();
      let capturedOpts: Record<string, unknown> | undefined;
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return Promise.resolve(
          makeGenerateTextResult({
            output: { compacted: "merged summary" },
            usage,
          }),
        );
      });
      await getMergedSummaries();
      assert(capturedOpts !== undefined);
      assert.strictEqual("output" in capturedOpts, true);
    });

    it("uses the plain text result when compactWithStructuredOutput is false", async () => {
      seedSummaries();
      actions.setCompactWithStructuredOutput(false);
      let capturedOpts: Record<string, unknown> | undefined;
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return Promise.resolve(
          makeGenerateTextResult({ text: "plain merged summary", usage }),
        );
      });
      const result = await getMergedSummaries();
      assert(capturedOpts !== undefined);
      assert.strictEqual("output" in capturedOpts, false);
      assert.deepStrictEqual(result, [
        { compacted: "plain merged summary", compactedAt: 42, tokens: 25_000 },
        { compacted: "summary 3", compactedAt: 3, tokens: 100 },
        { compacted: "summary 4", compactedAt: 4, tokens: 100 },
        { compacted: "summary 5", compactedAt: 5, tokens: 100 },
      ]);
    });
    it("falls back to approximated tokens when usage has no outputTokens", async () => {
      seedSummaries();
      mock.method(aiDeps, "generateText", () =>
        Promise.resolve(
          makeGenerateTextResult({
            output: { compacted: "twelve chars ≈ four tokens" },
            usage: makeMockUsage({ outputTokens: undefined }),
          }),
        ),
      );
      const result = await getMergedSummaries();
      const mergedSummary = result[0];
      assert(mergedSummary !== undefined);
      assert.strictEqual(
        mergedSummary.tokens,
        strToApproxTokens("twelve chars ≈ four tokens"),
      );
    });

    it("keeps the existing summaries when generateText fails", async () => {
      seedSummaries();
      mock.method(aiDeps, "generateText", () =>
        Promise.reject(new Error("network error")),
      );
      const result = await getMergedSummaries();
      assert.strictEqual(result, getState().app.conversation.summaries);
      assert.deepStrictEqual(getState().app.conversation.summaries, [
        { compacted: "summary 1", compactedAt: 1, tokens: 100 },
        { compacted: "summary 2", compactedAt: 2, tokens: 100 },
        { compacted: "summary 3", compactedAt: 3, tokens: 100 },
        { compacted: "summary 4", compactedAt: 4, tokens: 100 },
        { compacted: "summary 5", compactedAt: 5, tokens: 100 },
      ]);
    });

    it("returns the existing summaries and clears the abort controller on abort error", async () => {
      seedSummaries();
      const err = makeAbortError();
      mock.method(aiDeps, "generateText", () => Promise.reject(err));
      const result = await getMergedSummaries();
      assert.strictEqual(getState().abortControllers.apiStream, null);
      assert.deepStrictEqual(result, [
        { compacted: "summary 1", compactedAt: 1, tokens: 100 },
        { compacted: "summary 2", compactedAt: 2, tokens: 100 },
        { compacted: "summary 3", compactedAt: 3, tokens: 100 },
        { compacted: "summary 4", compactedAt: 4, tokens: 100 },
        { compacted: "summary 5", compactedAt: 5, tokens: 100 },
      ]);
    });
  });
});
