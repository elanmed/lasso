import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import { harnessTools, stringifyTools } from "./tools.ts";
import {
  getSystemContent,
  getToolsContentStr,
  strToApproxTokens,
} from "./tokens.ts";
import { startLoadingState } from "./printing.ts";
import { initSigInt } from "./commands.ts";
import { actions, getState, type MCPToolSet } from "./state.ts";
import { markdownFence, stringify, parseFrontMatter } from "./utils.ts";
import { defaultConfig } from "./schemas.ts";
import { getMergeSummariesPrompt } from "./prompts.ts";
import { getGlobalContextDir, getGlobalConfigPath } from "./paths.ts";
import {
  maybeCompact,
  splitMessagesToCompact,
  getConversationSummary,
  getMergedSummaries,
  resolveApiCall,
  getContextFilesStr,
  getContextEntries,
  getSkillsStr,
  getSkills,
  getSkillJSON,
  getPrettyApiDuration,
  initState,
  initStateRepeatable,
  resolveInterruptWithEditor,
  parseInputFromEditor,
  resolveUserInput,
  executeUserInput,
} from "./app.ts";
import {
  setupTestContext,
  testFs,
  mockExec,
  mockStdoutWrites,
  BLUE,
  RESET,
  YELLOW,
  GREY,
  BOLD,
  BOLD_RESET,
  makeGenerateTextResult,
  mockGenerateText,
  makeMcpTool,
  makeFakeRl,
  getTestRl,
  getCapturedTool,
  getCapturedMessages,
  makeMockUsage,
  makeAbortError,
  mockGenerateTextResults,
  mockReadlineQuestionResults,
  PURPLE,
  RED,
  mockSetInterval,
  mockClearInterval,
  mockGitLsFilesRejection,
  makeErrnoError,
  mockUserInputSpawn,
  testProcessEnv,
  mockProcessExit,
  testConfig,
  makeFakeRlWithWrites,
} from "./test-helpers.ts";
import { aiDeps, fsDeps } from "./deps.ts";

describe("api", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext({ model: "claude-sonnet-4-20250514" });
    actions.config.setBaseURL("https://api.anthropic.com");
    actions.content.setContextStr("");
    actions.content.setSkillsStr("");
    mock.method(aiDeps, "generateText", () =>
      Promise.resolve(makeGenerateTextResult()),
    );
  });

  describe("resolveApiCall", () => {
    describe("sends the request", () => {
      it("returns text on success", async () => {
        const result = await resolveApiCall("hello");
        assert.strictEqual(result, "response text");
        assert.deepStrictEqual(getState().conversation.transcript, [
          { timestamp: 0, role: "assistant", message: "response text" },
        ]);
      });

      it("passes harness and MCP tools to generateText", async () => {
        let capturedOptions: Record<string, unknown> | undefined;
        const mcpTool = makeMcpTool();
        const mcpTools: MCPToolSet = { mcp_tool: mcpTool };
        actions.mcp.setClientsAndTools({}, mcpTools);
        mockGenerateText(async (options: Record<string, unknown>) => {
          capturedOptions = options;
          return Promise.resolve(makeGenerateTextResult());
        });

        await resolveApiCall("hello");

        assert.strictEqual(
          getCapturedTool(capturedOptions, "mcp_tool"),
          mcpTool,
        );
        getCapturedTool(capturedOptions, "bash");
      });

      it("passes timeouts to generateText", async () => {
        let capturedOptions: Record<string, unknown> | undefined;
        mockGenerateText(async (options: Record<string, unknown>) => {
          capturedOptions = options;
          return Promise.resolve(makeGenerateTextResult());
        });

        await resolveApiCall("hello");

        assert.deepStrictEqual(capturedOptions?.["timeout"], {
          tools: {
            bashMs: 180_000,
            web_fetch_htmlMs: 30_000,
            web_fetch_jsonMs: 30_000,
            load_skillMs: 30_000,
            read_imageMs: 30_000,
            mcp_list_resourcesMs: 30_000,
            mcp_read_resourceMs: 30_000,
          },
        });
      });

      it("passes the configured reasoning to generateText", async () => {
        const captured: Record<string, unknown>[] = [];
        mockGenerateText(async (options: Record<string, unknown>) => {
          captured.push(options);
          return Promise.resolve(makeGenerateTextResult());
        });

        await resolveApiCall("hello");
        assert.strictEqual(captured[0]?.["reasoning"], "provider-default");

        actions.config.setReasoning("high");
        await resolveApiCall("hello");
        assert.strictEqual(captured[1]?.["reasoning"], "high");
      });

      it("passes system content to the api call", async () => {
        const systemContent = getSystemContent();
        let capturedInstructions: string | undefined;
        mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
          capturedInstructions = opts["instructions"] as string;
          return makeGenerateTextResult();
        });
        await resolveApiCall("hello");
        assert.strictEqual(capturedInstructions, systemContent);
      });

      it("includes previous messages in request", async () => {
        actions.conversation.setMessages([
          {
            role: "user",
            content: "previous",
          },
          {
            role: "assistant",
            content: "response",
          },
        ]);
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

    describe("tracks token usage", () => {
      it("marks request input tokens stale on non-abort error", async () => {
        actions.usage.setRequestInputTokens(50);
        actions.usage.setRequestInputTokensStale(false);
        mock.method(aiDeps, "generateText", () =>
          Promise.reject(new Error("network error")),
        );
        const result = await resolveApiCall("hello");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 50,
          stale: true,
          charLength: 0,
        });
      });

      it("leaves the stored token value untouched when marking stale on abort", async () => {
        actions.usage.setRequestInputTokens(50);
        actions.usage.setRequestInputTokensStale(false);
        const err = makeAbortError();
        mock.method(aiDeps, "generateText", () => Promise.reject(err));
        const result = await resolveApiCall("hello");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 50,
          stale: true,
          charLength: 0,
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
        assert.deepStrictEqual(getState().usage.modelUsageForSession, {
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
        assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {});
        assert.deepStrictEqual(getState().conversation.summaries, []);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "user", content: "hello" },
          { role: "assistant", content: "tool call" },
          { role: "tool", content: "tool result" },
        ]);
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 49,
          stale: false,
          charLength: 5931,
        });
      });

      it("sets tokens to input plus output tokens on each call", async () => {
        await resolveApiCall("first");
        assert.strictEqual(getState().usage.requestInputTokens.value, 15);

        mock.method(aiDeps, "generateText", () =>
          Promise.resolve(
            makeGenerateTextResult({
              usage: makeMockUsage({ inputTokens: 14, outputTokens: 3 }),
              responseMessages: [{ role: "assistant", content: "answer" }],
            }),
          ),
        );
        await resolveApiCall("second");
        assert.deepStrictEqual(getState().conversation.summaries, []);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
          { role: "assistant", content: "answer" },
        ]);
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 17,
          stale: false,
          charLength: 5966,
        });
      });

      it("re-baselines tokens from usage when stale after model switch", async () => {
        actions.conversation.setMessages([
          {
            role: "user",
            content: "existing",
          },
        ]);
        actions.usage.setRequestInputTokens(100);
        actions.usage.setRequestInputTokensStale(true);
        mock.method(aiDeps, "generateText", () =>
          Promise.resolve(
            makeGenerateTextResult({
              usage: makeMockUsage({ inputTokens: 50, outputTokens: 5 }),
              responseMessages: [{ role: "assistant", content: "answer" }],
            }),
          ),
        );
        await resolveApiCall("hello");
        assert.deepStrictEqual(getState().conversation.summaries, []);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "user", content: "existing" },
          { role: "user", content: "hello" },
          { role: "assistant", content: "answer" },
        ]);
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 55,
          stale: false,
          charLength: 5968,
        });
      });

      it("uses final step usage for request input tokens when it differs from top-level usage", async () => {
        mock.method(aiDeps, "generateText", () =>
          Promise.resolve(
            makeGenerateTextResult({
              usage: makeMockUsage({ inputTokens: 100, outputTokens: 10 }),
              finalStepUsage: makeMockUsage({
                inputTokens: 14,
                outputTokens: 3,
              }),
              responseMessages: [{ role: "assistant", content: "answer" }],
            }),
          ),
        );
        await resolveApiCall("hello");
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 17,
          stale: false,
          charLength: 5931,
        });
      });

      it("approximates missing final step output tokens from the text", async () => {
        mock.method(aiDeps, "generateText", () =>
          Promise.resolve(
            makeGenerateTextResult({
              finalStepUsage: makeMockUsage({
                inputTokens: 50,
                outputTokens: undefined,
              }),
              responseMessages: [{ role: "assistant", content: "answer" }],
            }),
          ),
        );
        await resolveApiCall("hello");
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 54,
          stale: false,
          charLength: 5931,
        });
      });
    });

    describe("prints tool call start", () => {
      it("prints the [mcp] prefix on mcp tool call start", async () => {
        const getWrites = mockStdoutWrites();
        actions.mcp.setClientsAndTools({}, { mcp_tool: makeMcpTool() });
        mockGenerateText(async (options: Record<string, unknown>) => {
          const onStart = options["onToolExecutionStart"] as (
            arg: Record<string, unknown>,
          ) => Promise<unknown>;
          await onStart({
            toolCall: {
              toolName: "mcp_tool",
              toolCallId: "call-9",
              input: { a: 1 },
            },
          });
          return Promise.resolve(makeGenerateTextResult());
        });
        await resolveApiCall("hello");
        assert.deepStrictEqual(getWrites(), [
          `${BLUE}${BOLD}[mcp] mcp_tool${BOLD_RESET}: {"a":1}${RESET}\n`,
        ]);
      });

      it("prints load_skill details on tool call start", async () => {
        const getWrites = mockStdoutWrites();
        mockGenerateText(async (options: Record<string, unknown>) => {
          const onStart = options["onToolExecutionStart"] as (
            arg: Record<string, unknown>,
          ) => Promise<unknown>;
          await onStart({
            toolCall: {
              toolName: "load_skill",
              toolCallId: "call-10",
              input: { name: "demo" },
            },
          });
          return Promise.resolve(makeGenerateTextResult());
        });
        await resolveApiCall("hello");
        assert.deepStrictEqual(getWrites(), [
          `${BLUE}${BOLD}load_skill${BOLD_RESET}: demo${RESET}\n`,
        ]);
      });

      it("prints web_fetch_html and web_fetch_json details on tool call start", async () => {
        const getWrites = mockStdoutWrites();
        mockGenerateText(async (options: Record<string, unknown>) => {
          const onStart = options["onToolExecutionStart"] as (
            arg: Record<string, unknown>,
          ) => Promise<unknown>;
          await onStart({
            toolCall: {
              toolName: "web_fetch_html",
              toolCallId: "call-11",
              input: { href: "https://example.com" },
            },
          });
          await onStart({
            toolCall: {
              toolName: "web_fetch_json",
              toolCallId: "call-12",
              input: { href: "https://example.com/api" },
            },
          });
          return Promise.resolve(makeGenerateTextResult());
        });
        await resolveApiCall("hello");
        assert.deepStrictEqual(getWrites(), [
          `${BLUE}${BOLD}web_fetch_html${BOLD_RESET}: https://example.com${RESET}\n`,
          `${BLUE}${BOLD}web_fetch_json${BOLD_RESET}: https://example.com/api${RESET}\n`,
        ]);
      });

      it("prints one indented line per subagent task on tool call start", async () => {
        const getWrites = mockStdoutWrites();
        mockGenerateText(async (options: Record<string, unknown>) => {
          const onStart = options["onToolExecutionStart"] as (
            arg: Record<string, unknown>,
          ) => Promise<unknown>;
          await onStart({
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
        assert.deepStrictEqual(getWrites(), [
          `${BLUE}${BOLD}create_subagent${BOLD_RESET}: [claude-sonnet-4-20250514] investigate tests${RESET}\n`,
          `${BLUE}${BOLD}create_subagent${BOLD_RESET}: [claude-sonnet-4-20250514] write code${RESET}\n`,
        ]);
      });
    });

    describe("handles temp files and diffs", () => {
      it("resets the tool edit diffs at the start of the api call", async () => {
        actions.conversation.appendToolEditDiff({
          fileName: "/old.ts",
          diffStdout: "old diff",
        });
        mockGenerateText(() => Promise.resolve(makeGenerateTextResult()));
        await resolveApiCall("hello");
        assert.deepStrictEqual(getState().conversation.toolEditDiffs, []);
      });

      it("creates temp file on tool call start for writing bash tools", async () => {
        testFs._files.set("/test/file.txt", "original content");
        mock.method(
          aiDeps,
          "generateText",
          async (opts: Record<string, unknown>) => {
            const onStart = opts["onToolExecutionStart"] as (
              arg: Record<string, unknown>,
            ) => Promise<unknown>;
            await onStart({
              toolCall: {
                toolName: "bash",
                toolCallId: "call-1",
                input: {
                  fileSystemAccessType: "create-update-delete",
                  filePaths: ["/test/file.txt"],
                  command: "write",
                },
              },
            });
            return makeGenerateTextResult();
          },
        );
        await resolveApiCall("edit file");
        assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), true);
      });

      it("does not create temp file for read-only bash tools", async () => {
        mock.method(
          aiDeps,
          "generateText",
          async (opts: Record<string, unknown>) => {
            const onStart = opts["onToolExecutionStart"] as (
              arg: Record<string, unknown>,
            ) => Promise<unknown>;
            await onStart({
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
          },
        );
        await resolveApiCall("run command");
        assert.strictEqual(
          testFs._files.has("/tmp/lasso-test-uuid.txt"),
          false,
        );
      });

      it("prints diff and cleans up on tool call finish success", async () => {
        const getWrites = mockStdoutWrites();
        testFs._files.set("/test/file.txt", "modified content");
        mock.method(
          aiDeps,
          "generateText",
          async (opts: Record<string, unknown>) => {
            const onStart = opts["onToolExecutionStart"] as (
              arg: Record<string, unknown>,
            ) => Promise<unknown>;
            const onFinish = opts["onToolExecutionEnd"] as (
              arg: Record<string, unknown>,
            ) => Promise<void>;
            await onStart({
              toolCall: {
                toolName: "bash",
                toolCallId: "call-1",
                input: {
                  fileSystemAccessType: "create-update-delete",
                  filePaths: ["/test/file.txt"],
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
                  filePaths: ["/test/file.txt"],
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
        assert.deepStrictEqual(getWrites(), [
          `${BLUE}${BOLD}bash${BOLD_RESET}: write${RESET}\n`,
          "\n",
          `${GREY}━━ ${BOLD}File change: /test/file.txt${BOLD_RESET} ━━${RESET}\n`,
          `+added line\n\n`,
        ]);
        assert.strictEqual(
          testFs._files.has("/tmp/lasso-test-uuid.txt"),
          false,
        );
      });

      it("cleans up without printing diff on tool call finish failure", async () => {
        testFs._files.set("/test/file.txt", "content");
        mock.method(
          aiDeps,
          "generateText",
          async (opts: Record<string, unknown>) => {
            const onStart = opts["onToolExecutionStart"] as (
              arg: Record<string, unknown>,
            ) => Promise<unknown>;
            const onFinish = opts["onToolExecutionEnd"] as (
              arg: Record<string, unknown>,
            ) => Promise<void>;
            await onStart({
              toolCall: {
                toolName: "bash",
                toolCallId: "call-1",
                input: {
                  fileSystemAccessType: "create-update-delete",
                  filePaths: ["/test/file.txt"],
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
                  filePaths: ["/test/file.txt"],
                  command: "write",
                },
              },
              toolOutput: { type: "tool-error" },
            });
            return makeGenerateTextResult();
          },
        );
        await resolveApiCall("edit file");
        assert.strictEqual(
          testFs._files.has("/tmp/lasso-test-uuid.txt"),
          false,
        );
      });
    });

    describe("aborted calls", () => {
      it("resolves the queued editor input when the api call is interrupted", async () => {
        actions.terminal.setRl(makeFakeRl());
        actions.terminal.setEditorInputValue("queued input");
        const err = makeAbortError();
        mock.method(aiDeps, "generateText", () => Promise.reject(err));
        const getWrites = mockStdoutWrites();
        const result = await resolveApiCall("hello");
        assert.strictEqual(result, null);
        assert.strictEqual(
          getState().terminal.editorInputValue,
          "queued input",
        );
        assert.deepStrictEqual(getWrites(), [
          `${YELLOW}You have queued messages!${RESET}\n`,
        ]);
      });

      it("returns null on abort error", async () => {
        const err = makeAbortError();
        mock.method(aiDeps, "generateText", () => Promise.reject(err));
        const result = await resolveApiCall("hello");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getState().conversation.summaries, []);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: "[Interrupted before a response was generated]",
          },
        ]);
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 0,
          stale: true,
          charLength: 0,
        });
      });

      it("clears steering state and reports when the stream is steered", async () => {
        actions.terminal.setIsSteering(true);
        const err = makeAbortError();
        mock.method(aiDeps, "generateText", () => Promise.reject(err));
        const getWrites = mockStdoutWrites();

        const result = await resolveApiCall("hello");

        assert.strictEqual(result, null);
        assert.strictEqual(getState().terminal.isSteering, false);
        assert.deepStrictEqual(getWrites(), [`${PURPLE}Steering…${RESET}\n`]);
      });

      it("preserves completed step messages when interrupted", async () => {
        const err = makeAbortError();
        mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
          const onStepEnd = opts["onStepEnd"] as (stepResult: {
            response: { messages: ModelMessage[] };
          }) => void;
          onStepEnd({
            response: {
              messages: [{ role: "assistant", content: "completed step 1" }],
            },
          });
          onStepEnd({
            response: {
              messages: [{ role: "assistant", content: "completed step 2" }],
            },
          });
          return Promise.reject(err);
        });

        const result = await resolveApiCall("hello");

        assert.strictEqual(result, null);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "user", content: "hello" },
          { role: "assistant", content: "completed step 1" },
          { role: "assistant", content: "completed step 2" },
          {
            role: "assistant",
            content: "[Interrupted before a response was generated]",
          },
        ]);
      });
    });
  });

  describe("maybeCompact", () => {
    beforeEach(() => {
      actions.config.setContextWindowPerModel({
        "claude-sonnet-4-20250514": 100_000,
      });
    });

    describe("decides with approximated tokens", () => {
      it("returns early when below the compact threshold", async () => {
        actions.conversation.setMessages([{ role: "user", content: "hi" }]);
        actions.usage.setRequestInputTokens(60_000);
        actions.usage.setRequestInputTokensStale(false);
        let called = false;
        mock.method(aiDeps, "generateText", () => {
          called = true;
          return Promise.resolve(makeGenerateTextResult());
        });
        await maybeCompact("hi");
        assert.strictEqual(called, false);
        assert.deepStrictEqual(getState().conversation.summaries, []);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "user", content: "hi" },
        ]);
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 60_000,
          stale: false,
          charLength: 0,
        });
      });

      it("uses approximated tokens when stale to decide compaction", async () => {
        const longUserContent = "a".repeat(300_000);
        actions.conversation.setMessages([
          {
            role: "user",
            content: longUserContent,
          },
        ]);
        actions.usage.setRequestInputTokens(0);
        actions.usage.setRequestInputTokensStale(true);
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
        assert.deepStrictEqual(getState().conversation.summaries, [
          { compacted: "compacted summary", compactedAt: 0, tokens: 25_000 },
        ]);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "assistant", content: "compacted summary" },
        ]);
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 26_961,
          stale: false,
          charLength: 5902,
        });
      });

      it("returns early when approximated tokens are below the compact threshold only even when stale", async () => {
        const longUserContent = "a".repeat(20_000);
        actions.conversation.setMessages([
          {
            role: "user",
            content: longUserContent,
          },
        ]);
        actions.usage.setRequestInputTokens(2_000);
        actions.usage.setRequestInputTokensStale(true);
        let called = false;
        mock.method(aiDeps, "generateText", () => {
          called = true;
          return Promise.resolve(makeGenerateTextResult());
        });
        await maybeCompact("hi");
        assert.strictEqual(called, false);
        assert.deepStrictEqual(getState().conversation.summaries, []);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "user", content: longUserContent },
        ]);
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 2_000,
          stale: true,
          charLength: 0,
        });
      });

      it("includes the system prompt in the stale approximation when deciding compaction", async () => {
        const systemContent = "s".repeat(100_000);
        actions.content.setContextStr(systemContent);
        const longUserContent = "a".repeat(190_000);
        actions.conversation.setMessages([
          {
            role: "user",
            content: longUserContent,
          },
        ]);
        actions.usage.setRequestInputTokens(0);
        actions.usage.setRequestInputTokensStale(true);
        let called = false;
        mock.method(aiDeps, "generateText", () => {
          called = true;
          return Promise.resolve(
            makeGenerateTextResult({ output: { compacted: "" } }),
          );
        });
        await maybeCompact("hi");
        const systemContentTokensApprox = strToApproxTokens(systemContent);
        assert.strictEqual(strToApproxTokens(longUserContent) < 95_000, true);
        assert.strictEqual(
          strToApproxTokens(longUserContent) + systemContentTokensApprox >=
            95_000,
          true,
        );
        assert.strictEqual(called, true);
      });

      it("includes the tools in the stale approximation when deciding compaction", async () => {
        const longUserContent = "a".repeat(282_000);
        actions.conversation.setMessages([
          {
            role: "user",
            content: longUserContent,
          },
        ]);
        actions.usage.setRequestInputTokens(0);
        actions.usage.setRequestInputTokensStale(true);
        let called = false;
        mock.method(aiDeps, "generateText", () => {
          called = true;
          return Promise.resolve(
            makeGenerateTextResult({ output: { compacted: "" } }),
          );
        });
        await maybeCompact("hi");
        const toolsTokensApprox = strToApproxTokens(
          stringify(harnessTools, { space: 0 }),
        );
        assert.strictEqual(strToApproxTokens(longUserContent) < 95_000, true);
        assert.strictEqual(
          strToApproxTokens(longUserContent) + toolsTokensApprox >= 95_000,
          true,
        );
        assert.strictEqual(called, true);
      });

      it("excludes image and file parts from the stale approximation", async () => {
        actions.conversation.setMessages([
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "image/png",
                data: "a".repeat(300_000),
              },
              { type: "text", text: "after image" },
            ],
          },
        ]);
        actions.usage.setRequestInputTokens(0);
        actions.usage.setRequestInputTokensStale(true);
        let called = false;
        mock.method(aiDeps, "generateText", () => {
          called = true;
          return Promise.resolve(makeGenerateTextResult());
        });
        await maybeCompact("hi");
        assert.strictEqual(called, false);
      });
    });

    describe("compacts the conversation", () => {
      it("persists each chunk before summarizing the next", async () => {
        actions.config.setContextWindowPerModel({
          "claude-sonnet-4-20250514": 40_000,
        });
        const messages = [
          { role: "user", content: "first: " + "a".repeat(60_000) },
          { role: "assistant", content: "second: " + "b".repeat(60_000) },
        ];
        actions.conversation.setMessages(messages);
        const messagesAfterFirstChunk = [
          { role: "assistant", content: "chunk summary one" },
          ...messages.slice(1),
        ];
        const messagesDuringCalls = [
          messages,
          messagesAfterFirstChunk,
          messagesAfterFirstChunk,
        ];
        actions.usage.setRequestInputTokens(39_000);
        actions.usage.setRequestInputTokensStale(false);
        const calls: Record<string, unknown>[] = [];
        mockGenerateTextResults(
          [
            {
              output: { compacted: "chunk summary one" },
              usage: makeMockUsage({ outputTokens: 11 }),
            },
            {
              output: { compacted: "chunk summary two" },
              usage: makeMockUsage({ outputTokens: 12 }),
            },
            {
              output: { compacted: "merged chunk summary" },
              usage: makeMockUsage({ outputTokens: 13 }),
            },
          ],
          (opts, resultIdx) => {
            calls.push(opts);
            const expectedMessages = messagesDuringCalls[resultIdx];
            assert(expectedMessages !== undefined);
            assert.deepStrictEqual(
              getState().conversation.messages,
              expectedMessages,
            );
          },
        );

        await maybeCompact("");

        assert.deepStrictEqual(getState().conversation.summaries, [
          {
            compacted: "merged chunk summary",
            compactedAt: 0,
            tokens: 13,
          },
        ]);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "assistant", content: "merged chunk summary" },
        ]);
        const mergeCall = calls[2];
        assert(mergeCall !== undefined);
        assert.deepStrictEqual(getCapturedMessages(mergeCall), [
          {
            role: "user",
            content: getMergeSummariesPrompt({
              targetCharLen: 15_000,
              summaries: markdownFence(
                "json",
                '["chunk summary one","chunk summary two"]',
              ),
            }),
          },
        ]);
      });

      it("includes mcp tools in the tokens after compaction", async () => {
        actions.mcp.setClientsAndTools({}, { mcp_tool: makeMcpTool() });
        actions.conversation.setMessages([{ role: "user", content: "hi" }]);
        actions.usage.setRequestInputTokens(96_000);
        actions.usage.setRequestInputTokensStale(false);
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
          stringify({ ...harnessTools, ...getState().mcp.tools }, { space: 0 }),
        );
        const withoutMcpTools = strToApproxTokens(
          stringify(harnessTools, { space: 0 }),
        );
        assert.deepStrictEqual(getState().conversation.summaries, [
          { compacted: "compacted summary", compactedAt: 0, tokens: 25_000 },
        ]);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "assistant", content: "compacted summary" },
        ]);
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 26_987,
          stale: false,
          charLength: 5982,
        });
        assert.strictEqual(withMcpTools > withoutMcpTools, true);
      });

      it("compacts after an API response pushes tokens over the threshold", async () => {
        mockGenerateTextResults([
          {
            text: "answer text",
            usage: makeMockUsage({ inputTokens: 96_000, outputTokens: 1_000 }),
            responseMessages: [{ role: "assistant", content: "answer text" }],
          },
          {
            output: { compacted: "compacted summary" },
            usage: makeMockUsage(),
          },
        ]);

        const result = await resolveApiCall("hi");
        assert.strictEqual(result, "answer text");
        await maybeCompact("");

        assert.deepStrictEqual(getState().conversation.summaries, [
          { compacted: "compacted summary", compactedAt: 0, tokens: 25_000 },
        ]);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "assistant", content: "compacted summary" },
        ]);
      });

      it("compacts the conversation when above the threshold", async () => {
        actions.conversation.setMessages([{ role: "user", content: "hi" }]);
        actions.usage.setRequestInputTokens(96_000);
        actions.usage.setRequestInputTokensStale(false);
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
          `## [lasso] Compact conversation

- Compact the following conversation.
- Summarize into exactly two sections: "## Key facts" and "## Everything else".
- Key facts are details that must survive all future compactions, such as decisions, file paths, task state, and user preferences.
- Write "## Key facts" as a flat bullet list of short, self-contained facts.
- When the maximum length is tight, cut from "## Everything else" and never from "## Key facts."
- Output a plain-text prose summary, not JSON or a code fence.
- Output a maximum of 15000 characters.

\`\`\`json
{"role":"user","content":"hi"}
\`\`\``,
        );
        assert.deepStrictEqual(getState().conversation.summaries, [
          { compacted: "compacted summary", compactedAt: 0, tokens: 25_000 },
        ]);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "assistant", content: "compacted summary" },
        ]);
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 26_961,
          stale: false,
          charLength: 5902,
        });
        assert.deepStrictEqual(getState().usage.modelUsageForSession, {
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
        actions.conversation.setMessages([{ role: "user", content: "hi" }]);
        actions.usage.setRequestInputTokens(95_000);
        actions.usage.setRequestInputTokensStale(false);
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

        // 300 chars ≈ 100 tokens, pushing 95_000 over the 0.95 trigger (95_000 tokens).
        const getMessages = () => getCapturedMessages(capturedOpts);
        await maybeCompact("x".repeat(300));

        assert.strictEqual(getMessages().length, 1);
        assert.deepStrictEqual(getState().conversation.summaries, [
          { compacted: "compacted summary", compactedAt: 0, tokens: 25_000 },
        ]);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "assistant", content: "compacted summary" },
        ]);
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 26_961,
          stale: false,
          charLength: 5902,
        });
      });

      it("compacts against the default context window when the model has none configured", async () => {
        actions.config.setContextWindowPerModel({});
        actions.conversation.setMessages([{ role: "user", content: "hi" }]);
        actions.usage.setRequestInputTokens(122_000);
        actions.usage.setRequestInputTokensStale(false);
        mock.method(aiDeps, "generateText", () =>
          Promise.resolve(
            makeGenerateTextResult({
              output: { compacted: "compacted summary" },
              usage: makeMockUsage(),
            }),
          ),
        );
        await maybeCompact("hi");
        assert.deepStrictEqual(getState().conversation.summaries, [
          { compacted: "compacted summary", compactedAt: 0, tokens: 25_000 },
        ]);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "assistant", content: "compacted summary" },
        ]);
      });

      it("resets messages before the api call so the summary and new user input are both sent", async () => {
        actions.conversation.setMessages([{ role: "user", content: "old" }]);
        actions.usage.setRequestInputTokens(96_000);
        actions.usage.setRequestInputTokensStale(false);
        const calls: ModelMessage[][] = [];
        mockGenerateTextResults(
          [
            {
              output: { compacted: "compacted summary" },
              usage: makeMockUsage({ outputTokens: 25 }),
            },
            {
              text: "answer text",
              usage: makeMockUsage({ outputTokens: 25 }),
              responseMessages: [{ role: "assistant", content: "answer text" }],
            },
          ],
          (opts) => {
            calls.push(opts["messages"] as ModelMessage[]);
          },
        );
        await maybeCompact("new input");
        await resolveApiCall("new input");
        assert.deepStrictEqual(getState().conversation.summaries, [
          { compacted: "compacted summary", compactedAt: 0, tokens: 25 },
        ]);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "assistant", content: "compacted summary" },
          { role: "user", content: "new input" },
          { role: "assistant", content: "answer text" },
        ]);
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 25,
          stale: false,
          charLength: 5984,
        });
        const compactionCall = calls[0];
        assert(compactionCall !== undefined);
        assert.deepStrictEqual(compactionCall, [
          {
            role: "user",
            content: `## [lasso] Compact conversation

- Compact the following conversation.
- Summarize into exactly two sections: "## Key facts" and "## Everything else".
- Key facts are details that must survive all future compactions, such as decisions, file paths, task state, and user preferences.
- Write "## Key facts" as a flat bullet list of short, self-contained facts.
- When the maximum length is tight, cut from "## Everything else" and never from "## Key facts."
- Output a plain-text prose summary, not JSON or a code fence.
- Output a maximum of 15000 characters.

\`\`\`json
{"role":"user","content":"old"}
\`\`\``,
          },
        ]);
        const apiCall = calls[1];
        assert(apiCall !== undefined);
        assert.deepStrictEqual(apiCall, [
          { role: "assistant", content: "compacted summary" },
          { role: "user", content: "new input" },
        ]);
      });
    });

    describe("keeps messages on failure", () => {
      it("keeps unsummarized messages when a later chunk summary fails", async () => {
        actions.config.setContextWindowPerModel({
          "claude-sonnet-4-20250514": 40_000,
        });
        const messages = [
          { role: "user", content: "a".repeat(60_000) },
          { role: "user", content: "b".repeat(60_000) },
          { role: "user", content: "c".repeat(60_000) },
        ];
        actions.conversation.setMessages(messages);
        actions.usage.setRequestInputTokens(39_000);
        actions.usage.setRequestInputTokensStale(false);
        mockGenerateTextResults([
          {
            output: { compacted: "first summary" },
            usage: makeMockUsage({ outputTokens: 11 }),
          },
          new Error("network error"),
        ]);
        await maybeCompact("");
        assert.deepStrictEqual(getState().conversation.summaries, [
          { compacted: "first summary", compactedAt: 0, tokens: 11 },
        ]);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "assistant", content: "first summary" },
          ...messages.slice(1),
        ]);
      });

      it("keeps messages when generateText fails", async () => {
        actions.conversation.setMessages([{ role: "user", content: "hi" }]);
        actions.usage.setRequestInputTokens(96_000);
        actions.usage.setRequestInputTokensStale(false);
        mock.method(aiDeps, "generateText", () =>
          Promise.reject(new Error("network error")),
        );
        await maybeCompact("hi");
        assert.deepStrictEqual(getState().conversation.summaries, []);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "user", content: "hi" },
        ]);
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 96_000,
          stale: false,
          charLength: 0,
        });
      });

      it("resolves the queued editor input when compaction is aborted", async () => {
        const getWrites = mockStdoutWrites();
        actions.conversation.setMessages([{ role: "user", content: "hi" }]);
        actions.usage.setRequestInputTokens(96_000);
        actions.usage.setRequestInputTokensStale(false);
        actions.terminal.setRl(makeFakeRl());
        actions.terminal.setEditorInputValue("queued input");
        const err = makeAbortError();
        mock.method(aiDeps, "generateText", () => Promise.reject(err));
        await maybeCompact("hi");
        assert.strictEqual(getState().abortControllers.apiStream, null);
        assert.strictEqual(
          getState().terminal.editorInputValue,
          "queued input",
        );
        assert.deepStrictEqual(getWrites(), [
          `${BLUE}Compacting…${RESET}\n`,
          `${YELLOW}You have queued messages!${RESET}\n`,
        ]);
      });

      it("keeps messages on abort error during compaction", async () => {
        const getWrites = mockStdoutWrites();
        actions.conversation.setMessages([{ role: "user", content: "hi" }]);
        actions.usage.setRequestInputTokens(96_000);
        actions.usage.setRequestInputTokensStale(false);
        const err = makeAbortError();
        mock.method(aiDeps, "generateText", () => Promise.reject(err));
        await maybeCompact("hi");
        assert.strictEqual(getState().abortControllers.apiStream, null);
        assert.deepStrictEqual(getState().conversation.summaries, []);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "user", content: "hi" },
        ]);
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 96_000,
          stale: false,
          charLength: 0,
        });
        assert.deepStrictEqual(getWrites(), [`${BLUE}Compacting…${RESET}\n`]);
      });

      it("aborts the merge when the controller is aborted after summarizing", async () => {
        for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
          actions.conversation.setSummaries([
            ...getState().conversation.summaries,
            { compacted: `summary ${String(i)}`, compactedAt: i, tokens: 100 },
          ]);
          actions.conversation.setMessages([
            ...getState().conversation.messages,
            { role: "assistant", content: `summary ${String(i)}` },
          ]);
        }
        actions.conversation.setMessages([
          ...getState().conversation.messages,
          { role: "user", content: "hi" },
        ]);
        actions.usage.setRequestInputTokens(96_000);
        actions.usage.setRequestInputTokensStale(false);
        const calls: boolean[] = [];
        mock.method(aiDeps, "generateText", () => {
          const signal = getState().abortControllers.apiStream?.signal;
          const aborted = signal?.aborted === true;
          calls.push(aborted);
          if (aborted) return Promise.reject(makeAbortError());
          getState().abortControllers.apiStream?.abort();
          return Promise.resolve(
            makeGenerateTextResult({
              output: { compacted: "compacted summary" },
              usage: makeMockUsage({ outputTokens: 20 }),
            }),
          );
        });
        await maybeCompact("hi");
        assert.strictEqual(getState().abortControllers.apiStream, null);
        assert.deepStrictEqual(calls, [false, true]);
        assert.deepStrictEqual(
          getState().conversation.summaries.map(({ compacted }) => compacted),
          [
            "summary 1",
            "summary 2",
            "summary 3",
            "summary 4",
            "summary 5",
            "summary 6",
            "summary 7",
            "summary 8",
            "summary 9",
            "summary 10",
            "compacted summary",
          ],
        );
      });
    });

    describe("merges summaries", () => {
      it("merges existing summaries when at the summary max during compaction", async () => {
        for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
          actions.conversation.setSummaries([
            ...getState().conversation.summaries,
            { compacted: `summary ${String(i)}`, compactedAt: i, tokens: 100 },
          ]);
          actions.conversation.setMessages([
            ...getState().conversation.messages,
            { role: "assistant", content: `summary ${String(i)}` },
          ]);
        }
        actions.conversation.setMessages([
          ...getState().conversation.messages,
          { role: "user", content: "hi" },
        ]);
        actions.usage.setRequestInputTokens(96_000);
        actions.usage.setRequestInputTokensStale(false);
        mockGenerateTextResults([
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
        assert.deepStrictEqual(getState().conversation.summaries, [
          { compacted: "merged summary", compactedAt: 0, tokens: 15 },
          { compacted: "summary 3", compactedAt: 3, tokens: 100 },
          { compacted: "summary 4", compactedAt: 4, tokens: 100 },
          { compacted: "summary 5", compactedAt: 5, tokens: 100 },
          { compacted: "summary 6", compactedAt: 6, tokens: 100 },
          { compacted: "summary 7", compactedAt: 7, tokens: 100 },
          { compacted: "summary 8", compactedAt: 8, tokens: 100 },
          { compacted: "summary 9", compactedAt: 9, tokens: 100 },
          { compacted: "summary 10", compactedAt: 10, tokens: 100 },
          { compacted: "compacted summary", compactedAt: 0, tokens: 20 },
        ]);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "assistant", content: "merged summary" },
          { role: "assistant", content: "summary 3" },
          { role: "assistant", content: "summary 4" },
          { role: "assistant", content: "summary 5" },
          { role: "assistant", content: "summary 6" },
          { role: "assistant", content: "summary 7" },
          { role: "assistant", content: "summary 8" },
          { role: "assistant", content: "summary 9" },
          { role: "assistant", content: "summary 10" },
          { role: "assistant", content: "compacted summary" },
        ]);
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 2_796,
          stale: false,
          charLength: 5989,
        });
      });

      it("keeps the existing summaries when merging fails during compaction", async () => {
        for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
          actions.conversation.setSummaries([
            ...getState().conversation.summaries,
            { compacted: `summary ${String(i)}`, compactedAt: i, tokens: 100 },
          ]);
          actions.conversation.setMessages([
            ...getState().conversation.messages,
            { role: "assistant", content: `summary ${String(i)}` },
          ]);
        }
        actions.conversation.setMessages([
          ...getState().conversation.messages,
          { role: "user", content: "hi" },
        ]);
        actions.usage.setRequestInputTokens(96_000);
        actions.usage.setRequestInputTokensStale(false);
        mockGenerateTextResults([
          {
            output: { compacted: "compacted summary" },
            usage: makeMockUsage({ outputTokens: 20 }),
          },
          new Error("network error"),
        ]);
        await maybeCompact("hi");
        assert.deepStrictEqual(getState().conversation.summaries, [
          { compacted: "summary 1", compactedAt: 1, tokens: 100 },
          { compacted: "summary 2", compactedAt: 2, tokens: 100 },
          { compacted: "summary 3", compactedAt: 3, tokens: 100 },
          { compacted: "summary 4", compactedAt: 4, tokens: 100 },
          { compacted: "summary 5", compactedAt: 5, tokens: 100 },
          { compacted: "summary 6", compactedAt: 6, tokens: 100 },
          { compacted: "summary 7", compactedAt: 7, tokens: 100 },
          { compacted: "summary 8", compactedAt: 8, tokens: 100 },
          { compacted: "summary 9", compactedAt: 9, tokens: 100 },
          { compacted: "summary 10", compactedAt: 10, tokens: 100 },
          { compacted: "compacted summary", compactedAt: 0, tokens: 20 },
        ]);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "assistant", content: "summary 1" },
          { role: "assistant", content: "summary 2" },
          { role: "assistant", content: "summary 3" },
          { role: "assistant", content: "summary 4" },
          { role: "assistant", content: "summary 5" },
          { role: "assistant", content: "summary 6" },
          { role: "assistant", content: "summary 7" },
          { role: "assistant", content: "summary 8" },
          { role: "assistant", content: "summary 9" },
          { role: "assistant", content: "summary 10" },
          { role: "assistant", content: "compacted summary" },
        ]);
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 2_981,
          stale: false,
          charLength: 5993,
        });
      });
    });
  });

  describe("splitMessagesToCompact", () => {
    beforeEach(() => {
      actions.config.setContextWindowPerModel({
        "claude-sonnet-4-20250514": 40_000,
      });
    });

    it("excludes prior summaries and groups messages that fit together", () => {
      const priorSummary = { role: "assistant", content: "prior summary" };
      const messages = [
        { role: "user", content: "first message" },
        { role: "assistant", content: "second message" },
      ];
      actions.conversation.setSummaries([
        { compacted: "prior summary", compactedAt: 1, tokens: 10 },
      ]);
      actions.conversation.setMessages([priorSummary, ...messages]);

      assert.deepStrictEqual(splitMessagesToCompact(), [
        [
          '{"role":"user","content":"first message"}',
          '{"role":"assistant","content":"second message"}',
        ],
      ]);
    });

    it("reserves the maximum summary output when calculating the chunk budget", () => {
      const messages = [
        { role: "user", content: "a".repeat(54_000) },
        { role: "assistant", content: "b".repeat(54_000) },
      ];
      actions.conversation.setMessages(messages);

      const chunks = splitMessagesToCompact();
      assert.deepStrictEqual(
        chunks.map((chunk) => chunk.length),
        [1, 1],
      );
      assert.deepStrictEqual(
        chunks.flat(),
        messages.map((message) => JSON.stringify(message)),
      );
    });

    it("splits at the token budget without dropping or reordering messages", () => {
      const priorSummary = { role: "assistant", content: "prior summary" };
      const messages = [
        { role: "user", content: "first: " + "a".repeat(60_000) },
        { role: "assistant", content: "second: " + "b".repeat(60_000) },
        { role: "user", content: "third: " + "c".repeat(60_000) },
      ];
      actions.conversation.setSummaries([
        { compacted: "prior summary", compactedAt: 1, tokens: 10 },
      ]);
      actions.conversation.setMessages([priorSummary, ...messages]);

      const chunks = splitMessagesToCompact();
      assert.deepStrictEqual(
        chunks.map((chunk) => chunk.length),
        [1, 1, 1],
      );
      assert.deepStrictEqual(
        chunks.flat(),
        messages.map((message) => JSON.stringify(message)),
      );
    });

    it("keeps an oversized first message in one nonempty chunk", () => {
      actions.conversation.setMessages([
        { role: "user", content: "a".repeat(300_000) },
      ]);

      const chunks = splitMessagesToCompact();
      assert.deepStrictEqual(
        chunks.map((chunk) => chunk.length),
        [1],
      );
    });
  });

  describe("getConversationSummary", () => {
    beforeEach(() => {
      actions.abortControllers.setApiStream(new AbortController());
      actions.config.setContextWindowPerModel({
        "claude-sonnet-4-20250514": 100_000,
      });
      mock.method(Date, "now", () => 42);
    });

    const usage = makeMockUsage();
    const messageChunk = [
      '{"role":"user","content":"not yet summarized"}',
      '{"role":"assistant","content":"another message"}',
    ];

    const seedConversation = () => {
      actions.conversation.setSummaries([
        { compacted: "prior summary", compactedAt: 1, tokens: 10 },
      ]);
      actions.conversation.setMessages([
        {
          role: "assistant",
          content: "prior summary",
        },
        {
          role: "user",
          content: "not yet summarized",
        },
      ]);
      actions.usage.setRequestInputTokens(85_000);
      actions.usage.setRequestInputTokensStale(false);
    };

    describe("summarizes the conversation", () => {
      it("strips image data from tool results in the compact prompt", async () => {
        actions.conversation.setSummaries([]);
        actions.conversation.setMessages([
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "read_image",
                output: {
                  type: "content",
                  value: [
                    {
                      type: "file",
                      data: { type: "data", data: "IMAGEBYTES" },
                      mediaType: "image/png",
                    },
                  ],
                },
              },
            ],
          },
        ]);
        actions.usage.setRequestInputTokens(85_000);
        actions.usage.setRequestInputTokensStale(false);
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
        const imageMessageChunk = splitMessagesToCompact()[0];
        assert(imageMessageChunk !== undefined);
        await getConversationSummary(imageMessageChunk);
        const capturedMessage = getCapturedMessages(capturedOpts)[0];
        assert(capturedMessage !== undefined);
        assert.doesNotMatch(JSON.stringify(capturedMessage), /IMAGEBYTES/);
      });

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
        await getConversationSummary(messageChunk);
        assert.strictEqual(getMessages().length, 1);
        assert.deepStrictEqual(capturedOpts?.["timeout"], {
          tools: {
            bashMs: 180_000,
            web_fetch_htmlMs: 30_000,
            web_fetch_jsonMs: 30_000,
            load_skillMs: 30_000,
            read_imageMs: 30_000,
            mcp_list_resourcesMs: 30_000,
            mcp_read_resourceMs: 30_000,
          },
        });
        const capturedMessage = getMessages()[0];
        assert(capturedMessage !== undefined);
        assert.strictEqual(
          capturedMessage.content,
          `## [lasso] Compact conversation

- Compact the following conversation.
- Summarize into exactly two sections: "## Key facts" and "## Everything else".
- Key facts are details that must survive all future compactions, such as decisions, file paths, task state, and user preferences.
- Write "## Key facts" as a flat bullet list of short, self-contained facts.
- When the maximum length is tight, cut from "## Everything else" and never from "## Key facts."
- Output a plain-text prose summary, not JSON or a code fence.
- Output a maximum of 15000 characters.

\`\`\`json
{"role":"user","content":"not yet summarized"}
{"role":"assistant","content":"another message"}
\`\`\``,
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
        const result = await getConversationSummary(messageChunk);
        assert.deepStrictEqual(result, {
          compacted: "compacted summary",
          compactedAt: 42,
          tokens: 25_000,
        });
        assert.deepStrictEqual(getState().usage.modelUsageForSession, {
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
        await getConversationSummary(messageChunk);
        assert(capturedOpts !== undefined);
        assert.strictEqual("output" in capturedOpts, true);
      });

      it("uses the plain text result when compactWithStructuredOutput is false", async () => {
        seedConversation();
        actions.config.setCompactWithStructuredOutput(false);
        let capturedOpts: Record<string, unknown> | undefined;
        mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
          capturedOpts = opts;
          return Promise.resolve(
            makeGenerateTextResult({ text: "plain summary", usage }),
          );
        });
        const result = await getConversationSummary(messageChunk);
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
        const result = await getConversationSummary(messageChunk);
        assert.deepStrictEqual(result, {
          compacted: "four chars ≈ one token",
          compactedAt: 42,
          tokens: strToApproxTokens("four chars ≈ one token"),
        });
      });
    });

    describe("returns null on failure", () => {
      it("returns null and does not touch messages when generateText fails", async () => {
        seedConversation();
        mock.method(aiDeps, "generateText", () =>
          Promise.reject(new Error("network error")),
        );
        const result = await getConversationSummary(messageChunk);
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getState().conversation.summaries, [
          { compacted: "prior summary", compactedAt: 1, tokens: 10 },
        ]);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "assistant", content: "prior summary" },
          { role: "user", content: "not yet summarized" },
        ]);
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 85_000,
          stale: false,
          charLength: 0,
        });
      });

      it("returns null and does not touch messages on abort error", async () => {
        const getWrites = mockStdoutWrites();
        seedConversation();
        const err = makeAbortError();
        mock.method(aiDeps, "generateText", () => Promise.reject(err));
        const result = await getConversationSummary(messageChunk);
        assert.strictEqual(result, null);
        assert.notStrictEqual(getState().abortControllers.apiStream, null);
        assert.deepStrictEqual(getState().conversation.summaries, [
          { compacted: "prior summary", compactedAt: 1, tokens: 10 },
        ]);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "assistant", content: "prior summary" },
          { role: "user", content: "not yet summarized" },
        ]);
        assert.deepStrictEqual(getState().usage.requestInputTokens, {
          value: 85_000,
          stale: false,
          charLength: 0,
        });
        assert.deepStrictEqual(getWrites(), []);
      });

      it("resolves the queued editor input on abort error", async () => {
        seedConversation();
        actions.terminal.setRl(makeFakeRl());
        actions.terminal.setEditorInputValue("queued input");
        const getWrites = mockStdoutWrites();
        const err = makeAbortError();
        mock.method(aiDeps, "generateText", () => Promise.reject(err));
        const result = await getConversationSummary(messageChunk);
        assert.strictEqual(result, null);
        assert.strictEqual(
          getState().terminal.editorInputValue,
          "queued input",
        );
        assert.notStrictEqual(getState().abortControllers.apiStream, null);
        assert.deepStrictEqual(getWrites(), [
          `${YELLOW}You have queued messages!${RESET}\n`,
        ]);
      });
    });
  });

  describe("getMergedSummaries", () => {
    beforeEach(() => {
      actions.abortControllers.setApiStream(new AbortController());
      actions.config.setContextWindowPerModel({
        "claude-sonnet-4-20250514": 100_000,
      });
      mock.method(Date, "now", () => 42);
    });

    const usage = makeMockUsage();

    const seedSummaries = () => {
      for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
        actions.conversation.setSummaries([
          ...getState().conversation.summaries,
          { compacted: `summary ${String(i)}`, compactedAt: i, tokens: 100 },
        ]);
        actions.conversation.setMessages([
          {
            role: "assistant",
            content: `summary ${String(i)}`,
          },
        ]);
      }
    };

    describe("merges summaries", () => {
      it("returns the existing summaries without calling the api when below the summary max", async () => {
        actions.conversation.setSummaries([
          { compacted: "summary", compactedAt: 1, tokens: 100 },
        ]);
        let called = false;
        mock.method(aiDeps, "generateText", () => {
          called = true;
          return Promise.resolve(makeGenerateTextResult());
        });
        const result = await getMergedSummaries(
          getState().conversation.summaries,
        );
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
        const result = await getMergedSummaries(
          getState().conversation.summaries,
        );
        const capturedMessage = getMessages()[0];
        assert(capturedMessage !== undefined);
        assert.strictEqual(
          capturedMessage.content,
          `## [lasso] Compact summaries

- Merge the following two summaries into one.
- Build "## Key facts" from the union of the key facts in both summaries.
- Keep every existing key fact: you may deduplicate or reword only when needed, but never change their meaning and never delete one.
- If a key fact is superseded by a later one, delete the outdated one.
- Summarize into exactly two sections: "## Key facts" and "## Everything else".
- Key facts are details that must survive all future compactions, such as decisions, file paths, task state, and user preferences.
- Write "## Key facts" as a flat bullet list of short, self-contained facts.
- When the maximum length is tight, cut from "## Everything else" and never from "## Key facts."
- Output a plain-text prose summary, not JSON or a code fence.
- Output a maximum of 15000 characters.

\`\`\`json
["summary 1","summary 2"]
\`\`\``,
        );
        assert.deepStrictEqual(result, [
          { compacted: "merged summary", compactedAt: 42, tokens: 25_000 },
          { compacted: "summary 3", compactedAt: 3, tokens: 100 },
          { compacted: "summary 4", compactedAt: 4, tokens: 100 },
          { compacted: "summary 5", compactedAt: 5, tokens: 100 },
          { compacted: "summary 6", compactedAt: 6, tokens: 100 },
          { compacted: "summary 7", compactedAt: 7, tokens: 100 },
          { compacted: "summary 8", compactedAt: 8, tokens: 100 },
          { compacted: "summary 9", compactedAt: 9, tokens: 100 },
          { compacted: "summary 10", compactedAt: 10, tokens: 100 },
        ]);
        assert.deepStrictEqual(getState().conversation.summaries, [
          { compacted: "summary 1", compactedAt: 1, tokens: 100 },
          { compacted: "summary 2", compactedAt: 2, tokens: 100 },
          { compacted: "summary 3", compactedAt: 3, tokens: 100 },
          { compacted: "summary 4", compactedAt: 4, tokens: 100 },
          { compacted: "summary 5", compactedAt: 5, tokens: 100 },
          { compacted: "summary 6", compactedAt: 6, tokens: 100 },
          { compacted: "summary 7", compactedAt: 7, tokens: 100 },
          { compacted: "summary 8", compactedAt: 8, tokens: 100 },
          { compacted: "summary 9", compactedAt: 9, tokens: 100 },
          { compacted: "summary 10", compactedAt: 10, tokens: 100 },
        ]);
        assert.deepStrictEqual(getState().usage.modelUsageForSession, {
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

      it("merges when the summaries reach the max for a 40,000 token context window", async () => {
        actions.config.setContextWindowPerModel({
          "claude-sonnet-4-20250514": 40_000,
        });
        actions.conversation.setSummaries([
          { compacted: "summary 1", compactedAt: 1, tokens: 100 },
          { compacted: "summary 2", compactedAt: 2, tokens: 100 },
        ]);
        mock.method(aiDeps, "generateText", () =>
          Promise.resolve(
            makeGenerateTextResult({
              output: { compacted: "merged summary" },
              usage,
            }),
          ),
        );
        const result = await getMergedSummaries(
          getState().conversation.summaries,
        );
        assert.deepStrictEqual(result, [
          { compacted: "merged summary", compactedAt: 42, tokens: 25_000 },
        ]);
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
        await getMergedSummaries(getState().conversation.summaries);
        assert.deepStrictEqual(getState().conversation.summaries, [
          { compacted: "summary 1", compactedAt: 1, tokens: 100 },
          { compacted: "summary 2", compactedAt: 2, tokens: 100 },
          { compacted: "summary 3", compactedAt: 3, tokens: 100 },
          { compacted: "summary 4", compactedAt: 4, tokens: 100 },
          { compacted: "summary 5", compactedAt: 5, tokens: 100 },
          { compacted: "summary 6", compactedAt: 6, tokens: 100 },
          { compacted: "summary 7", compactedAt: 7, tokens: 100 },
          { compacted: "summary 8", compactedAt: 8, tokens: 100 },
          { compacted: "summary 9", compactedAt: 9, tokens: 100 },
          { compacted: "summary 10", compactedAt: 10, tokens: 100 },
        ]);
      });
    });

    describe("chooses the output format", () => {
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
        await getMergedSummaries(getState().conversation.summaries);
        assert(capturedOpts !== undefined);
        assert.strictEqual("output" in capturedOpts, true);
      });

      it("uses the plain text result when compactWithStructuredOutput is false", async () => {
        seedSummaries();
        actions.config.setCompactWithStructuredOutput(false);
        let capturedOpts: Record<string, unknown> | undefined;
        mock.method(aiDeps, "generateText", (opts: Record<string, unknown>) => {
          capturedOpts = opts;
          return Promise.resolve(
            makeGenerateTextResult({ text: "plain merged summary", usage }),
          );
        });
        const result = await getMergedSummaries(
          getState().conversation.summaries,
        );
        assert(capturedOpts !== undefined);
        assert.strictEqual("output" in capturedOpts, false);
        assert.deepStrictEqual(result, [
          {
            compacted: "plain merged summary",
            compactedAt: 42,
            tokens: 25_000,
          },
          { compacted: "summary 3", compactedAt: 3, tokens: 100 },
          { compacted: "summary 4", compactedAt: 4, tokens: 100 },
          { compacted: "summary 5", compactedAt: 5, tokens: 100 },
          { compacted: "summary 6", compactedAt: 6, tokens: 100 },
          { compacted: "summary 7", compactedAt: 7, tokens: 100 },
          { compacted: "summary 8", compactedAt: 8, tokens: 100 },
          { compacted: "summary 9", compactedAt: 9, tokens: 100 },
          { compacted: "summary 10", compactedAt: 10, tokens: 100 },
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
        const result = await getMergedSummaries(
          getState().conversation.summaries,
        );
        const mergedSummary = result[0];
        assert(mergedSummary !== undefined);
        assert.strictEqual(
          mergedSummary.tokens,
          strToApproxTokens("twelve chars ≈ four tokens"),
        );
      });
    });

    describe("returns existing summaries on failure", () => {
      it("keeps the existing summaries when generateText fails", async () => {
        seedSummaries();
        mock.method(aiDeps, "generateText", () =>
          Promise.reject(new Error("network error")),
        );
        const result = await getMergedSummaries(
          getState().conversation.summaries,
        );
        assert.strictEqual(result, getState().conversation.summaries);
        assert.deepStrictEqual(getState().conversation.summaries, [
          { compacted: "summary 1", compactedAt: 1, tokens: 100 },
          { compacted: "summary 2", compactedAt: 2, tokens: 100 },
          { compacted: "summary 3", compactedAt: 3, tokens: 100 },
          { compacted: "summary 4", compactedAt: 4, tokens: 100 },
          { compacted: "summary 5", compactedAt: 5, tokens: 100 },
          { compacted: "summary 6", compactedAt: 6, tokens: 100 },
          { compacted: "summary 7", compactedAt: 7, tokens: 100 },
          { compacted: "summary 8", compactedAt: 8, tokens: 100 },
          { compacted: "summary 9", compactedAt: 9, tokens: 100 },
          { compacted: "summary 10", compactedAt: 10, tokens: 100 },
        ]);
      });

      it("returns the existing summaries and leaves the abort controller set on abort error", async () => {
        seedSummaries();
        const err = makeAbortError();
        mock.method(aiDeps, "generateText", () => Promise.reject(err));
        const result = await getMergedSummaries(
          getState().conversation.summaries,
        );
        assert.notStrictEqual(getState().abortControllers.apiStream, null);
        assert.deepStrictEqual(result, [
          { compacted: "summary 1", compactedAt: 1, tokens: 100 },
          { compacted: "summary 2", compactedAt: 2, tokens: 100 },
          { compacted: "summary 3", compactedAt: 3, tokens: 100 },
          { compacted: "summary 4", compactedAt: 4, tokens: 100 },
          { compacted: "summary 5", compactedAt: 5, tokens: 100 },
          { compacted: "summary 6", compactedAt: 6, tokens: 100 },
          { compacted: "summary 7", compactedAt: 7, tokens: 100 },
          { compacted: "summary 8", compactedAt: 8, tokens: 100 },
          { compacted: "summary 9", compactedAt: 9, tokens: 100 },
          { compacted: "summary 10", compactedAt: 10, tokens: 100 },
        ]);
      });
    });
  });
});

describe("context", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  describe("getContextFilesStr", () => {
    it("returns empty string when no AGENTS.md files found", async () => {
      const result = getContextFilesStr(await getContextEntries());
      assert.equal(result, "");
    });

    it("returns formatted content for single file", async () => {
      testFs._globResults.set("/test-cwd/**/AGENTS.md", [
        "/test-cwd/AGENTS.md",
      ]);
      testFs._files.set("/test-cwd/AGENTS.md", "# Agent Instructions");
      const result = getContextFilesStr(await getContextEntries());
      assert.equal(
        result,
        `# [lasso] AGENTS.md context files

## Path: /test-cwd/AGENTS.md

# Agent Instructions
`,
      );
    });

    it("returns formatted content for multiple files", async () => {
      testFs._dirs.add(getGlobalContextDir());
      testFs._files.set("/test-cwd/AGENTS.md", "Root content");
      testFs._files.set(
        "/fake-home/.config/lasso/context/AGENTS.md",
        "Global content",
      );
      const result = getContextFilesStr(await getContextEntries());
      assert.equal(
        result,
        `# [lasso] AGENTS.md context files

## Path: /test-cwd/AGENTS.md

Root content


## Path: /fake-home/.config/lasso/context/AGENTS.md

Global content
`,
      );
    });

    it("skips files that fail to read", async () => {
      testFs._dirs.add(getGlobalContextDir());
      testFs._files.set(
        "/fake-home/.config/lasso/context/AGENTS.md",
        "Global content",
      );
      const result = getContextFilesStr(await getContextEntries());
      assert.equal(
        result,
        `# [lasso] AGENTS.md context files

## Path: /fake-home/.config/lasso/context/AGENTS.md

Global content
`,
      );
    });

    it("prints the error and skips files whose existence cannot be checked", async () => {
      testFs._dirs.add(getGlobalContextDir());
      testFs._files.set(
        "/fake-home/.config/lasso/context/AGENTS.md",
        "Global content",
      );
      const realExistsSync = fsDeps.existsSync;
      mock.method(fsDeps, "existsSync", (path: string) => {
        if (path === "/fake-home/.config/lasso/context/AGENTS.md") {
          throw makeErrnoError("EACCES");
        }
        return realExistsSync(path);
      });
      const writes = mockStdoutWrites();

      assert.deepStrictEqual(await getContextEntries(), []);
      assert.deepStrictEqual(writes(), [
        `${RED}Failed to check if /fake-home/.config/lasso/context/AGENTS.md exists. Error: EACCES${RESET}\n`,
      ]);
    });

    it("includes global agents dir files", async () => {
      testFs._dirs.add(getGlobalContextDir());
      testFs._globResults.set("/fake-home/.config/lasso/context/**/AGENTS.md", [
        "/fake-home/.config/lasso/context/AGENTS.md",
      ]);
      testFs._files.set(
        "/fake-home/.config/lasso/context/AGENTS.md",
        "global content",
      );
      const result = getContextFilesStr(await getContextEntries());
      assert.equal(
        result,
        `# [lasso] AGENTS.md context files

## Path: /fake-home/.config/lasso/context/AGENTS.md

global content
`,
      );
    });

    it("combines cwd and global agents dir files", async () => {
      testFs._dirs.add(getGlobalContextDir());
      testFs._files.set(
        "/fake-home/.config/lasso/context/AGENTS.md",
        "global content",
      );
      testFs._files.set("/test-cwd/AGENTS.md", "local content");
      const result = getContextFilesStr(await getContextEntries());
      assert.equal(
        result,
        `# [lasso] AGENTS.md context files

## Path: /test-cwd/AGENTS.md

local content


## Path: /fake-home/.config/lasso/context/AGENTS.md

global content
`,
      );
    });
  });

  describe("getSkillsStr", () => {
    describe("lists and dedupes skills", () => {
      it("returns empty string when no skills are found", () => {
        const result = getSkillsStr([]);
        assert.equal(result, "");
      });

      it("lists skills found in skill directories", async () => {
        testFs._globResults.set("/fake-home/.config/lasso/skills/**/SKILL.md", [
          "/fake-home/.config/lasso/skills/my-skill/SKILL.md",
        ]);
        testFs._files.set(
          "/fake-home/.config/lasso/skills/my-skill/SKILL.md",
          `---
name: my-skill
description: A test skill
---
# Body`,
        );
        const result = getSkillsStr(await getSkills());
        assert.equal(
          result,
          `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- my-skill: A test skill`,
        );
      });

      it("deduplicates by parsed name, keeping first occurrence", async () => {
        testFs._globResults.set("/test-cwd/.lasso/skills/**/SKILL.md", [
          "/test-cwd/.lasso/skills/local-skill/SKILL.md",
        ]);
        testFs._globResults.set("/fake-home/.config/lasso/skills/**/SKILL.md", [
          "/fake-home/.config/lasso/skills/global-skill/SKILL.md",
        ]);
        testFs._files.set(
          "/test-cwd/.lasso/skills/local-skill/SKILL.md",
          `---
name: deploy
description: Local deploy
---
# Local`,
        );
        testFs._files.set(
          "/fake-home/.config/lasso/skills/global-skill/SKILL.md",
          `---
name: deploy
description: Global deploy
---
# Global`,
        );
        const result = getSkillsStr(await getSkills());
        assert.equal(
          result,
          `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- deploy: Local deploy`,
        );
      });

      it("does not return duplicate skills", async () => {
        testFs._globResults.set("/test-cwd/.lasso/skills/**/SKILL.md", [
          "/test-cwd/.lasso/skills/a/SKILL.md",
        ]);
        testFs._globResults.set("/fake-home/.config/lasso/skills/**/SKILL.md", [
          "/fake-home/.config/lasso/skills/b/SKILL.md",
        ]);
        testFs._files.set(
          "/test-cwd/.lasso/skills/a/SKILL.md",
          `---
name: deploy
description: First
---
# A`,
        );
        testFs._files.set(
          "/fake-home/.config/lasso/skills/b/SKILL.md",
          `---
name: deploy
description: Second
---
# B`,
        );
        const result = await getSkills();
        assert.equal(result.length, 1);
        assert.deepStrictEqual(result[0], {
          name: "deploy",
          description: "First",
          content: "# A",
          dir: "/test-cwd/.lasso/skills/a",
        });
      });

      it("includes skills with different names", async () => {
        testFs._globResults.set("/test-cwd/.lasso/skills/**/SKILL.md", [
          "/test-cwd/.lasso/skills/a/SKILL.md",
          "/test-cwd/.lasso/skills/b/SKILL.md",
        ]);
        testFs._files.set(
          "/test-cwd/.lasso/skills/a/SKILL.md",
          `---
name: skill-a
description: First
---
`,
        );
        testFs._files.set(
          "/test-cwd/.lasso/skills/b/SKILL.md",
          `---
name: skill-b
description: Second
---
`,
        );
        const result = getSkillsStr(await getSkills());
        assert.equal(
          result,
          `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- skill-a: First
- skill-b: Second`,
        );
      });
    });

    describe("skips invalid skills", () => {
      it("skips non-existent skill directories", async () => {
        testFs._globResults.set("/fake-home/.config/lasso/skills/**/SKILL.md", [
          "/fake-home/.config/lasso/skills/my-skill/SKILL.md",
        ]);
        testFs._files.set(
          "/fake-home/.config/lasso/skills/my-skill/SKILL.md",
          `---
name: my-skill
description: A test skill
---
# Body`,
        );
        const result = getSkillsStr(await getSkills());
        assert.equal(
          result,
          `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- my-skill: A test skill`,
        );
      });

      it("skips malformed skill files", async () => {
        testFs._globResults.set("/fake-home/.config/lasso/skills/**/SKILL.md", [
          "/fake-home/.config/lasso/skills/bad/SKILL.md",
          "/fake-home/.config/lasso/skills/good/SKILL.md",
        ]);
        testFs._files.set(
          "/fake-home/.config/lasso/skills/bad/SKILL.md",
          "not front matter",
        );
        testFs._files.set(
          "/fake-home/.config/lasso/skills/good/SKILL.md",
          `---
name: good
description: Valid
---
`,
        );
        const result = getSkillsStr(await getSkills());
        assert.equal(
          result,
          `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- good: Valid`,
        );
      });

      it("skips entries where glob throws", async () => {
        mock.method(fsDeps, "glob", (pattern: string) => {
          if (pattern === "/test-cwd/.lasso/skills/**/SKILL.md")
            return Promise.reject(new Error("glob failed"));
          return testFs.glob(pattern);
        });
        testFs._globResults.set("/fake-home/.config/lasso/skills/**/SKILL.md", [
          "/fake-home/.config/lasso/skills/ok/SKILL.md",
        ]);
        testFs._files.set(
          "/fake-home/.config/lasso/skills/ok/SKILL.md",
          `---
name: ok
description: Works
---
`,
        );
        const result = getSkillsStr(await getSkills());
        assert.equal(
          result,
          `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- ok: Works`,
        );
      });
    });

    describe("custom skill dirs", () => {
      it("includes skills from custom skill dirs", async () => {
        actions.config.setCustomSkillDirs(["/custom/skills"]);
        testFs._globResults.set("/custom/skills/**/SKILL.md", [
          "/custom/skills/custom-skill/SKILL.md",
        ]);
        testFs._files.set(
          "/custom/skills/custom-skill/SKILL.md",
          `---
name: custom-skill
description: From custom dir
---
`,
        );
        const result = getSkillsStr(await getSkills());
        assert.equal(
          result,
          `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- custom-skill: From custom dir`,
        );
      });

      it("prioritizes custom skill dirs over local and global", async () => {
        actions.config.setCustomSkillDirs(["/custom/skills"]);
        testFs._globResults.set("/custom/skills/**/SKILL.md", [
          "/custom/skills/deploy/SKILL.md",
        ]);
        testFs._globResults.set("/test-cwd/.lasso/skills/**/SKILL.md", [
          "/test-cwd/.lasso/skills/deploy/SKILL.md",
        ]);
        testFs._files.set(
          "/custom/skills/deploy/SKILL.md",
          `---
name: deploy
description: Custom deploy
---
`,
        );
        testFs._files.set(
          "/test-cwd/.lasso/skills/deploy/SKILL.md",
          `---
name: deploy
description: Local deploy
---
`,
        );
        const result = getSkillsStr(await getSkills());
        assert.equal(
          result,
          `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- deploy: Custom deploy`,
        );
      });
    });

    describe("context skills", () => {
      it("includes nested AGENTS.md files as context skills", async () => {
        testFs._gitLsFilesResults.set("**/AGENTS.md", [
          "/test-cwd/src/AGENTS.md",
        ]);
        testFs._files.set("/test-cwd/src/AGENTS.md", "nested content");
        const result = getSkillsStr(await getSkills());
        assert.equal(
          result,
          `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- __lasso-context-for-/test-cwd/src: Context relevant for /test-cwd/src`,
        );
      });

      it("excludes the root AGENTS.md from context skills", async () => {
        testFs._gitLsFilesResults.set("**/AGENTS.md", [
          "AGENTS.md",
          "/test-cwd/src/AGENTS.md",
        ]);
        testFs._files.set("/test-cwd/AGENTS.md", "root content");
        testFs._files.set("/test-cwd/src/AGENTS.md", "nested content");
        const result = getSkillsStr(await getSkills());
        assert.equal(
          result,
          `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- __lasso-context-for-/test-cwd/src: Context relevant for /test-cwd/src`,
        );
      });

      it("nested AGENTS.md skills do not collide with regular skills", async () => {
        testFs._globResults.set("/fake-home/.config/lasso/skills/**/SKILL.md", [
          "/fake-home/.config/lasso/skills/my-skill/SKILL.md",
        ]);
        testFs._files.set(
          "/fake-home/.config/lasso/skills/my-skill/SKILL.md",
          `---
name: my-skill
description: A test skill
---
# Body`,
        );
        testFs._gitLsFilesResults.set("**/AGENTS.md", [
          "/test-cwd/src/AGENTS.md",
        ]);
        testFs._files.set("/test-cwd/src/AGENTS.md", "nested content");
        const result = getSkillsStr(await getSkills());
        assert.equal(
          result,
          `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- my-skill: A test skill
- __lasso-context-for-/test-cwd/src: Context relevant for /test-cwd/src`,
        );
      });
    });
  });

  describe("getContextEntries", () => {
    it("warns when an agent file cannot be read", async () => {
      testFs._files.set("/test-cwd/AGENTS.md", "content");
      mock.method(fsDeps, "readFile", () =>
        Promise.reject(new Error("Permission denied")),
      );
      const getWrites = mockStdoutWrites();

      const result = await getContextEntries();

      assert.deepStrictEqual(result, []);
      assert.deepStrictEqual(getWrites(), []);
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "Failed to read the agent file at `/test-cwd/AGENTS.md`, ignoring. Error: Permission denied",
      ]);
    });

    it("does not warn when agent files are missing", async () => {
      const getWrites = mockStdoutWrites();

      const result = await getContextEntries();

      assert.deepStrictEqual(result, []);
      assert.deepStrictEqual(getWrites(), []);
    });

    it("returns the cwd agent file", async () => {
      testFs._files.set("/test-cwd/AGENTS.md", "# Project conventions");

      const result = await getContextEntries();

      assert.deepStrictEqual(result, [
        {
          filePath: "/test-cwd/AGENTS.md",
          content: "# Project conventions",
        },
      ]);
    });

    it("returns the global agent file", async () => {
      testFs._files.set(
        "/fake-home/.config/lasso/context/AGENTS.md",
        "# Global conventions",
      );

      const result = await getContextEntries();

      assert.deepStrictEqual(result, [
        {
          filePath: "/fake-home/.config/lasso/context/AGENTS.md",
          content: "# Global conventions",
        },
      ]);
    });

    it("combines cwd and global agent files in order", async () => {
      testFs._files.set("/test-cwd/AGENTS.md", "local content");
      testFs._files.set(
        "/fake-home/.config/lasso/context/AGENTS.md",
        "global content",
      );

      const result = await getContextEntries();

      assert.deepStrictEqual(result, [
        { filePath: "/test-cwd/AGENTS.md", content: "local content" },
        {
          filePath: "/fake-home/.config/lasso/context/AGENTS.md",
          content: "global content",
        },
      ]);
    });
  });

  describe("getSkills", () => {
    describe("loads and filters skills", () => {
      it("warns when a skill agent file cannot be read", async () => {
        testFs._gitLsFilesResults.set("**/AGENTS.md", ["/repo/src/AGENTS.md"]);
        const getWrites = mockStdoutWrites();

        const result = await getSkills();

        assert.deepStrictEqual(result, []);
        assert.deepStrictEqual(getWrites(), []);
        assert.deepStrictEqual(getState().content.configWarningMessages, [
          "Failed to read the agent file at `/repo/src/AGENTS.md`, ignoring. Error: ENOENT: /repo/src/AGENTS.md",
        ]);
      });

      it("warns when listing the agent files with git fails", async () => {
        mockGitLsFilesRejection();
        const writes = mockStdoutWrites();

        const result = await getSkills();

        assert.deepStrictEqual(result, []);
        assert.deepStrictEqual(writes(), []);
        assert.deepStrictEqual(getState().content.configWarningMessages, [
          "Failed to list the agent files with git, ignoring. Error: git failed",
        ]);
      });

      it("warns when listing the skill files in a dir fails", async () => {
        mock.method(fsDeps, "glob", () =>
          Promise.reject(new Error("glob failed")),
        );
        const writes = mockStdoutWrites();

        const result = await getSkills();

        assert.deepStrictEqual(result, []);
        assert.deepStrictEqual(writes(), []);
        assert.deepStrictEqual(getState().content.configWarningMessages, [
          "Failed to list the skill files in `/test-cwd/.lasso/skills`, ignoring. Error: glob failed",
          "Failed to list the skill files in `/fake-home/.config/lasso/skills`, ignoring. Error: glob failed",
        ]);
      });

      it("returns skills from skill directories with front matter stripped", async () => {
        testFs._globResults.set("/fake-home/.config/lasso/skills/**/SKILL.md", [
          "/fake-home/.config/lasso/skills/my-skill/SKILL.md",
        ]);
        testFs._files.set(
          "/fake-home/.config/lasso/skills/my-skill/SKILL.md",
          `---
name: my-skill
description: A test skill
---
# Body`,
        );

        const result = await getSkills();

        assert.deepStrictEqual(result, [
          {
            name: "my-skill",
            description: "A test skill",
            dir: "/fake-home/.config/lasso/skills/my-skill",
            content: "# Body",
          },
        ]);
      });

      it("returns skills from custom, local, and global dirs in order", async () => {
        actions.config.setCustomSkillDirs(["/custom/skills"]);
        testFs._globResults.set("/custom/skills/**/SKILL.md", [
          "/custom/skills/custom-skill/SKILL.md",
        ]);
        testFs._globResults.set("/test-cwd/.lasso/skills/**/SKILL.md", [
          "/test-cwd/.lasso/skills/local-skill/SKILL.md",
        ]);
        testFs._globResults.set("/fake-home/.config/lasso/skills/**/SKILL.md", [
          "/fake-home/.config/lasso/skills/global-skill/SKILL.md",
        ]);
        testFs._files.set(
          "/custom/skills/custom-skill/SKILL.md",
          `---
name: custom-skill
description: From custom dir
---
`,
        );
        testFs._files.set(
          "/test-cwd/.lasso/skills/local-skill/SKILL.md",
          `---
name: local-skill
description: From local dir
---
`,
        );
        testFs._files.set(
          "/fake-home/.config/lasso/skills/global-skill/SKILL.md",
          `---
name: global-skill
description: From global dir
---
`,
        );

        const result = await getSkills();

        assert.deepStrictEqual(result, [
          {
            name: "custom-skill",
            description: "From custom dir",
            dir: "/custom/skills/custom-skill",
            content: "",
          },
          {
            name: "local-skill",
            description: "From local dir",
            dir: "/test-cwd/.lasso/skills/local-skill",
            content: "",
          },
          {
            name: "global-skill",
            description: "From global dir",
            dir: "/fake-home/.config/lasso/skills/global-skill",
            content: "",
          },
        ]);
      });

      it("deduplicates skills by name keeping the first occurrence", async () => {
        testFs._globResults.set("/test-cwd/.lasso/skills/**/SKILL.md", [
          "/test-cwd/.lasso/skills/deploy/SKILL.md",
        ]);
        testFs._globResults.set("/fake-home/.config/lasso/skills/**/SKILL.md", [
          "/fake-home/.config/lasso/skills/deploy/SKILL.md",
        ]);
        testFs._files.set(
          "/test-cwd/.lasso/skills/deploy/SKILL.md",
          `---
name: deploy
description: Local deploy
---
`,
        );
        testFs._files.set(
          "/fake-home/.config/lasso/skills/deploy/SKILL.md",
          `---
name: deploy
description: Global deploy
---
`,
        );

        const result = await getSkills();

        assert.deepStrictEqual(result, [
          {
            name: "deploy",
            description: "Local deploy",
            dir: "/test-cwd/.lasso/skills/deploy",
            content: "",
          },
        ]);
      });

      it("skips malformed skill files", async () => {
        testFs._globResults.set("/test-cwd/.lasso/skills/**/SKILL.md", [
          "/test-cwd/.lasso/skills/broken/SKILL.md",
          "/test-cwd/.lasso/skills/valid/SKILL.md",
        ]);
        testFs._files.set(
          "/test-cwd/.lasso/skills/broken/SKILL.md",
          "no front matter",
        );
        testFs._files.set(
          "/test-cwd/.lasso/skills/valid/SKILL.md",
          `---
name: valid-skill
description: A valid skill
---
`,
        );

        const result = await getSkills();

        assert.deepStrictEqual(result, [
          {
            name: "valid-skill",
            description: "A valid skill",
            dir: "/test-cwd/.lasso/skills/valid",
            content: "",
          },
        ]);
      });
    });

    describe("context skills", () => {
      it("converts nested git-tracked agent files into context skills", async () => {
        testFs._gitLsFilesResults.set("**/AGENTS.md", ["/repo/src/AGENTS.md"]);
        testFs._files.set("/repo/src/AGENTS.md", "# Team conventions");

        const result = await getSkills();

        assert.deepStrictEqual(result, [
          {
            name: "__lasso-context-for-/repo/src",
            description: "Context relevant for /repo/src",
            dir: "/repo/src",
            content: "# Team conventions",
          },
        ]);
      });

      it("excludes the root agent file from context skills", async () => {
        testFs._gitLsFilesResults.set("**/AGENTS.md", [
          "AGENTS.md",
          "/repo/AGENTS.md",
        ]);
        testFs._files.set("/repo/AGENTS.md", "# Repo conventions");

        const result = await getSkills();

        assert.deepStrictEqual(result, [
          {
            name: "__lasso-context-for-/repo",
            description: "Context relevant for /repo",
            dir: "/repo",
            content: "# Repo conventions",
          },
        ]);
      });
    });
  });

  describe("getSkillJSON", () => {
    it("warns and returns null when the file does not exist", async () => {
      const writes = mockStdoutWrites();

      const result = await getSkillJSON("/some/dir/SKILL.md");

      assert.equal(result, null);
      assert.deepStrictEqual(writes(), []);
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "Failed to read the skill at /some/dir/SKILL.md, ignoring. Error: ENOENT: /some/dir/SKILL.md",
      ]);
    });

    it("warns and returns null when the front matter is not valid YAML", async () => {
      testFs._files.set(
        "/skill-dir/SKILL.md",
        `---
name: [
---
# Deploy`,
      );
      const writes = mockStdoutWrites();

      const result = await getSkillJSON("/skill-dir/SKILL.md");

      assert.equal(result, null);
      assert.deepStrictEqual(writes(), []);
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "Malformed skill at /skill-dir/SKILL.md! A skill's front matter must contain valid YAML between `---` and `---`.",
      ]);
    });

    it("warns and returns null when the front matter lacks a description", async () => {
      testFs._files.set(
        "/skill-dir/SKILL.md",
        `---
name: deploy
---
# Deploy`,
      );
      const writes = mockStdoutWrites();

      const result = await getSkillJSON("/skill-dir/SKILL.md");

      assert.equal(result, null);
      assert.deepStrictEqual(writes(), []);
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "Malformed skill at /skill-dir/SKILL.md! A skill's front matter must contain a `name` and `description` field.",
      ]);
    });

    it("parses valid SKILL.md front matter", async () => {
      testFs._files.set(
        "/skill-dir/SKILL.md",
        `---
name: deploy
description: Deploy the app
---
# Deploy`,
      );
      const result = await getSkillJSON("/skill-dir/SKILL.md");
      assert.deepStrictEqual(result, {
        name: "deploy",
        description: "Deploy the app",
        content: "# Deploy",
        dir: "/skill-dir",
      });
    });

    it("returns null when front matter is missing name", async () => {
      testFs._files.set(
        "/skill-dir/SKILL.md",
        `---
description: No name here
---
`,
      );
      const result = await getSkillJSON("/skill-dir/SKILL.md");
      assert.equal(result, null);
    });

    it("returns null when front matter is missing description", async () => {
      testFs._files.set(
        "/skill-dir/SKILL.md",
        `---
name: deploy
---
`,
      );
      const result = await getSkillJSON("/skill-dir/SKILL.md");
      assert.equal(result, null);
    });

    it("returns null when path is a directory", async () => {
      testFs._dirs.add("/skill-dir");
      const result = await getSkillJSON("/skill-dir");
      assert.equal(result, null);
    });

    it("returns null when readFile fails", async () => {
      const result = await getSkillJSON("/skill-dir/SKILL.md");
      assert.equal(result, null);
    });
  });

  describe("parseFrontMatter", () => {
    describe("returns null for malformed content", () => {
      it("returns null when content does not start with ---\\n", () => {
        const result = parseFrontMatter("no front matter here");
        assert.equal(result, null);
      });

      it("returns null when content starts with --- but no newline", () => {
        const result = parseFrontMatter("---foo");
        assert.equal(result, null);
      });

      it("returns null when no closing delimiter", () => {
        const result = parseFrontMatter(`---
name: test
`);
        assert.equal(result, null);
      });

      it("returns null when yaml string is empty", () => {
        const result = parseFrontMatter(`---
---
body`);
        assert.equal(result, null);
      });
    });

    describe("parses valid front matter", () => {
      it("parses valid front matter with attributes and body", () => {
        const result = parseFrontMatter(
          `---
name: my-skill
description: A skill
---
# Body content`,
        );
        assert.deepStrictEqual(result, {
          data: { name: "my-skill", description: "A skill" },
          body: "# Body content",
        });
      });

      it("parses front matter with no body", () => {
        const result = parseFrontMatter(`---
name: test
---
`);
        assert.deepStrictEqual(result, {
          data: { name: "test" },
          body: "",
        });
      });

      it("preserves body containing dashes", () => {
        const result = parseFrontMatter(
          `---
key: val
---
Body with --- inside
and more text`,
        );
        assert.deepStrictEqual(result, {
          data: { key: "val" },
          body: `Body with --- inside
and more text`,
        });
      });

      it("parses front matter when closing delimiter lacks trailing newline", () => {
        const result = parseFrontMatter(`---
key: val
---`);
        assert.deepStrictEqual(result, {
          data: { key: "val" },
          body: "",
        });
      });
    });

    describe("returns null for invalid yaml", () => {
      it("returns null on invalid yaml", () => {
        const result = parseFrontMatter(`---
* invalid
* ---
*  body`);
        assert.equal(result, null);
      });

      it("returns null on unclosed flow sequence in yaml", () => {
        const result = parseFrontMatter(`---
key: [unclosed
---
body`);
        assert.equal(result, null);
      });
    });
  });
});

describe("fence", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  describe("getPrettyApiDuration", () => {
    beforeEach(() => {
      actions.resetState();
    });

    describe("milliseconds", () => {
      it("formats sub-second duration as milliseconds", () => {
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.usage.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(1_500_000_000));
        actions.usage.setApiEndTime();

        const result = getPrettyApiDuration();
        assert.strictEqual(result, "500ms");
      });

      it("includes microseconds when requested", () => {
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.usage.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(1_234_567_890));
        actions.usage.setApiEndTime();

        const result = getPrettyApiDuration({ includeMicroseconds: true });
        assert.strictEqual(result, "234.567ms");
      });

      it("truncates nanoseconds", () => {
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.usage.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_123_456));
        actions.usage.setApiEndTime();

        const result = getPrettyApiDuration({ includeMicroseconds: true });
        assert.strictEqual(result, "0.123ms");
      });
    });

    describe("seconds and minutes", () => {
      it("formats seconds and milliseconds", () => {
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.usage.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(6_500_000_000));
        actions.usage.setApiEndTime();

        const result = getPrettyApiDuration();
        assert.strictEqual(result, "5s 500ms");
      });

      it("formats minutes, zero seconds, and milliseconds", () => {
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.usage.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(121_500_000_000));
        actions.usage.setApiEndTime();

        const result = getPrettyApiDuration();
        assert.strictEqual(result, "2m 0s 500ms");
      });

      it("formats minutes, seconds, and milliseconds", () => {
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.usage.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(126_500_000_000));
        actions.usage.setApiEndTime();

        const result = getPrettyApiDuration();
        assert.strictEqual(result, "2m 5s 500ms");
      });
    });

    it("clamps negative durations from clock skew to zero", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      actions.usage.setApiStartTime();
      mock.method(process.hrtime, "bigint", () => BigInt(500_000_000));
      actions.usage.setApiEndTime();

      const result = getPrettyApiDuration();
      assert.strictEqual(result, "0ms");
    });
  });
});

describe("config", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  describe("initStateRepeatable", () => {
    it("updates config and context without resetting session start date", async () => {
      const sessionStartDate = getState().session.sessionStartDate;
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
        }),
      );

      await initState();
      assert.strictEqual(getState().session.sessionStartDate, sessionStartDate);

      const globalConfigStr = JSON.stringify({
        ...testConfig,
        model: "claude-haiku-4-5",
      });
      testFs._files.set(getGlobalConfigPath(), globalConfigStr);

      await initStateRepeatable();

      assert.strictEqual(getState().session.sessionStartDate, sessionStartDate);
      assert.strictEqual(getState().content.globalConfigStr, globalConfigStr);
      assert.strictEqual(getState().config.model, "claude-haiku-4-5");
    });

    it("does not reset the session start date or debug log path", async () => {
      const sessionStartDate = getState().session.sessionStartDate;
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
        }),
      );

      await initStateRepeatable();

      assert.strictEqual(getState().session.sessionStartDate, sessionStartDate);
      assert.strictEqual(getState().debug.debugLogPath, "");
    });

    it("wires the tools content string for token counting", async () => {
      testFs._files.set(getGlobalConfigPath(), JSON.stringify(testConfig));

      await initStateRepeatable();

      assert.strictEqual(getToolsContentStr(), stringifyTools());
    });
  });
});

async function resolveInterruptWithAnswer(answer: string) {
  actions.terminal.setEditorInputValue("queued input");
  actions.terminal.setRl(
    makeFakeRl({ question: () => Promise.resolve(answer) }),
  );
  await resolveInterruptWithEditor();
}

describe("resolveInterruptWithEditor", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  let getWrites: () => string[];

  beforeEach(() => {
    setupTestContext();
    getWrites = mockStdoutWrites();
  });

  it("waits for enter and clears the interrupt controller", async () => {
    const prompts: string[] = [];
    let questionOptions: { signal: AbortSignal } | undefined;
    actions.config.setKeymaps({
      ...defaultConfig.keymaps,
      edit: { name: "e", ctrl: true },
    });
    actions.terminal.setRl(
      makeFakeRl({
        question: (prompt: string, options: { signal: AbortSignal }) => {
          prompts.push(prompt);
          questionOptions = options;
          return Promise.resolve("");
        },
      }),
    );

    await resolveInterruptWithEditor();

    assert(questionOptions !== undefined);
    assert.equal(questionOptions.signal.aborted, false);
    assert.equal(getState().abortControllers.interruptWithEditorContent, null);
    assert.deepStrictEqual(getWrites(), [
      `${YELLOW}You have queued messages!${RESET}\n`,
    ]);
    assert.deepStrictEqual(prompts, [
      'Edit ({"name":"e","ctrl":true}), c(lear), or <CR> to continue: ',
    ]);
  });

  it("clears queued editor input when c is entered", async () => {
    await resolveInterruptWithAnswer("c");
    assert.strictEqual(getState().terminal.editorInputValue, null);
  });

  it("clears queued editor input when clear is entered", async () => {
    await resolveInterruptWithAnswer("clear");
    assert.strictEqual(getState().terminal.editorInputValue, null);
  });

  it("keeps queued editor input when the answer is not c or clear", async () => {
    await resolveInterruptWithAnswer("e");
    assert.strictEqual(getState().terminal.editorInputValue, "queued input");
  });

  it("returns normally when interrupted", async () => {
    actions.terminal.setRl(
      makeFakeRl({
        question: () => {
          const error = makeAbortError("interrupted");
          return Promise.reject(error);
        },
      }),
    );

    await resolveInterruptWithEditor();

    assert.equal(getState().abortControllers.interruptWithEditorContent, null);
  });

  it("prints the error when the question fails for a reason other than abort", async () => {
    actions.terminal.setRl(
      makeFakeRl({
        question: () => Promise.reject(new Error("boom")),
      }),
    );

    await resolveInterruptWithEditor();

    assert.equal(getState().abortControllers.interruptWithEditorContent, null);
    assert.deepStrictEqual(getWrites(), [
      `${YELLOW}You have queued messages!${RESET}\n`,
      `${RED}boom${RESET}\n`,
    ]);
  });
});

describe("input", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  let getWrites: () => string[];

  beforeEach(() => {
    setupTestContext();
    testProcessEnv._set("SHELL", "/bin/zsh");
    getWrites = mockStdoutWrites();
  });

  describe("restores buffered initialization input", () => {
    it("writes buffered input into rl right after the question starts", () => {
      mockStdoutWrites();
      const { rl, writes } = makeFakeRlWithWrites({
        question: () => new Promise(() => undefined),
      });
      actions.terminal.setRl(rl);
      actions.terminal.appendBufferedInputWhileInitializing("ab");
      void resolveUserInput({ isFirstInput: true });
      assert.deepStrictEqual(
        writes.map((write) => write.chunk),
        ["ab"],
      );
      assert.equal(getState().terminal.bufferedInputWhileInitializing, "");
    });
  });

  describe("executeUserInput", () => {
    it("spawns the command asynchronously and clears its abort controller after exit", async () => {
      const { spawned, spawnArgs, spawnOptions, children } = mockUserInputSpawn(
        {
          autoExit: false,
        },
      );
      const execution = executeUserInput("! echo hello");
      const controller = getState().abortControllers.executeUserInput;
      assert(controller !== null);
      assert.strictEqual(getState().terminal.isExecutingUserInput, true);

      assert.deepStrictEqual(spawned, ["/bin/zsh"]);
      assert.deepStrictEqual(spawnArgs, [["-i", "+m", "-c", " echo hello"]]);
      assert.deepStrictEqual(spawnOptions, [
        {
          stdio: "inherit",
          signal: controller.signal,
        },
      ]);
      const child = children[0];
      assert(child !== undefined);
      child.emit("exit", 0, null);
      await execution;

      assert.strictEqual(getState().abortControllers.executeUserInput, null);
      assert.strictEqual(getState().terminal.isExecutingUserInput, false);
    });

    it("pauses readline while the shell runs and resumes it afterward", async () => {
      const calls: string[] = [];
      actions.terminal.setRl(
        makeFakeRl({
          pause: () => calls.push("pause"),
          resume: () => calls.push("resume"),
        }),
      );

      await executeUserInput("! echo hello");

      assert.deepStrictEqual(calls, ["pause", "resume"]);
    });

    it("falls back to /bin/sh when SHELL is unset", async () => {
      testProcessEnv._clear();
      const { spawned, spawnArgs } = mockUserInputSpawn();

      await executeUserInput("! echo hello");

      assert.deepStrictEqual(spawned, ["/bin/sh"]);
      assert.deepStrictEqual(spawnArgs, [["-i", "-c", " echo hello"]]);
    });

    it("prints an error when the command fails to spawn", async () => {
      const { spawned, spawnArgs } = mockUserInputSpawn({
        spawnError: new Error("spawn failed"),
      });
      const getWrites = mockStdoutWrites();

      await executeUserInput("! echo hello");

      assert.deepStrictEqual(spawned, ["/bin/zsh"]);
      assert.deepStrictEqual(spawnArgs, [["-i", "+m", "-c", " echo hello"]]);
      assert.deepStrictEqual(getWrites(), [
        `${BLUE}$  echo hello${RESET}\n`,
        `${RED}Error while executing the user input. Error: spawn failed${RESET}\n`,
      ]);
      assert.strictEqual(getState().abortControllers.executeUserInput, null);
      assert.strictEqual(getState().terminal.isExecutingUserInput, false);
    });

    it("aborts the running command on SIGINT", async () => {
      let sigint: (() => void) | undefined;
      const rl = makeFakeRl({
        on: (_event: string, listener: () => void) => {
          sigint = listener;
        },
      });
      const { spawnArgs, spawnOptions, children } = mockUserInputSpawn({
        autoExit: false,
      });
      const execution = executeUserInput("! sleep 10");
      const controller = getState().abortControllers.executeUserInput;
      assert(controller !== null);
      initSigInt(rl);
      assert(sigint !== undefined);
      sigint();

      assert.strictEqual(controller.signal.aborted, true);
      assert.deepStrictEqual(spawnArgs, [["-i", "+m", "-c", " sleep 10"]]);
      assert.deepStrictEqual(spawnOptions, [
        {
          stdio: "inherit",
          signal: controller.signal,
        },
      ]);
      const child = children[0];
      assert(child !== undefined);
      child.emit("error", makeAbortError("The operation was aborted"));
      await execution;

      assert.strictEqual(getState().abortControllers.executeUserInput, null);
      assert.strictEqual(getState().terminal.isExecutingUserInput, false);
    });
  });

  describe("resolveUserInput", () => {
    beforeEach(() => {
      actions.terminal.resetStdout();
      actions.terminal.setRl(makeFakeRl());
    });

    describe("editor input", () => {
      it("returns editor input value when set and clears it", async () => {
        actions.terminal.setEditorInputValue("editor content");
        const result = await resolveUserInput({ isFirstInput: false });
        assert.strictEqual(result, "editor content");
        assert.strictEqual(getState().terminal.editorInputValue, null);
        assert.deepStrictEqual(getState().conversation.transcript, [
          { timestamp: 0, role: "user", message: "editor content" },
        ]);
      });

      it("returns shell-like editor input without executing it", async () => {
        const { spawned } = mockUserInputSpawn();
        actions.terminal.setEditorInputValue("!echo hello");

        const result = await resolveUserInput({ isFirstInput: false });

        assert.strictEqual(result, "!echo hello");
        assert.deepStrictEqual(spawned, []);
      });

      it("returns the first queued editor message and keeps the rest for the next iteration", async () => {
        actions.terminal.setEditorInputValue("first\nl---\nsecond\n");
        const result = await resolveUserInput({ isFirstInput: false });
        assert.strictEqual(result, "first\n");
        assert.strictEqual(getState().terminal.editorInputValue, "second\n");
        assert.deepStrictEqual(getState().conversation.transcript, [
          { timestamp: 0, role: "user", message: "first\n" },
        ]);
      });

      it("drains queued editor messages across iterations", async () => {
        actions.terminal.setEditorInputValue(`first
l---
second
`);
        assert.strictEqual(
          await resolveUserInput({ isFirstInput: false }),
          "first\n",
        );
        assert.strictEqual(
          await resolveUserInput({ isFirstInput: false }),
          "second\n",
        );
        assert.strictEqual(getState().terminal.editorInputValue, null);
      });
    });

    describe("resolves user input", () => {
      it("returns trimmed user input", async () => {
        mock.method(getTestRl(), "question", () =>
          Promise.resolve("  hello  "),
        );
        const result = await resolveUserInput({ isFirstInput: false });
        assert.strictEqual(result, "hello");
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${YELLOW}━━ ${BOLD}Input${BOLD_RESET} ━━${RESET}\n`,
        ]);
        assert.deepStrictEqual(getState().conversation.transcript, [
          { timestamp: 0, role: "user", message: "  hello  " },
        ]);
      });

      it("executes shell input and waits for the command to exit", async () => {
        const { spawned } = mockUserInputSpawn();
        mock.method(getTestRl(), "question", () =>
          Promise.resolve("!echo hello"),
        );

        const result = await resolveUserInput({ isFirstInput: false });

        assert.strictEqual(result, null);
        assert.deepStrictEqual(spawned, ["/bin/zsh"]);
        assert.strictEqual(getState().abortControllers.executeUserInput, null);
      });
    });

    describe("handles errors and aborts", () => {
      it("returns null and prints error on non-abort error", async () => {
        mock.method(getTestRl(), "question", () =>
          Promise.reject(new Error("read failed")),
        );
        const result = await resolveUserInput({ isFirstInput: false });
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${YELLOW}━━ ${BOLD}Input${BOLD_RESET} ━━${RESET}\n`,
          `${RED}read failed${RESET}\n`,
        ]);
      });

      it("returns shell-like editor input without executing it when aborted by editor", async () => {
        const { spawned } = mockUserInputSpawn();
        mock.method(getTestRl(), "question", () => {
          actions.terminal.setEditorInputValue("!echo hello");
          const err = makeAbortError("This operation was aborted");
          return Promise.reject(err);
        });
        const result = await resolveUserInput({ isFirstInput: false });
        assert.strictEqual(result, "!echo hello");
        assert.strictEqual(getState().terminal.editorInputValue, null);
        assert.deepStrictEqual(getState().conversation.transcript, [
          { timestamp: 0, role: "user", message: "!echo hello" },
        ]);
        assert.deepStrictEqual(spawned, []);
      });
    });

    describe("exiting", () => {
      it("exits on abort during exit confirmation", async () => {
        mockProcessExit();
        mockReadlineQuestionResults([
          makeAbortError("This operation was aborted"),
          makeAbortError("This operation was aborted"),
        ]);
        await assert.rejects(
          resolveUserInput({ isFirstInput: false }),
          /process.exit called/,
        );
      });

      it("returns null when user declines exit confirmation", async () => {
        mockReadlineQuestionResults([
          makeAbortError("This operation was aborted"),
          "n",
        ]);
        const result = await resolveUserInput({ isFirstInput: false });
        assert.strictEqual(result, null);
      });

      it("exits when user confirms exit confirmation", async () => {
        mockProcessExit();
        mockReadlineQuestionResults([
          makeAbortError("This operation was aborted"),
          "yes",
        ]);
        await assert.rejects(
          resolveUserInput({ isFirstInput: false }),
          /process.exit called/,
        );
      });

      it("prints session start date when exiting", async () => {
        mock.restoreAll();
        setupTestContext({ now: 42_000 });
        getWrites = mockStdoutWrites();
        mockProcessExit();
        const intervalCallbacks = mockSetInterval();
        mockClearInterval(intervalCallbacks);
        startLoadingState();
        assert.notStrictEqual(getState().terminal.loadingStateTimeout, null);
        actions.terminal.setRl(makeFakeRl());
        actions.terminal.resetStdout();
        mockReadlineQuestionResults([
          makeAbortError("This operation was aborted"),
          "yes",
        ]);
        await assert.rejects(
          resolveUserInput({ isFirstInput: false }),
          /process.exit called/,
        );
        assert.strictEqual(getState().terminal.loadingStateTimeout, null);
        assert.strictEqual(getState().terminal.loadingStateFrameIdx, 0);
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${YELLOW}━━ ${BOLD}Input${BOLD_RESET} ━━${RESET}\n`,
          `${PURPLE}Resume this session with /resume 42000${RESET}\n`,
          "\n",
        ]);
      });

      it("exits on ctrl-d when readline closes", async () => {
        mock.restoreAll();
        setupTestContext({ now: 42_000 });
        getWrites = mockStdoutWrites();
        mockProcessExit();
        actions.terminal.setRl(makeFakeRl());
        actions.terminal.resetStdout();
        mockReadlineQuestionResults([
          makeAbortError("Aborted with Ctrl+D"),
          makeErrnoError("ERR_USE_AFTER_CLOSE", "readline was closed"),
        ]);

        await assert.rejects(
          resolveUserInput({ isFirstInput: false }),
          /process.exit called/,
        );

        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${YELLOW}━━ ${BOLD}Input${BOLD_RESET} ━━${RESET}\n`,
          `${PURPLE}Resume this session with /resume 42000${RESET}\n`,
          "\n",
        ]);
      });

      it("exits when the prompt fails after readline closed", async () => {
        mock.restoreAll();
        setupTestContext({ now: 42_000 });
        getWrites = mockStdoutWrites();
        mockProcessExit();
        actions.terminal.setRl(makeFakeRl());
        actions.terminal.resetStdout();
        mockReadlineQuestionResults([
          makeErrnoError("ERR_USE_AFTER_CLOSE", "readline was closed"),
        ]);

        await assert.rejects(
          resolveUserInput({ isFirstInput: false }),
          /process.exit called/,
        );

        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${YELLOW}━━ ${BOLD}Input${BOLD_RESET} ━━${RESET}\n`,
          "\n",
          `${PURPLE}Resume this session with /resume 42000${RESET}\n`,
          "\n",
        ]);
      });
    });
  });

  describe("parseInputFromEditor", () => {
    describe("splits on the delimiter", () => {
      it("returns the whole editor value and clears it when no delimiter is present", async () => {
        actions.terminal.setEditorInputValue("editor content");
        const result = await parseInputFromEditor();
        assert.strictEqual(result, "editor content");
        assert.strictEqual(getState().terminal.editorInputValue, null);
        assert.deepStrictEqual(getState().conversation.transcript, [
          { timestamp: 0, role: "user", message: "editor content" },
        ]);
      });

      it("splits on the delimiter, returns the first message, and keeps the rest", async () => {
        actions.terminal.setEditorInputValue(`first
l---
second
l---
third
`);
        const result = await parseInputFromEditor();
        assert.strictEqual(result, "first\n");
        assert.strictEqual(
          getState().terminal.editorInputValue,
          `second
l---
third
`,
        );
        assert.deepStrictEqual(getState().conversation.transcript, [
          { timestamp: 0, role: "user", message: "first\n" },
        ]);
      });

      it("returns queued messages one per call until the queue is drained", async () => {
        actions.terminal.setEditorInputValue(`first
l---
second
l---
third
`);
        assert.strictEqual(await parseInputFromEditor(), "first\n");
        assert.strictEqual(await parseInputFromEditor(), "second\n");
        assert.strictEqual(await parseInputFromEditor(), "third\n");
        assert.strictEqual(getState().terminal.editorInputValue, null);
      });

      it("filters empty parts around the delimiter", async () => {
        actions.terminal.setEditorInputValue(`l---
msg
l---
`);
        const result = await parseInputFromEditor();
        assert.strictEqual(result, "msg\n");
        assert.strictEqual(getState().terminal.editorInputValue, null);
      });

      it("returns null when the editor value is nothing but delimiters", async () => {
        actions.terminal.setEditorInputValue(`l---
l---
`);
        assert.strictEqual(await parseInputFromEditor(), null);
        assert.strictEqual(getState().terminal.editorInputValue, null);
      });
    });

    describe("splits slash commands", () => {
      it("splits slash command lines into their own messages", async () => {
        actions.content.setSlashCommands([
          {
            name: "cwd",
            filePath: "/test/.lasso/commands/cwd.md",
            content: "cwd",
          },
        ]);
        actions.terminal.setEditorInputValue(`message 2
/cwd
`);
        assert.strictEqual(await parseInputFromEditor(), "message 2\n");
        assert.strictEqual(getState().terminal.editorInputValue, "/cwd\n");
        assert.deepStrictEqual(getState().conversation.transcript, [
          { timestamp: 0, role: "user", message: "message 2\n" },
        ]);
      });

      it("keeps the user's internal newlines when a command splits multi-line text", async () => {
        actions.content.setSlashCommands([
          {
            name: "cwd",
            filePath: "/test/.lasso/commands/cwd.md",
            content: "cwd",
          },
        ]);
        actions.terminal.setEditorInputValue(`line one
line two
/cwd
line three
`);
        assert.strictEqual(
          await parseInputFromEditor(),
          "line one\nline two\n",
        );
        assert.strictEqual(
          getState().terminal.editorInputValue,
          `/cwd
l---
line three
`,
        );
      });

      it("keeps arguments on the slash command line intact", async () => {
        actions.content.setSlashCommands([
          {
            name: "cwd",
            filePath: "/test/.lasso/commands/cwd.md",
            content: "cwd",
          },
        ]);
        actions.terminal.setEditorInputValue(`context
/cwd /some/path
`);
        assert.strictEqual(await parseInputFromEditor(), "context\n");
        assert.strictEqual(
          getState().terminal.editorInputValue,
          "/cwd /some/path\n",
        );
      });

      it("returns the slash command when it is the first message", async () => {
        actions.content.setSlashCommands([
          {
            name: "cwd",
            filePath: "/test/.lasso/commands/cwd.md",
            content: "cwd",
          },
        ]);
        actions.terminal.setEditorInputValue(`/cwd
rest`);
        assert.strictEqual(await parseInputFromEditor(), "/cwd\n");
        assert.strictEqual(getState().terminal.editorInputValue, "rest");
      });

      it("splits multiple slash commands within a single chunk", async () => {
        actions.content.setSlashCommands([
          {
            name: "cwd",
            filePath: "/test/.lasso/commands/cwd.md",
            content: "cwd",
          },
          {
            name: "pwd",
            filePath: "/test/.lasso/commands/pwd.md",
            content: "pwd",
          },
        ]);
        actions.terminal.setEditorInputValue(`first
/cwd
second
/pwd
`);
        assert.strictEqual(await parseInputFromEditor(), "first\n");
        assert.strictEqual(
          getState().terminal.editorInputValue,
          `/cwd
l---
second
l---
/pwd
`,
        );
      });

      it("returns queued slash commands one per call until the queue is drained", async () => {
        actions.content.setSlashCommands([
          {
            name: "cwd",
            filePath: "/test/.lasso/commands/cwd.md",
            content: "cwd",
          },
          {
            name: "pwd",
            filePath: "/test/.lasso/commands/pwd.md",
            content: "pwd",
          },
        ]);
        actions.terminal.setEditorInputValue(`first
l---
/cwd
l---
/pwd
`);
        assert.strictEqual(await parseInputFromEditor(), "first\n");
        assert.strictEqual(await parseInputFromEditor(), "/cwd\n");
        assert.strictEqual(await parseInputFromEditor(), "/pwd\n");
        assert.strictEqual(getState().terminal.editorInputValue, null);
      });
    });
  });
});
