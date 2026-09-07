import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { actions, getState } from "./state.ts";
import { maybeCompactMessageParams, resolveApiCall } from "./api.ts";
import {
  setupTestContext,
  setupApiCallState,
  testFs,
  mockExec,
  mockStdout,
  stripAnsi,
  makeGenerateTextResult,
} from "./test-helpers.ts";
import { aiDeps } from "./deps.ts";
import { BASE_SYSTEM_PROMPT } from "./prompts.ts";
import type { ModelMessage } from "ai";

describe("api", () => {
  beforeEach(() => {
    setupTestContext();
    setupApiCallState();
    actions.setModel("claude-sonnet-4-20250514");
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
        `1970-01-01T00:00:00.000Z  *assistant*

---
response text

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

    it("returns null on abort error", async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      mock.method(aiDeps, "generateText", () => Promise.reject(err));
      const result = await resolveApiCall("hello");
      assert.strictEqual(result, null);
    });

    it("appends usage and messages on success", async () => {
      mock.method(aiDeps, "generateText", () =>
        Promise.resolve(
          makeGenerateTextResult({
            totalUsage: {
              inputTokens: 42,
              outputTokens: 7,
              inputTokenDetails: {
                cacheReadTokens: 3,
                cacheWriteTokens: 1,
              },
            },
            response: {
              messages: [
                { role: "assistant", content: "tool call" },
                { role: "tool", content: "tool result" },
              ],
            },
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
            totalUsage: {
              inputTokens: 14,
              outputTokens: 3,
              inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
            response: {
              messages: [{ role: "assistant", content: "answer" }],
            },
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
            totalUsage: {
              inputTokens: 50,
              outputTokens: 5,
              inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
            response: {
              messages: [{ role: "assistant", content: "answer" }],
            },
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

    it("creates temp file on tool call start for str_replace", async () => {
      testFs._files.set("/test/file.txt", "original content");
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        const onStart = opts["experimental_onToolCallStart"] as (
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
        const onStart = opts["experimental_onToolCallStart"] as (
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
        const onStart = opts["experimental_onToolCallStart"] as (
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
          const onStart = opts["experimental_onToolCallStart"] as (
            arg: Record<string, unknown>,
          ) => void;
          const onFinish = opts["experimental_onToolCallFinish"] as (
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
            success: true,
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
          const onStart = opts["experimental_onToolCallStart"] as (
            arg: Record<string, unknown>,
          ) => void;
          const onFinish = opts["experimental_onToolCallFinish"] as (
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
            success: false,
          });
          return makeGenerateTextResult();
        },
      );
      await resolveApiCall("edit file");
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
    });

    it("passes system content from context and skills", async () => {
      actions.setContextStr("CTX: project context");
      actions.setSkillsStr("SKILLS: available skills");
      let capturedSystem: string | undefined;
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        capturedSystem = opts["system"] as string;
        return makeGenerateTextResult();
      });
      await resolveApiCall("hello");
      assert.strictEqual(
        capturedSystem,
        `${BASE_SYSTEM_PROMPT}
CTX: project context
SKILLS: available skills`,
      );
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

  describe("maybeCompactMessageParams", () => {
    beforeEach(() => {
      actions.setContextWindowPerModel({ "claude-sonnet-4-20250514": 100_000 });
      actions.setCompactTriggerRatio(0.7);
      actions.setCompactTargetRatio(0.3);
    });

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

    it("returns early when tokens are stale", async () => {
      actions.appendToMessageParams({ role: "user", content: "hi" });
      actions.setMessageParamTokens(80_000);
      actions.setMessageParamTokensStale(true);
      let called = false;
      mock.method(aiDeps, "generateText", () => {
        called = true;
        return Promise.resolve(makeGenerateTextResult());
      });
      await maybeCompactMessageParams("hi");
      assert.strictEqual(called, false);
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: 80_000,
        tokensStale: true,
        messages: [{ role: "user", content: "hi" }],
      });
    });

    it("compacts the conversation when above the threshold", async () => {
      actions.setCompactTargetRatio(0.25);
      actions.appendToMessageParams({ role: "user", content: "hi" });
      actions.setMessageParamTokens(80_000);
      let capturedMessages: ModelMessage[] = [];
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        capturedMessages = opts["messages"] as ModelMessage[];
        return Promise.resolve(
          makeGenerateTextResult({
            text: "compacted summary",
            totalUsage: {
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
        `Compact the following conversation. Your summary must be less than 25000 tokens:\n[{"role":"user","content":"hi"}]\n`,
      );
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: 25_000,
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
      actions.setCompactTargetRatio(0.25);
      actions.appendToMessageParams({ role: "user", content: "hi" });
      actions.setMessageParamTokens(70_000);
      let capturedMessages: ModelMessage[] = [];
      mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
        capturedMessages = opts["messages"] as ModelMessage[];
        return Promise.resolve(
          makeGenerateTextResult({
            text: "compacted summary",
            totalUsage: {
              inputTokens: 0,
              outputTokens: 25_000,
              inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
          }),
        );
      });

      // 300 chars ≈ 100 tokens, pushing 70_000 over the 0.7 trigger (70_000 tokens).
      await maybeCompactMessageParams("x".repeat(300));

      assert.strictEqual(capturedMessages.length, 1);
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: 25_000,
        tokensStale: false,
        messages: [{ role: "assistant", content: "compacted summary" }],
      });
    });

    it("warns when compaction does not reach the target", async () => {
      const getCaptured = mockStdout();
      actions.setCompactTargetRatio(0.25);
      actions.appendToMessageParams({ role: "user", content: "hi" });
      actions.setMessageParamTokens(80_000);
      mock.method(aiDeps, "generateText", () =>
        Promise.resolve(
          makeGenerateTextResult({
            text: "compacted summary",
            totalUsage: {
              inputTokens: 0,
              outputTokens: 30_000,
              inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
          }),
        ),
      );
      await maybeCompactMessageParams("hi");
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: 30_000,
        tokensStale: false,
        messages: [{ role: "assistant", content: "compacted summary" }],
      });
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `Compacting…
Compacted to 30,000, 5,000 over the target.
`,
      );
    });

    it("keeps messages when generateText fails", async () => {
      actions.appendToMessageParams({ role: "user", content: "hi" });
      actions.setMessageParamTokens(80_000);
      mock.method(aiDeps, "generateText", () =>
        Promise.reject(new Error("network error")),
      );
      await maybeCompactMessageParams("hi");
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: 80_000,
        tokensStale: false,
        messages: [{ role: "user", content: "hi" }],
      });
    });

    it("keeps messages and prints Interrupted compaction on abort error", async () => {
      const getCaptured = mockStdout();
      actions.appendToMessageParams({ role: "user", content: "hi" });
      actions.setMessageParamTokens(80_000);
      const err = new Error("aborted");
      err.name = "AbortError";
      mock.method(aiDeps, "generateText", () => Promise.reject(err));
      await maybeCompactMessageParams("hi");
      assert.strictEqual(getState().abortControllers.apiStream, null);
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: 80_000,
        tokensStale: false,
        messages: [{ role: "user", content: "hi" }],
      });
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `Compacting…
Interrupted compaction!
`,
      );
    });
  });
});
