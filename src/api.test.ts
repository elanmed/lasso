import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import type { ModelMessage } from "ai";
import { safeStringify } from "./utils.ts";
import { strToApproxTokens } from "./tokens.ts";
import { actions, getState, type MCPToolSet } from "./state.ts";
import {
  maybeCompactMessageParams,
  resolveApiCall,
  warnOnLargeSystemInstructions,
} from "./api.ts";
import { harnessTools } from "./tools.ts";
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
} from "./test-helpers.ts";
import { aiDeps } from "./deps.ts";
import { promptDeps } from "./state.ts";

describe("api", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext({ model: "claude-sonnet-4-20250514" });
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

    it("resolves the queued editor input when the api call is interrupted", async () => {
      actions.setChatHistoryPath("/tmp/test-history.log");
      actions.setRl(makeFakeRl());
      actions.setEditorInputValue("queued input");
      const err = new Error("aborted");
      err.name = "AbortError";
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
      const err = new Error("aborted");
      err.name = "AbortError";
      mock.method(aiDeps, "generateText", () => Promise.reject(err));
      const result = await resolveApiCall("hello");
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: 16,
        tokensStale: true,
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: "[Interrupted before a response was generated]",
          },
        ],
      });
    });

    it("appends usage and messages on success", async () => {
      mock.method(aiDeps, "generateText", () =>
        Promise.resolve(
          makeGenerateTextResult({
            usage: {
              inputTokens: 42,
              outputTokens: 7,
              inputTokenDetails: {
                cacheReadTokens: 3,
                cacheWriteTokens: 1,
              },
            },
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
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: 49,
        tokensStale: false,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "tool call" },
          { role: "tool", content: "tool result" },
        ],
      });
    });

    it("sets tokens to input plus output tokens on each call", async () => {
      await resolveApiCall("first");
      assert.strictEqual(getState().app.messageParams.tokens, 15);

      mock.method(aiDeps, "generateText", () =>
        Promise.resolve(
          makeGenerateTextResult({
            usage: {
              inputTokens: 14,
              outputTokens: 3,
              inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
            responseMessages: [{ role: "assistant", content: "answer" }],
          }),
        ),
      );
      await resolveApiCall("second");
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: 17,
        tokensStale: false,
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
          { role: "assistant", content: "answer" },
        ],
      });
    });

    it("re-baselines tokens from usage when stale after model switch", async () => {
      actions.appendToMessageParams({ role: "user", content: "existing" });
      actions.setMessageParamTokens(100);
      actions.setMessageParamTokensStale(true);
      mock.method(aiDeps, "generateText", () =>
        Promise.resolve(
          makeGenerateTextResult({
            usage: {
              inputTokens: 50,
              outputTokens: 5,
              inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
            responseMessages: [{ role: "assistant", content: "answer" }],
          }),
        ),
      );
      await resolveApiCall("hello");
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: 55,
        tokensStale: false,
        messages: [
          { role: "user", content: "existing" },
          { role: "user", content: "hello" },
          { role: "assistant", content: "answer" },
        ],
      });
    });

    it("creates temp file on tool call start for create_file", async () => {
      mockGenerateText((options: Record<string, unknown>) => {
        const onStart = options["onToolExecutionStart"] as (
          arg: Record<string, unknown>,
        ) => void;
        onStart({
          toolCall: {
            toolName: "create_file",
            toolCallId: "call-11",
            input: { path: "/test/file.txt" },
          },
        });
        return Promise.resolve(makeGenerateTextResult());
      });
      await resolveApiCall("create file");
      assert.ok(testFs._files.has("/tmp/lasso-test-uuid.txt"));
    });

    it("creates temp file on tool call start for str_replace", async () => {
      testFs._files.set("/test/file.txt", "original content");
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        const onStart = opts["onToolExecutionStart"] as (
          arg: Record<string, unknown>,
        ) => void;
        onStart({
          toolCall: {
            toolName: "str_replace",
            toolCallId: "call-1",
            input: { path: "/test/file.txt" },
          },
        });
        return makeGenerateTextResult();
      });
      await resolveApiCall("edit file");
      assert.ok(testFs._files.has("/tmp/lasso-test-uuid.txt"));
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        "original content",
      );
    });

    it("creates temp file on tool call start for insert_lines", async () => {
      testFs._files.set("/test/file.txt", "original");
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        const onStart = opts["onToolExecutionStart"] as (
          arg: Record<string, unknown>,
        ) => void;
        onStart({
          toolCall: {
            toolName: "insert_lines",
            toolCallId: "call-2",
            input: { path: "/test/file.txt" },
          },
        });
        return makeGenerateTextResult();
      });
      await resolveApiCall("edit file");
      assert.ok(testFs._files.has("/tmp/lasso-test-uuid.txt"));
    });

    it("does not create temp file for non-file tools", async () => {
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        const onStart = opts["onToolExecutionStart"] as (
          arg: Record<string, unknown>,
        ) => void;
        onStart({
          toolCall: {
            toolName: "bash",
            toolCallId: "call-3",
            input: { command: "ls" },
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
              toolName: "str_replace",
              toolCallId: "call-1",
              input: { path: "/test/file.txt" },
            },
          });
          await onFinish({
            toolCall: {
              toolName: "str_replace",
              toolCallId: "call-1",
              input: { path: "/test/file.txt" },
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
        "\n━━ File change: /test/file.txt ━━\n+added line\n\n",
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
              toolName: "str_replace",
              toolCallId: "call-1",
              input: { path: "/test/file.txt" },
            },
          });
          await onFinish({
            toolCall: {
              toolName: "str_replace",
              toolCallId: "call-1",
              input: { path: "/test/file.txt" },
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
      actions.appendToMessageParams({ role: "user", content: "previous" });
      actions.appendToMessageParams({ role: "assistant", content: "response" });
      let capturedMessages: ModelMessage[] = [];
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        capturedMessages = opts["messages"] as ModelMessage[];
        return makeGenerateTextResult();
      });
      await resolveApiCall("hello");
      assert.strictEqual(capturedMessages.length, 3);
      assert.deepStrictEqual(capturedMessages[0], {
        role: "user",
        content: "previous",
      });
      assert.deepStrictEqual(capturedMessages[1], {
        role: "assistant",
        content: "response",
      });
      assert.deepStrictEqual(capturedMessages[2], {
        role: "user",
        content: "hello",
      });
    });
  });

  describe("warnOnLargeSystemInstructions", () => {
    beforeEach(() => {
      actions.setContextWindowPerModel({ "claude-sonnet-4-20250514": 100_000 });
    });

    function getSystemInstructionsRatio() {
      return (
        (strToApproxTokens(promptDeps.getSystemContent()) +
          strToApproxTokens(safeStringify(harnessTools))) /
        100_000
      );
    }

    it("returns early without a warning when the model has no context window", () => {
      actions.setContextWindowPerModel({});
      const getCaptured = mockStdout();
      warnOnLargeSystemInstructions();
      assert.strictEqual(stripAnsi(getCaptured()), "");
    });

    it("does not warn when system instructions are below the dedicated share", () => {
      mock.method(promptDeps, "getSystemContent", () => "s".repeat(30_000));
      const getCaptured = mockStdout();
      warnOnLargeSystemInstructions();
      assert.strictEqual(getSystemInstructionsRatio() < 0.5, true);
      assert.strictEqual(stripAnsi(getCaptured()), "");
    });

    it("warns when system instructions reach the dedicated share", () => {
      const systemContent = "s".repeat(150_000);
      mock.method(promptDeps, "getSystemContent", () => systemContent);
      const getCaptured = mockStdout();
      warnOnLargeSystemInstructions();
      assert.strictEqual(getSystemInstructionsRatio() >= 0.5, true);
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `The current set of context, skills, and tools is 51.91% of the 100,000 token context window!

Lasso reserves 50% of the context window for compacted summaries and 30% for system instructions. As is, the system instructions may breach the llm's context window and cause API calls to be rejected. Consider converting some of your context to skills and minimizing MCP servers.\n`,
      );
    });
  });

  describe("maybeCompactMessageParams", () => {
    beforeEach(() => {
      actions.setContextWindowPerModel({ "claude-sonnet-4-20250514": 100_000 });
    });

    const getApproxAdditions = () =>
      strToApproxTokens(
        safeStringify({ ...harnessTools, ...getState().mcp.tools }),
      ) + strToApproxTokens(promptDeps.getSystemContent());

    it("returns early when below the compact threshold", async () => {
      actions.appendToMessageParams({ role: "user", content: "hi" });
      actions.setMessageParamTokens(60_000);
      let called = false;
      mock.method(aiDeps, "generateText", () => {
        called = true;
        return Promise.resolve(makeGenerateTextResult());
      });
      await maybeCompactMessageParams("hi");
      assert.strictEqual(called, false);
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: 60_000,
        tokensStale: false,
        messages: [{ role: "user", content: "hi" }],
      });
    });

    it("uses approximated tokens when stale to decide compaction", async () => {
      const longUserContent = "a".repeat(240_000);
      actions.appendToMessageParams({
        role: "user",
        content: longUserContent,
      });
      actions.setMessageParamTokens(0);
      actions.setMessageParamTokensStale(true);
      let capturedMessages: ModelMessage[] = [];
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        capturedMessages = opts["messages"] as ModelMessage[];
        return Promise.resolve(
          makeGenerateTextResult({
            output: { compacted: "compacted summary" },
            usage: {
              inputTokens: 0,
              outputTokens: 25_000,
              inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
          }),
        );
      });
      await maybeCompactMessageParams("hi");
      assert.strictEqual(capturedMessages.length, 1);
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: 25_000 + getApproxAdditions(),
        tokensStale: false,
        messages: [{ role: "assistant", content: "compacted summary" }],
      });
    });

    it("returns early when approximated tokens are below the compact threshold only even when stale", async () => {
      const longUserContent = "a".repeat(20_000);
      actions.appendToMessageParams({
        role: "user",
        content: longUserContent,
      });
      actions.setMessageParamTokens(2_000);
      actions.setMessageParamTokensStale(true);
      let called = false;
      mock.method(aiDeps, "generateText", () => {
        called = true;
        return Promise.resolve(makeGenerateTextResult());
      });
      await maybeCompactMessageParams("hi");
      assert.strictEqual(called, false);
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: 2_000,
        tokensStale: true,
        messages: [{ role: "user", content: longUserContent }],
      });
    });

    it("includes the system prompt in the stale approximation when deciding compaction", async () => {
      const systemContent = "s".repeat(100_000);
      mock.method(promptDeps, "getSystemContent", () => systemContent);
      const longUserContent = "a".repeat(150_000);
      actions.appendToMessageParams({
        role: "user",
        content: longUserContent,
      });
      actions.setMessageParamTokens(0);
      actions.setMessageParamTokensStale(true);
      let called = false;
      mock.method(aiDeps, "generateText", () => {
        called = true;
        return Promise.resolve(
          makeGenerateTextResult({ output: { compacted: "" } }),
        );
      });
      await maybeCompactMessageParams("hi");
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
      actions.appendToMessageParams({
        role: "user",
        content: longUserContent,
      });
      actions.setMessageParamTokens(0);
      actions.setMessageParamTokensStale(true);
      let called = false;
      mock.method(aiDeps, "generateText", () => {
        called = true;
        return Promise.resolve(
          makeGenerateTextResult({ output: { compacted: "" } }),
        );
      });
      await maybeCompactMessageParams("hi");
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
      actions.appendToMessageParams({ role: "user", content: "hi" });
      actions.setMessageParamTokens(85_000);
      mock.method(aiDeps, "generateText", () =>
        Promise.resolve(
          makeGenerateTextResult({
            output: { compacted: "compacted summary" },
            usage: {
              inputTokens: 0,
              outputTokens: 25_000,
              inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
          }),
        ),
      );
      await maybeCompactMessageParams("hi");
      const withMcpTools = strToApproxTokens(
        safeStringify({ ...harnessTools, ...getState().mcp.tools }),
      );
      const withoutMcpTools = strToApproxTokens(safeStringify(harnessTools));
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: 25_000 + withMcpTools,
        tokensStale: false,
        messages: [{ role: "assistant", content: "compacted summary" }],
      });
      assert.strictEqual(withMcpTools > withoutMcpTools, true);
    });

    it("excludes image and file parts from the stale approximation", async () => {
      actions.appendToMessageParams({
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
      actions.setMessageParamTokens(0);
      actions.setMessageParamTokensStale(true);
      let called = false;
      mock.method(aiDeps, "generateText", () => {
        called = true;
        return Promise.resolve(makeGenerateTextResult());
      });
      await maybeCompactMessageParams("hi");
      assert.strictEqual(called, false);
    });

    it("compacts the conversation when above the threshold", async () => {
      actions.appendToMessageParams({ role: "user", content: "hi" });
      actions.setMessageParamTokens(85_000);
      let capturedMessages: ModelMessage[] = [];
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        capturedMessages = opts["messages"] as ModelMessage[];
        return Promise.resolve(
          makeGenerateTextResult({
            output: { compacted: "compacted summary" },
            usage: {
              inputTokens: 0,
              outputTokens: 25_000,
              inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
          }),
        );
      });
      await maybeCompactMessageParams("hi");
      assert.strictEqual(capturedMessages.length, 1);
      const capturedMessage = capturedMessages[0];
      assert(capturedMessage !== undefined);
      assert.strictEqual(
        capturedMessage.content,
        `Compact the following conversation:\n[{"role":"user","content":"hi"}]\n`,
      );
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: 25_000 + getApproxAdditions(),
        tokensStale: false,
        messages: [{ role: "assistant", content: "compacted summary" }],
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
      actions.appendToMessageParams({ role: "user", content: "hi" });
      actions.setMessageParamTokens(80_000);
      let capturedMessages: ModelMessage[] = [];
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        capturedMessages = opts["messages"] as ModelMessage[];
        return Promise.resolve(
          makeGenerateTextResult({
            output: { compacted: "compacted summary" },
            usage: {
              inputTokens: 0,
              outputTokens: 25_000,
              inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
          }),
        );
      });

      // 300 chars ≈ 100 tokens, pushing 80_000 over the 0.8 trigger (80_000 tokens).
      await maybeCompactMessageParams("x".repeat(300));

      assert.strictEqual(capturedMessages.length, 1);
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: 25_000 + getApproxAdditions(),
        tokensStale: false,
        messages: [{ role: "assistant", content: "compacted summary" }],
      });
    });

    it("keeps messages when generateText fails", async () => {
      actions.appendToMessageParams({ role: "user", content: "hi" });
      actions.setMessageParamTokens(85_000);
      mock.method(aiDeps, "generateText", () =>
        Promise.reject(new Error("network error")),
      );
      await maybeCompactMessageParams("hi");
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: 85_000,
        tokensStale: false,
        messages: [{ role: "user", content: "hi" }],
      });
    });

    it("resolves the queued editor input when compaction is aborted", async () => {
      const getCaptured = mockStdout();
      actions.appendToMessageParams({ role: "user", content: "hi" });
      actions.setMessageParamTokens(85_000);
      actions.setRl(makeFakeRl());
      actions.setEditorInputValue("queued input");
      const err = new Error("aborted");
      err.name = "AbortError";
      mock.method(aiDeps, "generateText", () => Promise.reject(err));
      await maybeCompactMessageParams("hi");
      assert.strictEqual(getState().abortControllers.apiStream, null);
      assert.strictEqual(getState().app.editorInputValue, "queued input");
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `Compacting…\nYou have queued messages! Edit them with {"name":"g","ctrl":true} or press enter to continue\n`,
      );
    });

    it("keeps messages on abort error during compaction", async () => {
      const getCaptured = mockStdout();
      actions.appendToMessageParams({ role: "user", content: "hi" });
      actions.setMessageParamTokens(85_000);
      const err = new Error("aborted");
      err.name = "AbortError";
      mock.method(aiDeps, "generateText", () => Promise.reject(err));
      await maybeCompactMessageParams("hi");
      assert.strictEqual(getState().abortControllers.apiStream, null);
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: 85_000,
        tokensStale: false,
        messages: [{ role: "user", content: "hi" }],
      });
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `Compacting…
`,
      );
    });

    it("resets messages before the api call so the summary and new user input are both sent", async () => {
      actions.appendToMessageParams({ role: "user", content: "old" });
      actions.setMessageParamTokens(85_000);
      const calls: ModelMessage[][] = [];
      let callCount = 0;
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        calls.push(opts["messages"] as ModelMessage[]);
        const overrides = (() => {
          if (callCount === 0) {
            return {
              output: { compacted: "compacted summary" },
              usage: {
                inputTokens: 0,
                outputTokens: 25,
                inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
              },
            };
          }
          return {
            text: "answer text",
            usage: {
              inputTokens: 0,
              outputTokens: 25,
              inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
            responseMessages: [{ role: "assistant", content: "answer text" }],
          };
        })();
        callCount = callCount + 1;
        return Promise.resolve(makeGenerateTextResult(overrides));
      });
      await maybeCompactMessageParams("new input");
      await resolveApiCall("new input");
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: 25,
        tokensStale: false,
        messages: [
          { role: "assistant", content: "compacted summary" },
          { role: "user", content: "new input" },
          { role: "assistant", content: "answer text" },
        ],
      });
      const compactionCall = calls[0];
      assert(compactionCall !== undefined);
      assert.deepStrictEqual(compactionCall, [
        {
          role: "user",
          content: `Compact the following conversation:\n[{"role":"user","content":"old"}]\n`,
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
  });
});
