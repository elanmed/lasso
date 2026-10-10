import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert, { AssertionError } from "node:assert/strict";
import { join, dirname } from "node:path";
import { type ModelMessage, type LanguageModelUsage } from "ai";
import { z } from "zod";
import { DetachedWindowAPI } from "happy-dom";
import {
  safeStringify,
  strToApproxTokens,
  stringify,
  wrapInColor,
  bold,
  parseFrontMatter,
  createLockUtils,
  execGitDiff,
} from "./utils.ts";
import {
  actions,
  getState,
  type MCPToolSet,
  harnessTools,
  stringifyTools,
  promptDeps,
  maybeCompact,
  getConversationSummary,
  getMergedSummaries,
  resolveApiCall,
  ConfigSchema,
  DefaultedConfigSchema,
  isSameKey,
  getBaseAgentPrompt,
  getConversationSummaryPrompt,
  getMergeSummariesPrompt,
  getSubagentPrompt,
  getSessionDir,
  getDataDir,
  getGlobalConfigDir,
  getGlobalContextDir,
  getDebugLogDir,
  getGlobalConfigPath,
  getStateDir,
  getUsageLogLockPath,
  getUsageLogPath,
  SessionFileSchema,
  defaultConfig,
  MISSING,
  initMcpState,
  createParallelPerformanceLogger,
  createPerformanceLogger,
  startLoadingState,
  stopLoadingState,
  colorPrint,
  printSessionStartDate,
  printNewline,
  successWithSpacing,
  errorWithSpacing,
  getContextFilesStr,
  getContextEntries,
  getSkillsStr,
  getSkills,
  getSkillJSON,
  appendModelUsage,
  filterExpiredModelUsage,
  getApproxPromptTokens,
  getCurrentPromptTokens,
  getExpiredTime,
  getMaxNumberSummaries,
  getPrettyTokensByArea,
  getPromptOverheadTokensApprox,
  getTokensByArea,
  warnOnLargePromptOverhead,
  isUsageLimitDisabled,
  syncInitialModelUsageForLimitWindow,
  syncNewModelUsageForLimitWindow,
  listSessionFiles,
  getApproxTokensFromMessages,
  truncate,
  getUnicodeChar,
  fencePrint,
  getPrettyApiDuration,
  getPrettyContextWindowUsage,
  getPrettyTokenUsage,
  getUsageMoneyForModel,
  sumUsageTokens,
  createToolCallDiffer,
  getHeaders,
  getLanguageModel,
  getTranscriptionProvider,
  initSessionFile,
  deleteExpiredSessionFiles,
  syncSessionFile,
  resumeFromSessionFile,
  executeMcpListResourcesTool,
  executeMcpReadResourceTool,
  executeBat,
  formatMarkdown,
  openWithPager,
  getAvailableSlashCommands,
  getCustomSlashCommandsStr,
  bashToolInputSchema,
  executeBashTool,
  executeWebFetchHtmlTool,
  executeReadImageTool,
  executeWebFetchJsonTool,
  loadSkillTool,
  createSubagentTool,
  createSubagentTaskSchema,
  toolPrint,
  initState,
  initStateFromConfig,
  initStateFirst,
  initStateRepeatable,
  blockOnMissingConfig,
  readConfigFileStr,
  warnOnMissingConfig,
  getLocalConfigPath,
  getTempFileName,
  resolveInterruptWithEditor,
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
  getCapturedTool,
  getCapturedMessages,
  makeMockUsage,
  makeAbortError,
  mockGenerateTextResults,
  testProcessEnv,
  makeFakeMcpClient,
  makeStartupPerformanceLogger,
  CLEAR_LINE,
  CR,
  DOWN_1,
  DOWN_2,
  GREEN,
  PURPLE,
  RED,
  UP_1,
  UP_2,
  mockSetInterval,
  mockClearInterval,
  mockGitLsFilesRejection,
  makeErrnoError,
  mockSetTimeout,
  drainTimerCallbacks,
  mockExecCalls,
  makeFakeMcpToolSet,
  mockMcpClients,
  setMcpClients,
  setMcps,
  batPagerCmd,
  makeInvalidString,
  mockSpawnSync,
  mockPagerSpawn,
  makeFakeFetch,
  mockExecRecordingOptions,
  first,
} from "./test-helpers.ts";
import { aiDeps, processDeps, fsDeps, childProcessDeps } from "./deps.ts";

describe("api", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext({ model: "claude-sonnet-4-20250514" });
    mock.method(promptDeps, "getToolsContentStr", stringifyTools);
    actions.setBaseURL("https://api.anthropic.com");
    actions.setContextStr("");
    actions.setSkillsStr("");
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
        actions.setMcp({}, mcpTools);
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
          totalMs: 600_000,
          toolMs: 30_000,
          tools: {
            bashMs: 120_000,
            create_subagentMs: 300_000,
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

        actions.setReasoning("high");
        await resolveApiCall("hello");
        assert.strictEqual(captured[1]?.["reasoning"], "high");
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
        actions.setConversationMessages([
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
      it("marks prompt tokens dirty on non-abort error", async () => {
        actions.setPromptTokens(50);
        actions.setPromptTokensDirty(false);
        mock.method(aiDeps, "generateText", () =>
          Promise.reject(new Error("network error")),
        );
        const result = await resolveApiCall("hello");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getState().usage.promptTokens, {
          value: 50,
          dirty: true,
        });
      });

      it("leaves the stored token value untouched when marking dirty on abort", async () => {
        actions.setPromptTokens(50);
        actions.setPromptTokensDirty(false);
        const err = makeAbortError();
        mock.method(aiDeps, "generateText", () => Promise.reject(err));
        const result = await resolveApiCall("hello");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getState().usage.promptTokens, {
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
        assert.deepStrictEqual(getState().usage.promptTokens, {
          value: 49,
          dirty: false,
        });
      });

      it("sets tokens to input plus output tokens on each call", async () => {
        await resolveApiCall("first");
        assert.strictEqual(getState().usage.promptTokens.value, 15);

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
        assert.deepStrictEqual(getState().usage.promptTokens, {
          value: 17,
          dirty: false,
        });
      });

      it("re-baselines tokens from usage when stale after model switch", async () => {
        actions.setConversationMessages([
          {
            role: "user",
            content: "existing",
          },
        ]);
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
        assert.deepStrictEqual(getState().conversation.summaries, []);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "user", content: "existing" },
          { role: "user", content: "hello" },
          { role: "assistant", content: "answer" },
        ]);
        assert.deepStrictEqual(getState().usage.promptTokens, {
          value: 55,
          dirty: false,
        });
      });
    });

    describe("prints tool call start", () => {
      it("prints the [mcp] prefix on mcp tool call start", async () => {
        const getWrites = mockStdoutWrites();
        actions.setMcp({}, { mcp_tool: makeMcpTool() });
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
          `${BLUE}${BOLD}   create_subagent${BOLD_RESET}: [claude-sonnet-4-20250514] investigate tests${RESET}\n`,
          `${BLUE}${BOLD}   create_subagent${BOLD_RESET}: [claude-sonnet-4-20250514] write code${RESET}\n`,
        ]);
      });
    });

    describe("handles temp files and diffs", () => {
      it("resets the tool edit diffs at the start of the api call", async () => {
        actions.appendToolEditDiff({
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
                  filePath: "/test/file.txt",
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
        assert.strictEqual(
          testFs._files.has("/tmp/lasso-test-uuid.txt"),
          false,
        );
      });
    });

    describe("aborted calls", () => {
      it("resolves the queued editor input when the api call is interrupted", async () => {
        actions.setRl(makeFakeRl());
        actions.setEditorInputValue("queued input");
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
        assert.deepStrictEqual(getState().usage.promptTokens, {
          value: 0,
          dirty: true,
        });
      });
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

    describe("decides with approximated tokens", () => {
      it("returns early when below the compact threshold", async () => {
        actions.setConversationMessages([{ role: "user", content: "hi" }]);
        actions.setPromptTokens(60_000);
        actions.setPromptTokensDirty(false);
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
        assert.deepStrictEqual(getState().usage.promptTokens, {
          value: 60_000,
          dirty: false,
        });
      });

      it("uses approximated tokens when stale to decide compaction", async () => {
        const longUserContent = "a".repeat(300_000);
        actions.setConversationMessages([
          {
            role: "user",
            content: longUserContent,
          },
        ]);
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
        assert.deepStrictEqual(getState().conversation.summaries, [
          { compacted: "compacted summary", compactedAt: 0, tokens: 25_000 },
        ]);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "assistant", content: "compacted summary" },
        ]);
        assert.deepStrictEqual(getState().usage.promptTokens, {
          value: 25_000 + getApproxAdditions(),
          dirty: false,
        });
      });

      it("returns early when approximated tokens are below the compact threshold only even when stale", async () => {
        const longUserContent = "a".repeat(20_000);
        actions.setConversationMessages([
          {
            role: "user",
            content: longUserContent,
          },
        ]);
        actions.setPromptTokens(2_000);
        actions.setPromptTokensDirty(true);
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
        assert.deepStrictEqual(getState().usage.promptTokens, {
          value: 2_000,
          dirty: true,
        });
      });

      it("includes the system prompt in the stale approximation when deciding compaction", async () => {
        const systemContent = "s".repeat(100_000);
        mock.method(promptDeps, "getSystemContent", () => systemContent);
        const longUserContent = "a".repeat(190_000);
        actions.setConversationMessages([
          {
            role: "user",
            content: longUserContent,
          },
        ]);
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
        actions.setConversationMessages([
          {
            role: "user",
            content: longUserContent,
          },
        ]);
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
        const toolsTokensApprox = strToApproxTokens(
          safeStringify(harnessTools),
        );
        assert.strictEqual(strToApproxTokens(longUserContent) < 95_000, true);
        assert.strictEqual(
          strToApproxTokens(longUserContent) + toolsTokensApprox >= 95_000,
          true,
        );
        assert.strictEqual(called, true);
      });

      it("excludes image and file parts from the stale approximation", async () => {
        actions.setConversationMessages([
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
    });

    describe("compacts the conversation", () => {
      it("includes mcp tools in the tokens after compaction", async () => {
        actions.setMcp({}, { mcp_tool: makeMcpTool() });
        actions.setConversationMessages([{ role: "user", content: "hi" }]);
        actions.setPromptTokens(96_000);
        actions.setPromptTokensDirty(false);
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
        assert.deepStrictEqual(getState().conversation.summaries, [
          { compacted: "compacted summary", compactedAt: 0, tokens: 25_000 },
        ]);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "assistant", content: "compacted summary" },
        ]);
        assert.deepStrictEqual(getState().usage.promptTokens, {
          value: 25_000 + withMcpTools,
          dirty: false,
        });
        assert.strictEqual(withMcpTools > withoutMcpTools, true);
      });

      it("compacts the conversation when above the threshold", async () => {
        actions.setConversationMessages([{ role: "user", content: "hi" }]);
        actions.setPromptTokens(96_000);
        actions.setPromptTokensDirty(false);
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
[{"role":"user","content":"hi"}]
\`\`\``,
        );
        assert.deepStrictEqual(getState().conversation.summaries, [
          { compacted: "compacted summary", compactedAt: 0, tokens: 25_000 },
        ]);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "assistant", content: "compacted summary" },
        ]);
        assert.deepStrictEqual(getState().usage.promptTokens, {
          value: 25_000 + getApproxAdditions(),
          dirty: false,
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
        actions.setConversationMessages([{ role: "user", content: "hi" }]);
        actions.setPromptTokens(95_000);
        actions.setPromptTokensDirty(false);
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
        assert.deepStrictEqual(getState().usage.promptTokens, {
          value: 25_000 + getApproxAdditions(),
          dirty: false,
        });
      });

      it("compacts against the default context window when the model has none configured", async () => {
        actions.setContextWindowPerModel({});
        actions.setConversationMessages([{ role: "user", content: "hi" }]);
        actions.setPromptTokens(122_000);
        actions.setPromptTokensDirty(false);
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
        actions.setConversationMessages([{ role: "user", content: "old" }]);
        actions.setPromptTokens(96_000);
        actions.setPromptTokensDirty(false);
        const calls: ModelMessage[][] = [];
        let callCount = 0;
        mock.method(
          aiDeps,
          "generateText",
          async (opts: Record<string, unknown>) => {
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
                responseMessages: [
                  { role: "assistant", content: "answer text" },
                ],
              };
            })();
            callCount = callCount + 1;
            return Promise.resolve(makeGenerateTextResult(overrides));
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
        assert.deepStrictEqual(getState().usage.promptTokens, {
          value: 25,
          dirty: false,
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
[{"role":"user","content":"old"}]
\`\`\``,
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

    describe("keeps messages on failure", () => {
      it("keeps messages when generateText fails", async () => {
        actions.setConversationMessages([{ role: "user", content: "hi" }]);
        actions.setPromptTokens(96_000);
        actions.setPromptTokensDirty(false);
        mock.method(aiDeps, "generateText", () =>
          Promise.reject(new Error("network error")),
        );
        await maybeCompact("hi");
        assert.deepStrictEqual(getState().conversation.summaries, []);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "user", content: "hi" },
        ]);
        assert.deepStrictEqual(getState().usage.promptTokens, {
          value: 96_000,
          dirty: false,
        });
      });

      it("resolves the queued editor input when compaction is aborted", async () => {
        const getWrites = mockStdoutWrites();
        actions.setConversationMessages([{ role: "user", content: "hi" }]);
        actions.setPromptTokens(96_000);
        actions.setPromptTokensDirty(false);
        actions.setRl(makeFakeRl());
        actions.setEditorInputValue("queued input");
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
        actions.setConversationMessages([{ role: "user", content: "hi" }]);
        actions.setPromptTokens(96_000);
        actions.setPromptTokensDirty(false);
        const err = makeAbortError();
        mock.method(aiDeps, "generateText", () => Promise.reject(err));
        await maybeCompact("hi");
        assert.strictEqual(getState().abortControllers.apiStream, null);
        assert.deepStrictEqual(getState().conversation.summaries, []);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "user", content: "hi" },
        ]);
        assert.deepStrictEqual(getState().usage.promptTokens, {
          value: 96_000,
          dirty: false,
        });
        assert.deepStrictEqual(getWrites(), [`${BLUE}Compacting…${RESET}\n`]);
      });

      it("aborts the merge when the controller is aborted after summarizing", async () => {
        for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
          actions.setConversationSummaries([
            ...getState().conversation.summaries,
            { compacted: `summary ${String(i)}`, compactedAt: i, tokens: 100 },
          ]);
        }
        actions.setConversationMessages([{ role: "user", content: "hi" }]);
        actions.setPromptTokens(96_000);
        actions.setPromptTokensDirty(false);
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
          actions.setConversationSummaries([
            ...getState().conversation.summaries,
            { compacted: `summary ${String(i)}`, compactedAt: i, tokens: 100 },
          ]);
          actions.setConversationMessages([
            ...getState().conversation.messages,
            { role: "assistant", content: `summary ${String(i)}` },
          ]);
        }
        actions.setConversationMessages([
          ...getState().conversation.messages,
          { role: "user", content: "hi" },
        ]);
        actions.setPromptTokens(96_000);
        actions.setPromptTokensDirty(false);
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
        assert.deepStrictEqual(getState().usage.promptTokens, {
          value: 15 + 800 + 20 + getApproxAdditions(),
          dirty: false,
        });
      });

      it("keeps the existing summaries when merging fails during compaction", async () => {
        for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
          actions.setConversationSummaries([
            ...getState().conversation.summaries,
            { compacted: `summary ${String(i)}`, compactedAt: i, tokens: 100 },
          ]);
          actions.setConversationMessages([
            ...getState().conversation.messages,
            { role: "assistant", content: `summary ${String(i)}` },
          ]);
        }
        actions.setConversationMessages([
          ...getState().conversation.messages,
          { role: "user", content: "hi" },
        ]);
        actions.setPromptTokens(96_000);
        actions.setPromptTokensDirty(false);
        const generate = mockGenerateTextResults([
          {
            output: { compacted: "compacted summary" },
            usage: makeMockUsage({ outputTokens: 20 }),
          },
          new Error("network error"),
        ]);
        await maybeCompact("hi");
        assert.strictEqual(generate.callCount(), 2);
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
        assert.deepStrictEqual(getState().usage.promptTokens, {
          value: 1000 + 20 + getApproxAdditions(),
          dirty: false,
        });
      });
    });
  });

  describe("getConversationSummary", () => {
    beforeEach(() => {
      actions.setApiStreamAbortController(new AbortController());
      actions.setContextWindowPerModel({ "claude-sonnet-4-20250514": 100_000 });
      mock.method(Date, "now", () => 42);
    });

    const usage = makeMockUsage();

    const seedConversation = () => {
      actions.setConversationSummaries([
        { compacted: "prior summary", compactedAt: 1, tokens: 10 },
      ]);
      actions.setConversationMessages([
        {
          role: "assistant",
          content: "prior summary",
        },
        {
          role: "user",
          content: "not yet summarized",
        },
      ]);
      actions.setPromptTokens(85_000);
      actions.setPromptTokensDirty(false);
    };

    describe("summarizes the conversation", () => {
      it("strips image data from tool results in the compact prompt", async () => {
        actions.setConversationSummaries([]);
        actions.setConversationMessages([
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
        actions.setPromptTokens(85_000);
        actions.setPromptTokensDirty(false);
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
        await getConversationSummary();
        assert.strictEqual(getMessages().length, 1);
        assert.deepStrictEqual(capturedOpts?.["timeout"], {
          totalMs: 600_000,
          toolMs: 30_000,
          tools: {
            bashMs: 120_000,
            create_subagentMs: 300_000,
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
[{"role":"user","content":"not yet summarized"}]
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
        const result = await getConversationSummary();
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
    });

    describe("returns null on failure", () => {
      it("returns null and does not touch messages when generateText fails", async () => {
        seedConversation();
        mock.method(aiDeps, "generateText", () =>
          Promise.reject(new Error("network error")),
        );
        const result = await getConversationSummary();
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getState().conversation.summaries, [
          { compacted: "prior summary", compactedAt: 1, tokens: 10 },
        ]);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "assistant", content: "prior summary" },
          { role: "user", content: "not yet summarized" },
        ]);
        assert.deepStrictEqual(getState().usage.promptTokens, {
          value: 85_000,
          dirty: false,
        });
      });

      it("returns null and does not touch messages on abort error", async () => {
        const getWrites = mockStdoutWrites();
        seedConversation();
        const err = makeAbortError();
        mock.method(aiDeps, "generateText", () => Promise.reject(err));
        const result = await getConversationSummary();
        assert.strictEqual(result, null);
        assert.notStrictEqual(getState().abortControllers.apiStream, null);
        assert.deepStrictEqual(getState().conversation.summaries, [
          { compacted: "prior summary", compactedAt: 1, tokens: 10 },
        ]);
        assert.deepStrictEqual(getState().conversation.messages, [
          { role: "assistant", content: "prior summary" },
          { role: "user", content: "not yet summarized" },
        ]);
        assert.deepStrictEqual(getState().usage.promptTokens, {
          value: 85_000,
          dirty: false,
        });
        assert.deepStrictEqual(getWrites(), []);
      });

      it("resolves the queued editor input on abort error", async () => {
        seedConversation();
        actions.setRl(makeFakeRl());
        actions.setEditorInputValue("queued input");
        const getWrites = mockStdoutWrites();
        const err = makeAbortError();
        mock.method(aiDeps, "generateText", () => Promise.reject(err));
        const result = await getConversationSummary();
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
      actions.setApiStreamAbortController(new AbortController());
      actions.setContextWindowPerModel({ "claude-sonnet-4-20250514": 100_000 });
      mock.method(Date, "now", () => 42);
    });

    const usage = makeMockUsage();

    const seedSummaries = () => {
      for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
        actions.setConversationSummaries([
          ...getState().conversation.summaries,
          { compacted: `summary ${String(i)}`, compactedAt: i, tokens: 100 },
        ]);
        actions.setConversationMessages([
          {
            role: "assistant",
            content: `summary ${String(i)}`,
          },
        ]);
      }
    };

    describe("merges summaries", () => {
      it("returns the existing summaries without calling the api when below the summary max", async () => {
        actions.setConversationSummaries([
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
        actions.setContextWindowPerModel({
          "claude-sonnet-4-20250514": 40_000,
        });
        actions.setConversationSummaries([
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
        const result = await getMergedSummaries();
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
        await getMergedSummaries();
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
        const result = await getMergedSummaries();
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
        const result = await getMergedSummaries();
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
        const result = await getMergedSummaries();
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

describe("config-types", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("ConfigSchema and DefaultedConfigSchema have the same keys", () => {
    assert.deepStrictEqual(
      Object.keys(ConfigSchema.shape).sort(),
      Object.keys(DefaultedConfigSchema.shape).sort(),
    );
  });
  describe("isSameKey", () => {
    describe("matching keys", () => {
      it("returns true when missing modifier fields match false ones", () => {
        assert.equal(
          isSameKey(
            { name: "g", ctrl: true },
            { name: "g", ctrl: true, meta: false, shift: false },
          ),
          true,
        );
      });

      it("returns true when all fields match", () => {
        assert.equal(
          isSameKey(
            { name: "e", ctrl: true, meta: false, shift: false },
            { name: "e", ctrl: true, meta: false, shift: false },
          ),
          true,
        );
      });
    });

    describe("differing keys", () => {
      it("returns false when name differs", () => {
        assert.equal(
          isSameKey(
            { name: "e", ctrl: true, meta: false, shift: false },
            { name: "x", ctrl: true, meta: false, shift: false },
          ),
          false,
        );
      });

      it("returns false when ctrl differs", () => {
        assert.equal(
          isSameKey(
            { name: "e", ctrl: true, meta: false, shift: false },
            { name: "e", ctrl: false, meta: false, shift: false },
          ),
          false,
        );
      });

      it("returns false when meta differs", () => {
        assert.equal(
          isSameKey(
            { name: "x", ctrl: false, meta: true, shift: false },
            { name: "x", ctrl: false, meta: false, shift: false },
          ),
          false,
        );
      });

      it("returns false when shift differs", () => {
        assert.equal(
          isSameKey(
            { name: "x", ctrl: false, meta: false, shift: true },
            { name: "x", ctrl: false, meta: false, shift: false },
          ),
          false,
        );
      });
    });
  });

  describe("contextWindowPerModel", () => {
    const schema = ConfigSchema.shape.contextWindowPerModel;

    it("accepts a context window equal to the minimum", () => {
      const result = schema.safeParse({ "test-model": 40_000 });
      assert.deepStrictEqual(result.data, { "test-model": 40_000 });
    });

    it("accepts a null context window", () => {
      const result = schema.safeParse({ "test-model": null });
      assert.deepStrictEqual(result.data, { "test-model": null });
    });

    it("rejects a context window below the minimum", () => {
      const result = schema.safeParse({ "test-model": 39_999 });
      assert.strictEqual(result.success, false);
    });
  });
});

describe("prompts", () => {
  describe("system prompts", () => {
    it("formats the base agent prompt exactly", () => {
      assert.strictEqual(
        getBaseAgentPrompt([]),
        [
          "# [lasso] Base system prompt",
          "",
          "## [lasso] Core principles",
          "",
          "- You are an AI agent being called from a minimal terminal cli called lasso.",
          "- Be concise: 1 sentence when possible, under 25 words unless detail is required. Questions get answers, no padding.",
          "- For debugging: give 1 command at a time, never multiple",
          "- All responses are piped through bat as markdown — always emit valid markdown",
          "- After a successful file-modifying tool (bash with fileSystemAccessType create-update-delete): the CLI auto-outputs a diff. Do NOT repeat the code, file contents, or a diff of the change in your response — summarize in prose only. Verification via a targeted read (e.g. sed -n) is fine, but don't re-echo what the diff already showed",
          "",
          "## [lasso] MCP Servers",
          "",
          "No available MCP servers",
          "",
          "## Filesystem actions (via bash)",
          "",
          "Note: ${START}, ${END}, ${LINE} are placeholders. Replace with actual line numbers.",
          "",
          "### Read a range of lines",
          "```bash",
          'sed -n "${START},${END}p" target.txt',
          "```",
          "",
          "### Read an image as base64",
          "```bash",
          "base64 < target.png",
          "```",
          "",
          "### Get total line count",
          "```bash",
          "wc -l < target.txt",
          "```",
          "",
          "### Write content to an empty file",
          "```bash",
          "cat > target.txt << 'EOF'",
          "Your content here",
          'with "quotes" and $variables left literal',
          "EOF",
          "```",
          "",
          "### Insert content starting after a line",
          "```bash",
          "INSERTFILE=$(mktemp)",
          "cat > \"$INSERTFILE\" << 'EOF'",
          "Content to insert",
          "EOF",
          "TMPFILE=$(mktemp)",
          'sed -e "${LINE}r $INSERTFILE" target.txt > "$TMPFILE" && mv "$TMPFILE" target.txt',
          'rm "$INSERTFILE"',
          "```",
          "",
          "### Replace a range of lines",
          "```bash",
          "INSERTFILE=$(mktemp)",
          "cat > \"$INSERTFILE\" << 'EOF'",
          "Replacement content",
          "EOF",
          "TMPFILE=$(mktemp)",
          'sed -e "${END}r $INSERTFILE" -e "${START},${END}d" target.txt > "$TMPFILE" && mv "$TMPFILE" target.txt',
          'rm "$INSERTFILE"',
          "```",
          "",
          "### Delete a range of lines",
          "```bash",
          "TMPFILE=$(mktemp)",
          'sed -e "${START},${END}d" target.txt > "$TMPFILE" && mv "$TMPFILE" target.txt',
          "```",
        ].join("\n"),
      );
    });

    describe("mcp servers", () => {
      it("formats the base agent prompt with mcp server bullets", () => {
        const prompt = getBaseAgentPrompt(["alpha", "beta"]);
        assert(
          prompt.includes("## [lasso] MCP Servers\n\n- alpha\n- beta\n\n"),
        );
      });

      it("formats the read-only subagent prompt with mcp server bullets", () => {
        const prompt = getSubagentPrompt("read-only", ["alpha"]);
        assert(prompt.includes("## [lasso] MCP Servers\n\n- alpha\n\n"));
      });

      it("formats the read-write subagent prompt with mcp server bullets", () => {
        const prompt = getSubagentPrompt("read-write", ["alpha"]);
        assert(prompt.includes("## [lasso] MCP Servers\n\n- alpha\n\n"));
      });

      it("uses No available MCP servers as the list when there are none", () => {
        const prompt = getBaseAgentPrompt([]);

        assert(
          prompt.includes(
            "## [lasso] MCP Servers\n\nNo available MCP servers\n\n",
          ),
        );
      });
    });

    it("formats a read-only subagent prompt exactly", () => {
      assert.strictEqual(
        getSubagentPrompt("read-only", []),
        [
          "# [lasso] Base system prompt",
          "",
          "## [lasso] Core principles",
          "- You are a read-only subagent. Although you have access to a bash tool, you must NOT use it to perform any modifications to the file system.",
          "",
          "## [lasso] MCP Servers",
          "",
          "No available MCP servers",
          "",
          "## Filesystem actions (via bash)",
          "",
          "Note: ${START}, ${END}, ${LINE} are placeholders. Replace with actual line numbers.",
          "",
          "### Read a range of lines",
          "```bash",
          'sed -n "${START},${END}p" target.txt',
          "```",
          "",
          "### Read an image as base64",
          "```bash",
          "base64 < target.png",
          "```",
          "",
          "### Get total line count",
          "```bash",
          "wc -l < target.txt",
          "```",
        ].join("\n"),
      );
    });

    it("formats a read-write subagent prompt exactly", () => {
      assert.strictEqual(
        getSubagentPrompt("read-write", []),
        [
          "# [lasso] Base system prompt",
          "",
          "## [lasso] Core principles",
          "- You are a subagent with read-write access.",
          "",
          "## [lasso] MCP Servers",
          "",
          "No available MCP servers",
          "",
          "## Filesystem actions (via bash)",
          "",
          "Note: ${START}, ${END}, ${LINE} are placeholders. Replace with actual line numbers.",
          "",
          "### Read a range of lines",
          "```bash",
          'sed -n "${START},${END}p" target.txt',
          "```",
          "",
          "### Read an image as base64",
          "```bash",
          "base64 < target.png",
          "```",
          "",
          "### Get total line count",
          "```bash",
          "wc -l < target.txt",
          "```",
          "",
          "### Write content to an empty file",
          "```bash",
          "cat > target.txt << 'EOF'",
          "Your content here",
          'with "quotes" and $variables left literal',
          "EOF",
          "```",
          "",
          "### Insert content starting after a line",
          "```bash",
          "INSERTFILE=$(mktemp)",
          "cat > \"$INSERTFILE\" << 'EOF'",
          "Content to insert",
          "EOF",
          "TMPFILE=$(mktemp)",
          'sed -e "${LINE}r $INSERTFILE" target.txt > "$TMPFILE" && mv "$TMPFILE" target.txt',
          'rm "$INSERTFILE"',
          "```",
          "",
          "### Replace a range of lines",
          "```bash",
          "INSERTFILE=$(mktemp)",
          "cat > \"$INSERTFILE\" << 'EOF'",
          "Replacement content",
          "EOF",
          "TMPFILE=$(mktemp)",
          'sed -e "${END}r $INSERTFILE" -e "${START},${END}d" target.txt > "$TMPFILE" && mv "$TMPFILE" target.txt',
          'rm "$INSERTFILE"',
          "```",
          "",
          "### Delete a range of lines",
          "```bash",
          "TMPFILE=$(mktemp)",
          'sed -e "${START},${END}d" target.txt > "$TMPFILE" && mv "$TMPFILE" target.txt',
          "```",
        ].join("\n"),
      );
    });
  });

  describe("compaction prompts", () => {
    it("formats the conversation summary prompt exactly", () => {
      assert.strictEqual(
        getConversationSummaryPrompt({
          targetCharLen: 1000,
          conversation: `## user

hello`,
        }),
        [
          "## [lasso] Compact conversation",
          "",
          "- Compact the following conversation.",
          '- Summarize into exactly two sections: "## Key facts" and "## Everything else".',
          "- Key facts are details that must survive all future compactions, such as decisions, file paths, task state, and user preferences.",
          '- Write "## Key facts" as a flat bullet list of short, self-contained facts.',
          '- When the maximum length is tight, cut from "## Everything else" and never from "## Key facts."',
          "- Output a plain-text prose summary, not JSON or a code fence.",
          "- Output a maximum of 1000 characters.",
          "",
          "## user",
          "",
          "hello",
        ].join("\n"),
      );
    });

    it("formats the merge summaries prompt exactly", () => {
      assert.strictEqual(
        getMergeSummariesPrompt({
          targetCharLen: 500,
          summaries: `first

second`,
        }),
        [
          "## [lasso] Compact summaries",
          "",
          "- Merge the following two summaries into one.",
          '- Build "## Key facts" from the union of the key facts in both summaries.',
          "- Keep every existing key fact: you may deduplicate or reword only when needed, but never change their meaning and never delete one.",
          "- If a key fact is superseded by a later one, delete the outdated one.",
          '- Summarize into exactly two sections: "## Key facts" and "## Everything else".',
          "- Key facts are details that must survive all future compactions, such as decisions, file paths, task state, and user preferences.",
          '- Write "## Key facts" as a flat bullet list of short, self-contained facts.',
          '- When the maximum length is tight, cut from "## Everything else" and never from "## Key facts."',
          "- Output a plain-text prose summary, not JSON or a code fence.",
          "- Output a maximum of 500 characters.",
          "",
          "first",
          "",
          "second",
        ].join("\n"),
      );
    });
  });
});

describe("paths", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  describe("global config dir", () => {
    it("uses the home config dir when XDG_CONFIG_HOME is unset", () => {
      assert.equal(
        getGlobalConfigDir(),
        join("/fake-home", ".config", "lasso"),
      );
    });

    it("uses XDG_CONFIG_HOME for the global config dir when set", () => {
      testProcessEnv._set("XDG_CONFIG_HOME", "/xdg-config");
      const expected = join("/xdg-config", "lasso");
      assert.equal(getGlobalConfigDir(), expected);
      assert.equal(getGlobalContextDir(), join(expected, "context"));
      assert.equal(getGlobalConfigPath(), join(expected, "settings.yaml"));
    });
  });

  describe("state dir", () => {
    it("uses the home state dir when XDG_STATE_HOME is unset", () => {
      assert.equal(
        getStateDir(),
        join("/fake-home", ".local", "state", "lasso"),
      );
    });

    it("uses XDG_STATE_HOME for the state dir when set", () => {
      testProcessEnv._set("XDG_STATE_HOME", "/xdg-state");
      assert.equal(getStateDir(), join("/xdg-state", "lasso"));
      assert.equal(getSessionDir(), join("/xdg-state", "lasso", "sessions"));
      assert.equal(getDebugLogDir(), join("/xdg-state", "lasso", "debug"));
    });
  });

  describe("data dir", () => {
    it("uses the home data dir when XDG_DATA_HOME is unset", () => {
      assert.equal(
        getDataDir(),
        join("/fake-home", ".local", "share", "lasso"),
      );
    });

    it("uses XDG_DATA_HOME for the data dir when set", () => {
      testProcessEnv._set("XDG_DATA_HOME", "/xdg-data");
      assert.equal(getDataDir(), join("/xdg-data", "lasso"));
      assert.equal(getUsageLogPath(), join("/xdg-data", "lasso", "usage.json"));
      assert.equal(
        getUsageLogLockPath(),
        join("/xdg-data", "lasso", "usage.lock"),
      );
    });
  });
});

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

    it("set-suppress-config-warnings", () => {
      assert.strictEqual(getState().config.suppressConfigWarnings, false);
      actions.setSuppressConfigWarnings(true);
      assert.strictEqual(getState().config.suppressConfigWarnings, true);
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
      actions.appendToModelUsageForSession(first, "gpt-4");

      actions.setModel("claude");
      const second = {
        inputTokens: 3,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        date: 2_000,
      };
      actions.appendToModelUsageForSession(second, "claude");

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

describe("print", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  describe("startLoadingState", () => {
    it("writes loadingStateFrames cyclically", () => {
      actions.resetState();
      const callbacks = mockSetInterval();
      mockClearInterval(callbacks);
      actions.setLoadingStateFrames(["a", "b", "c"]);

      const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });

      startLoadingState();
      callbacks.forEach((cb) => cb());
      callbacks.forEach((cb) => cb());
      callbacks.forEach((cb) => cb());
      callbacks.forEach((cb) => cb());
      stopLoadingState();

      assert.deepStrictEqual(getWrites(), [
        "\ra",
        "\rb",
        "\rc",
        "\ra",
        "\rb",
        "\r \r",
      ]);
    });

    it("uses default loadingStateFrames when none set", () => {
      actions.resetState();
      const callbacks = mockSetInterval();
      mockClearInterval(callbacks);

      const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });

      startLoadingState();
      callbacks.forEach((cb) => cb());
      callbacks.forEach((cb) => cb());
      stopLoadingState();

      assert.deepStrictEqual(getWrites(), ["\r|", "\r/", "\r-", "\r \r"]);
    });

    it("stopLoadingState gracefully handles multiple calls", () => {
      actions.resetState();
      const callbacks = mockSetInterval();
      mockClearInterval(callbacks);
      mockStdoutWrites();
      actions.setLoadingStateFrames(["a", "b", "c"]);

      startLoadingState();
      callbacks.forEach((cb) => cb());

      const stop1 = stopLoadingState();
      const stop2 = stopLoadingState();
      assert.strictEqual(stop1, stop2);
    });

    it("serializes concurrent colorPrint calls", async () => {
      actions.resetState();
      const callbacks = mockSetInterval();
      mockClearInterval(callbacks);
      const getWrites = mockStdoutWrites();
      actions.setLoadingStateFrames(["a", "b", "c"]);

      startLoadingState();
      callbacks.forEach((cb) => cb());

      colorPrint("X", "none");
      colorPrint("Y", "none");
      colorPrint("Z", "none");

      await Promise.resolve();

      assert.deepStrictEqual(getWrites(), ["X\n", "Y\n", "Z\n"]);
    });
  });

  describe("createPerformanceLogger", () => {
    it("prints the label when starting and the colored duration when ending", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      const logger = createPerformanceLogger({ logDuration: true });
      const getWrites = mockStdoutWrites();
      logger.start("Reading context files: ");
      assert.deepStrictEqual(getWrites(), [
        `${BLUE}Reading context files: ${RESET}`,
      ]);
      mock.method(process.hrtime, "bigint", () => BigInt(1_234_567_890));

      logger.end();

      assert.deepStrictEqual(getWrites(), [
        `${BLUE}Reading context files: ${RESET}`,
        `${GREEN}234.567ms${RESET}\n`,
      ]);
    });

    it("can start again after end", () => {
      let callIdx = 0;
      const values = [
        1_000_000_000, 1_000_000_000, 2_000_000_000, 3_000_000_000,
      ];
      mock.method(process.hrtime, "bigint", () =>
        BigInt(values[callIdx++] ?? 0),
      );
      const logger = createPerformanceLogger({ logDuration: true });
      const getWrites = mockStdoutWrites();

      logger.start("a: ");
      logger.end();
      logger.start("a: ");
      logger.end();

      assert.deepStrictEqual(getWrites(), [
        `${BLUE}a: ${RESET}`,
        `${GREEN}0.0ms${RESET}\n`,
        `${BLUE}a: ${RESET}`,
        `${RED}1s 0.0ms${RESET}\n`,
      ]);
    });

    it("does nothing when logDuration is false", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      const logger = createPerformanceLogger({ logDuration: false });
      const getWrites = mockStdoutWrites();
      logger.start("a: ");
      logger.end();
      assert.deepStrictEqual(getWrites(), []);
    });

    it("throws when started twice", () => {
      const logger = createPerformanceLogger({ logDuration: true });
      logger.start("a: ");
      assert.throws(() => logger.start("a: "));
    });

    it("throws when ended without start", () => {
      const logger = createPerformanceLogger({ logDuration: true });
      assert.throws(() => logger.end());
    });
  });

  describe("createParallelPerformanceLogger", () => {
    it("prints every label on its own line upfront", () => {
      const logger = createParallelPerformanceLogger({
        logDuration: true,
        logIdToLabel: [
          ["a", "Starting a: "],
          ["b", "Starting b: "],
        ],
      });
      const getWrites = mockStdoutWrites();

      logger.printAllLabels();

      assert.deepStrictEqual(getWrites(), [
        `${BLUE}Starting a: ${RESET}\n`,
        `${BLUE}Starting b: ${RESET}\n`,
      ]);
    });

    it("rewrites each label in place with its duration", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      const logger = createParallelPerformanceLogger({
        logDuration: true,
        logIdToLabel: [
          ["a", "Starting a: "],
          ["b", "Starting b: "],
        ],
      });
      const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });

      logger.printAllLabels();
      logger.start("a");
      mock.method(process.hrtime, "bigint", () => BigInt(1_234_567_890));
      logger.end("a");
      logger.start("b");
      mock.method(process.hrtime, "bigint", () => BigInt(2_234_567_890));
      logger.end("b");

      assert.deepStrictEqual(getWrites(), [
        `${BLUE}Starting a: ${RESET}\n`,
        `${BLUE}Starting b: ${RESET}\n`,
        `${UP_2}${CLEAR_LINE}${CR}`,
        `${BLUE}Starting a: ${RESET}`,
        `${GREEN}234.567ms${RESET}`,
        `${DOWN_2}${CR}`,
        `${UP_1}${CLEAR_LINE}${CR}`,
        `${BLUE}Starting b: ${RESET}`,
        `${RED}1s 0.0ms${RESET}`,
        `${DOWN_1}${CR}`,
      ]);
    });

    it("does nothing when logDuration is false", () => {
      const logger = createParallelPerformanceLogger({
        logDuration: false,
        logIdToLabel: [["a", "Starting a: "]],
      });
      const getWrites = mockStdoutWrites();

      logger.printAllLabels();
      logger.start("a");
      logger.end("a");

      assert.deepStrictEqual(getWrites(), []);
    });

    it("throws when ended without start", () => {
      const logger = createParallelPerformanceLogger({
        logDuration: true,
        logIdToLabel: [["a", "Starting a: "]],
      });
      assert.throws(() => logger.end("a"));
    });
  });

  describe("appendNewline", () => {
    it("appends a newline by default", () => {
      const getWrites = mockStdoutWrites();
      colorPrint("hello", "none");
      assert.deepStrictEqual(getWrites(), ["hello\n"]);
    });

    it("omits the newline when appendNewline is false", () => {
      const getWrites = mockStdoutWrites();
      colorPrint("hello", "none", { appendNewline: false });
      assert.deepStrictEqual(getWrites(), ["hello"]);
    });

    it("keeps color codes around the text without a trailing newline", () => {
      const getWrites = mockStdoutWrites();
      colorPrint("hello", "blue", { appendNewline: false });
      assert.deepStrictEqual(getWrites(), [`${BLUE}hello${RESET}`]);
    });
  });

  describe("whileMuted", () => {
    it("writes to stdout directly while a non-blocking process is ongoing", () => {
      actions.setIsNonBlockingProcessOngoing(true);
      const getWrites = mockStdoutWrites();
      colorPrint("hello", "blue", { whileMuted: true });
      assert.deepStrictEqual(getWrites(), [`${BLUE}hello${RESET}\n`]);
      assert.deepStrictEqual(
        getState().terminal.bufferedStdoutWhileEditorOpen,
        "",
      );
    });

    it("writes to stdout directly while a loading state is active", () => {
      actions.setLoadingStateTimeout({} as NodeJS.Timeout);
      const getWrites = mockStdoutWrites();
      colorPrint("hello", "blue", { whileMuted: true });
      assert.deepStrictEqual(getWrites(), [`${BLUE}hello${RESET}\n`]);
    });
  });

  describe("color disabled", () => {
    it("omits ansi codes when NO_COLOR is set", () => {
      testProcessEnv._set("NO_COLOR", "1");
      const getWrites = mockStdoutWrites();
      colorPrint("hello", "blue");
      assert.deepStrictEqual(getWrites(), ["hello\n"]);
      assert.equal(bold("hello"), "hello");
    });

    it("omits ansi codes when stdout is not a tty", () => {
      mock.method(processDeps.stdout, "isTTY", () => false);
      const getWrites = mockStdoutWrites();
      colorPrint("hello", "blue");
      assert.deepStrictEqual(getWrites(), ["hello\n"]);
    });
  });

  describe("wrapInColor", () => {
    it("wraps the text in color codes", () => {
      assert.strictEqual(wrapInColor("hello", "blue"), `${BLUE}hello${RESET}`);
    });

    it("returns the text unchanged for none", () => {
      assert.strictEqual(wrapInColor("hello", "none"), "hello");
    });
  });

  describe("printNewline", () => {
    it("prints nothing when stdoutTail already ends with two newlines", () => {
      const getWrites = mockStdoutWrites();
      actions.appendStdoutTail("\n\n");
      printNewline();
      assert.deepStrictEqual(getWrites(), []);
    });

    it("appends a newline when stdoutTail does not end with two newlines", () => {
      const getWrites = mockStdoutWrites();
      colorPrint("a", "none", { appendNewline: false });
      printNewline();
      assert.deepStrictEqual(getWrites(), ["a", "\n"]);
    });
  });

  describe("successWithSpacing", () => {
    it("surrounds the callback output with blank lines", () => {
      const getWrites = mockStdoutWrites();
      successWithSpacing(() => colorPrint("hello", "none"));
      assert.deepStrictEqual(getWrites(), ["\n", "hello\n", "\n"]);
    });
  });

  describe("errorWithSpacing", () => {
    it("prints the callback output followed by a blank line", () => {
      const getWrites = mockStdoutWrites();
      errorWithSpacing(() => colorPrint("hello", "none"));
      assert.deepStrictEqual(getWrites(), ["hello\n", "\n"]);
    });

    it("does not reduce the blank lines between messages", () => {
      const getWrites = mockStdoutWrites();
      successWithSpacing(() => colorPrint("a", "none"));
      errorWithSpacing(() => colorPrint("b", "none"));
      assert.deepStrictEqual(getWrites(), ["\n", "a\n", "\n", "b\n", "\n"]);
    });
  });

  describe("printSessionStartDate", () => {
    beforeEach(() => {
      setupTestContext();
      actions.resetStdout();
    });

    it("prints the session start date", () => {
      mock.restoreAll();
      setupTestContext({ now: 42_000 });
      const getWrites = mockStdoutWrites();
      printSessionStartDate();
      assert.deepStrictEqual(getWrites(), [
        `${PURPLE}Resume this session with /resume 42000${RESET}\n`,
      ]);
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
        actions.setCustomSkillDirs(["/custom/skills"]);
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
        actions.setCustomSkillDirs(["/custom/skills"]);
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
        actions.setCustomSkillDirs(["/custom/skills"]);
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

describe("getPromptOverheadTokensApprox", () => {
  beforeEach(() => {
    setupTestContext();
    mock.method(promptDeps, "getSystemContent", () => "abc");
    mock.method(promptDeps, "getToolsContentStr", () => "defdef");
  });

  it("sums the approx of system content and tools", () => {
    assert.strictEqual(getPromptOverheadTokensApprox(), 3);
  });

  it("takes tools into account when computing the prompt overhead approx", () => {
    assert.strictEqual(getApproxPromptTokens(), 3);
  });
});

describe("getApproxPromptTokens", () => {
  beforeEach(() => {
    setupTestContext();
    mock.method(promptDeps, "getSystemContent", () => "abc");
    mock.method(promptDeps, "getToolsContentStr", () => "defdef");
  });

  it("sums messages approx with the system instructions approx", () => {
    actions.setConversationMessages([{ role: "user", content: "hello" }]);
    assert.strictEqual(getApproxPromptTokens(), 14);
  });
});

describe("getCurrentPromptTokens", () => {
  beforeEach(() => {
    setupTestContext();
    mock.method(promptDeps, "getSystemContent", () => "abc");
    mock.method(promptDeps, "getToolsContentStr", () => "defdef");
  });

  it("returns the cached prompt tokens when not dirty", () => {
    actions.setPromptTokens(50);
    actions.setPromptTokensDirty(false);
    assert.strictEqual(getCurrentPromptTokens(), 50);
  });

  it("starts with the token cache marked dirty", () => {
    assert.strictEqual(getState().usage.promptTokens.dirty, true);
  });

  it("returns the approx prompt tokens when dirty", () => {
    actions.setPromptTokens(50);
    actions.setPromptTokensDirty(true);
    assert.strictEqual(getCurrentPromptTokens(), 3);
  });
});

describe("getTokensByArea", () => {
  beforeEach(() => {
    setupTestContext();
    mock.method(promptDeps, "getSystemContent", () => "");
    mock.method(promptDeps, "getToolsContentStr", () => "123456789012");
    actions.setContextStr("123456789");
    actions.setSkillsStr("1234");
    actions.setConversationMessages([{ role: "user", content: "hello" }]);
  });

  it("returns the approx areas when the token cache is dirty", () => {
    actions.setPromptTokensDirty(true);
    assert.deepStrictEqual(getTokensByArea(), {
      messages: 11,
      context: 3,
      tools: 4,
      basePrompt: 619,
      skills: 1,
    });
  });

  it("returns the approx areas when the cached token count is zero", () => {
    actions.setPromptTokensDirty(false);
    assert.deepStrictEqual(getTokensByArea(), {
      messages: 11,
      context: 3,
      tools: 4,
      basePrompt: 619,
      skills: 1,
    });
  });

  it("scales the areas to the cached token count when clean", () => {
    actions.setPromptTokens(1500);
    actions.setPromptTokensDirty(false);
    assert.deepStrictEqual(getTokensByArea(), {
      messages: 1100,
      context: 300,
      tools: 400,
      basePrompt: 61900,
      skills: 100,
    });
  });
});

describe("getPrettyTokensByArea", () => {
  beforeEach(() => {
    setupTestContext();
    mock.method(promptDeps, "getSystemContent", () => "");
    mock.method(promptDeps, "getToolsContentStr", () => "123456789012");
    actions.setContextStr("123456789");
    actions.setSkillsStr("1234");
    actions.setConversationMessages([{ role: "user", content: "hello" }]);
  });

  it("returns each area with its approx count when the cache is dirty", () => {
    actions.setPromptTokensDirty(true);
    assert.strictEqual(
      getPrettyTokensByArea(),
      `- Chat messages: 11
- Context files: 3
- Harness and MCP tools: 4
- Base system prompt: 619
- Skill descriptions: 1`,
    );
  });

  it("returns each area scaled to the cached token count when clean", () => {
    actions.setPromptTokens(1500);
    actions.setPromptTokensDirty(false);
    assert.strictEqual(
      getPrettyTokensByArea(),
      `- Chat messages: 1,100
- Context files: 300
- Harness and MCP tools: 400
- Base system prompt: 61,900
- Skill descriptions: 100`,
    );
  });
});

describe("warnOnLargePromptOverhead", () => {
  beforeEach(() => {
    setupTestContext({ model: "gpt-4" });
    actions.setContextWindowPerModel({ "gpt-4": 100_000 });
  });

  it("returns early without a warning when the model has no context window", () => {
    actions.setContextWindowPerModel({});
    const getWrites = mockStdoutWrites();
    warnOnLargePromptOverhead();
    assert.deepStrictEqual(getWrites(), []);
  });

  it("does not warn when prompt overhead is below the dedicated share", () => {
    mock.method(promptDeps, "getSystemContent", () => "s".repeat(30_000));
    const getWrites = mockStdoutWrites();
    warnOnLargePromptOverhead();
    assert.deepStrictEqual(getWrites(), []);
  });

  it("warns when prompt overhead reaches the dedicated share", () => {
    mock.method(promptDeps, "getSystemContent", () => "s".repeat(210_000));
    const getWrites = mockStdoutWrites();
    warnOnLargePromptOverhead();
    assert.deepStrictEqual(getWrites(), [
      `${YELLOW}The current set of context, skills, and tools is 70% of the 100,000 token context window!\n\nLasso reserves 25% of the context window for compacted summaries with the assumption that at most 70% of the context window will be used for prompt overhead. As is, the prompt overhead is large enough to break this assumption and, along with any user messages, may breach the llm's context window and cause API calls to be rejected. Consider converting some of your context to skills and minimizing MCP servers.${RESET}\n`,
    ]);
  });
});

describe("getMaxNumberSummaries", () => {
  beforeEach(() => {
    setupTestContext({ model: null });
  });

  it("returns null when the model is missing", () => {
    const result = getMaxNumberSummaries();
    assert.strictEqual(result, null);
  });

  it("uses the configured context window", () => {
    actions.setModel("test-model");
    actions.setContextWindowPerModel({ "test-model": 100_000 });
    const result = getMaxNumberSummaries();
    assert.strictEqual(result, 5);
  });

  it("falls back to the default context window", () => {
    actions.setModel("test-model");
    const result = getMaxNumberSummaries();
    assert.strictEqual(result, 6);
  });
});

describe("listSessionFiles", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  it("returns an empty array when the directory does not exist", async () => {
    assert.deepStrictEqual(await listSessionFiles(), []);
  });

  it("prints the error and returns an empty array when the directory cannot be checked", async () => {
    mock.method(fsDeps, "existsSync", () => {
      throw makeErrnoError("EACCES");
    });
    const writes = mockStdoutWrites();

    assert.deepStrictEqual(await listSessionFiles(), []);
    assert.deepStrictEqual(writes(), [
      `${RED}Failed to check if /fake-home/.local/state/lasso/sessions exists. Error: EACCES${RESET}\n`,
    ]);
  });

  it("returns an empty array when the directory has no files", async () => {
    testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
    assert.deepStrictEqual(await listSessionFiles(), []);
  });

  it("returns valid session files with absolute path and timestamp", async () => {
    testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
    testFs._files.set(
      "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
      "",
    );
    testFs._files.set(
      "/fake-home/.local/state/lasso/sessions/session-999990000000.json",
      "",
    );

    assert.deepStrictEqual(await listSessionFiles(), [
      {
        absolutePath:
          "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
        timestampMs: 1234567890000,
      },
      {
        absolutePath:
          "/fake-home/.local/state/lasso/sessions/session-999990000000.json",
        timestampMs: 999990000000,
      },
    ]);
  });

  it("skips directory entries", async () => {
    testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
    testFs._dirs.add(
      "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
    );
    assert.deepStrictEqual(await listSessionFiles(), []);
  });

  it("skips files that do not match session-<timestamp>", async () => {
    testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
    testFs._files.set(
      "/fake-home/.local/state/lasso/sessions/random-file.md",
      "",
    );
    testFs._files.set(
      "/fake-home/.local/state/lasso/sessions/session-uuid-123.json",
      "",
    );
    testFs._files.set(
      "/fake-home/.local/state/lasso/sessions/session-notanumber.json",
      "",
    );
    assert.deepStrictEqual(await listSessionFiles(), []);
  });

  it("skips files with non-json extension", async () => {
    testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
    testFs._files.set(
      "/fake-home/.local/state/lasso/sessions/session-123.log",
      "",
    );
    assert.deepStrictEqual(await listSessionFiles(), []);
  });

  describe("createLockUtils", () => {
    beforeEach(() => {
      mock.method(
        fsDeps,
        "writeFile",
        (path: string, content: string, options?: { flag?: string }) => {
          if (options?.flag === "wx" && testFs._files.has(path)) {
            return Promise.reject(makeErrnoError("EEXIST", `EEXIST: ${path}`));
          }
          return testFs.writeFile(path, content);
        },
      );
    });

    describe("acquires the lock", () => {
      it("creates the lock file with the current pid", async () => {
        const lockUtils = createLockUtils("/lock");
        assert.equal(await lockUtils.createLock(), true);
        assert.equal(testFs._files.get("/lock"), String(process.pid));
      });

      it("returns false and keeps the file when held by a live process", async () => {
        testFs._files.set("/lock", "42");
        mock.method(processDeps, "kill", () => undefined);
        const timerCallbacks = mockSetTimeout();

        const lockUtils = createLockUtils("/lock");
        const promise = lockUtils.createLock();
        await drainTimerCallbacks(timerCallbacks);

        assert.equal(await promise, false);
        assert.equal(testFs._files.get("/lock"), "42");
        mock.restoreAll();
      });

      it("acquires after the holder releases within the retry window", async () => {
        testFs._files.set("/lock", "42");
        mock.method(processDeps, "kill", () => undefined);
        const timerCallbacks = mockSetTimeout();

        const lockUtils = createLockUtils("/lock");
        const promise = lockUtils.createLock();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(timerCallbacks.length, 1);

        testFs._files.delete("/lock");
        const callback = timerCallbacks.shift();
        assert(callback !== undefined);
        callback();

        assert.equal(await promise, true);
        assert.equal(testFs._files.get("/lock"), String(process.pid));
        mock.restoreAll();
      });

      it("reports success when the lock is acquired on the final retry", async () => {
        testFs._files.set("/lock", "42");
        mock.method(processDeps, "kill", () => undefined);
        const timerCallbacks = mockSetTimeout();

        const lockUtils = createLockUtils("/lock");
        const promise = lockUtils.createLock();
        await drainTimerCallbacks(timerCallbacks, { keep: 1 });
        await new Promise<void>((resolve) => setImmediate(resolve));
        testFs._files.delete("/lock");
        const finalCallback = timerCallbacks.shift();
        assert(finalCallback !== undefined);
        finalCallback();

        assert.equal(await promise, true);
        assert.equal(testFs._files.get("/lock"), String(process.pid));
        mock.restoreAll();
      });
    });

    describe("steals the lock", () => {
      it("steals the lock from a dead process (ESRCH)", async () => {
        testFs._files.set("/lock", "42");
        mock.method(processDeps, "kill", () => {
          throw makeErrnoError("ESRCH", "No such process");
        });

        const lockUtils = createLockUtils("/lock");
        assert.equal(await lockUtils.createLock(), true);
        assert.equal(testFs._files.get("/lock"), String(process.pid));
        mock.restoreAll();
      });

      it("returns false when the holder is alive but not ours (EPERM)", async () => {
        testFs._files.set("/lock", "42");
        mock.method(processDeps, "kill", () => {
          throw makeErrnoError("EPERM", "Operation not permitted");
        });
        const timerCallbacks = mockSetTimeout();

        const lockUtils = createLockUtils("/lock");
        const promise = lockUtils.createLock();
        await drainTimerCallbacks(timerCallbacks);

        assert.equal(await promise, false);
        assert.equal(testFs._files.get("/lock"), "42");
        mock.restoreAll();
      });

      it("steals the lock when the file content is not a pid", async () => {
        testFs._files.set("/lock", "not-a-pid");

        const lockUtils = createLockUtils("/lock");
        assert.equal(await lockUtils.createLock(), true);
        assert.equal(testFs._files.get("/lock"), String(process.pid));
      });

      it("steals the lock when the lock file cannot be read", async () => {
        testFs._files.set("/lock", "42");
        mock.method(fsDeps, "readFile", () =>
          Promise.reject(makeErrnoError("EIO", "I/O error")),
        );

        const lockUtils = createLockUtils("/lock");
        assert.equal(await lockUtils.createLock(), true);
        assert.equal(testFs._files.get("/lock"), String(process.pid));
      });
    });

    describe("deletes the lock", () => {
      it("deletes the lock file", () => {
        testFs._files.set("/lock", String(process.pid));
        const lockUtils = createLockUtils("/lock");
        lockUtils.deleteLock();
        assert.equal(testFs._files.has("/lock"), false);
      });

      it("tolerates deleting a missing lock file", () => {
        const lockUtils = createLockUtils("/lock");
        assert.doesNotThrow(() => lockUtils.deleteLock());
      });
    });
  });
});

describe("getApproxTokensFromMessages", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  it("does not count base64 image data in tool results", () => {
    const makeMessages = (data: string) => [
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
                  data: { type: "data", data: data },
                  mediaType: "image/png",
                },
              ],
            },
          },
        ],
      },
    ];
    assert.strictEqual(
      getApproxTokensFromMessages(makeMessages("A".repeat(100_000))),
      getApproxTokensFromMessages(makeMessages("B")),
    );
  });
});

describe("text", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  describe("truncate", () => {
    const MAX_LEN = 100;

    beforeEach(() => {
      mock.method(processDeps.stdout, "getColumns", () => MAX_LEN);
    });

    describe("returns unchanged", () => {
      it("returns empty string unchanged", () => {
        assert.equal(truncate(""), "");
      });

      it("returns strings within the max length unchanged", () => {
        assert.equal(truncate("a".repeat(MAX_LEN)), "a".repeat(MAX_LEN));
      });
    });

    describe("truncates with an ellipsis", () => {
      it("truncates longer strings to the max length with an ellipsis", () => {
        assert.equal(
          truncate("a".repeat(MAX_LEN + 10)),
          `${"a".repeat(MAX_LEN - 1)}…`,
        );
      });

      it("returns the first line with an ellipsis for multiline input", () => {
        assert.equal(truncate("short\nsecond line"), "short…");
      });

      it("truncates a long first line to the max length with an ellipsis", () => {
        assert.equal(
          truncate(`${"a".repeat(MAX_LEN + 10)}\nrest`),
          `${"a".repeat(MAX_LEN - 1)}…`,
        );
      });

      it("truncates with a three-char ellipsis when asciiOnly is set", () => {
        actions.setAsciiOnly(true);
        assert.equal(truncate("a".repeat(MAX_LEN + 10)), `${"a".repeat(99)}~`);
        assert.equal(truncate("short\nsecond line"), "short~");
      });
    });
  });

  it("falls back to 80 columns when stdout columns are undefined", () => {
    mock.method(processDeps.stdout, "getColumns", () => undefined);
    assert.equal(truncate("a".repeat(100)), `${"a".repeat(79)}…`);
  });

  describe("getUnicodeChar", () => {
    it("returns the char unchanged by default", () => {
      assert.equal(getUnicodeChar("…"), "…");
      assert.equal(getUnicodeChar("┊"), "┊");
    });

    it("returns the ascii replacement when asciiOnly is on", () => {
      actions.setAsciiOnly(true);
      assert.equal(getUnicodeChar("…"), "~");
      assert.equal(getUnicodeChar("┊"), "|");
      assert.equal(getUnicodeChar("━"), "=");
    });

    it("throws for a char outside the map", () => {
      assert.throws(() => getUnicodeChar("x"), AssertionError);
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

  describe("fencePrint", () => {
    beforeEach(() => {
      setupTestContext();
      actions.resetStdout();
    });

    describe("without session info", () => {
      it("prints the text in a fence without session info", () => {
        const getWrites = mockStdoutWrites();
        fencePrint("Output");
        assert.deepStrictEqual(getWrites(), [
          `${GREY}━━ ${BOLD}Output${BOLD_RESET} ━━${RESET}\n`,
        ]);
      });

      it("drops the header when it does not fit", () => {
        const longHeader = "a".repeat(100);
        const getWrites = mockStdoutWrites();
        fencePrint(longHeader);

        assert.deepStrictEqual(getWrites(), [
          `${GREY}━━ ${BOLD}${longHeader.substring(0, 73)}…${BOLD_RESET} ━━${RESET}\n`,
        ]);
      });
    });

    describe("with showSessionInfo", () => {
      it("prints duration and token usage when showSessionInfo is set", () => {
        const getWrites = mockStdoutWrites();
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(1_500_000_000));
        actions.setApiEndTime();

        fencePrint("Output", { showSessionInfo: true });

        assert.deepStrictEqual(getWrites(), [
          `${GREY}━━ ${BOLD}Output${BOLD_RESET} (500ms) (0 tokens in session) (0% of context window) ━━${RESET}\n`,
        ]);
      });

      it("includes context window usage when configured", () => {
        const getWrites = mockStdoutWrites();
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(1_500_000_000));
        actions.setApiEndTime();
        actions.setModel("test-model");
        actions.setContextWindowPerModel({ "test-model": 10_000 });
        actions.setConversationMessages([{ role: "user", content: "hi" }]);
        actions.setPromptTokens(5_000);
        actions.setPromptTokensDirty(false);

        fencePrint("Output", { showSessionInfo: true });

        assert.deepStrictEqual(getWrites(), [
          `${GREY}━━ ${BOLD}Output${BOLD_RESET} (500ms) (0 tokens in session) (50% of context window) ━━${RESET}\n`,
        ]);
      });

      it("drops usage when there is not enough room", () => {
        mock.method(processDeps.stdout, "getColumns", () => 20);
        const getWrites = mockStdoutWrites();
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(1_500_000_000));
        actions.setApiEndTime();
        actions.setContextWindowPerModel({ "unknown-model": 10_000 });

        fencePrint("Output", { showSessionInfo: true });

        assert.deepStrictEqual(getWrites(), [
          `${GREY}━━ ${BOLD}Output${BOLD_RESET} (500ms) ━━${RESET}\n`,
        ]);
      });

      it("drops duration and usage when there is not enough room", () => {
        mock.method(processDeps.stdout, "getColumns", () => 19);
        const getWrites = mockStdoutWrites();
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(1_500_000_000));
        actions.setApiEndTime();

        fencePrint("Output", { showSessionInfo: true });

        assert.deepStrictEqual(getWrites(), [
          `${GREY}━━ ${BOLD}Output${BOLD_RESET} ━━${RESET}\n`,
        ]);
      });

      it("truncates the header instead of dropping when showSessionInfo is set", () => {
        const longHeader = "b".repeat(100);
        const getWrites = mockStdoutWrites();
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(1_500_000_000));
        actions.setApiEndTime();

        fencePrint(longHeader, { showSessionInfo: true });

        assert.deepStrictEqual(getWrites(), [
          `${GREY}━━ ${BOLD}${longHeader.substring(0, 73)}…${BOLD_RESET} ━━${RESET}\n`,
        ]);
      });
    });
  });

  describe("getPrettyApiDuration", () => {
    beforeEach(() => {
      actions.resetState();
    });

    describe("milliseconds", () => {
      it("formats sub-second duration as milliseconds", () => {
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(1_500_000_000));
        actions.setApiEndTime();

        const result = getPrettyApiDuration();
        assert.strictEqual(result, "500ms");
      });

      it("includes microseconds when requested", () => {
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(1_234_567_890));
        actions.setApiEndTime();

        const result = getPrettyApiDuration({ includeMicroseconds: true });
        assert.strictEqual(result, "234.567ms");
      });

      it("truncates nanoseconds", () => {
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_123_456));
        actions.setApiEndTime();

        const result = getPrettyApiDuration({ includeMicroseconds: true });
        assert.strictEqual(result, "0.123ms");
      });
    });

    describe("seconds and minutes", () => {
      it("formats seconds and milliseconds", () => {
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(6_500_000_000));
        actions.setApiEndTime();

        const result = getPrettyApiDuration();
        assert.strictEqual(result, "5s 500ms");
      });

      it("formats minutes, zero seconds, and milliseconds", () => {
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(121_500_000_000));
        actions.setApiEndTime();

        const result = getPrettyApiDuration();
        assert.strictEqual(result, "2m 0s 500ms");
      });

      it("formats minutes, seconds, and milliseconds", () => {
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(126_500_000_000));
        actions.setApiEndTime();

        const result = getPrettyApiDuration();
        assert.strictEqual(result, "2m 5s 500ms");
      });
    });

    it("clamps negative durations from clock skew to zero", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      actions.setApiStartTime();
      mock.method(process.hrtime, "bigint", () => BigInt(500_000_000));
      actions.setApiEndTime();

      const result = getPrettyApiDuration();
      assert.strictEqual(result, "0ms");
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

  describe("getPrettyContextWindowUsage", () => {
    beforeEach(() => {
      setupTestContext();
    });

    describe("calculates the percentage", () => {
      it("falls back to the default context window when the model has none configured", () => {
        actions.setModel("unknown-model");
        actions.setPromptTokens(1_280);
        actions.setPromptTokensDirty(false);
        const result = getPrettyContextWindowUsage();
        assert.strictEqual(result, "1% of context window");
      });

      it("returns 0% when no tokens are used", () => {
        actions.setModel("test-model");
        actions.setContextWindowPerModel({ "test-model": 10_000 });
        const result = getPrettyContextWindowUsage();
        assert.strictEqual(result, "0% of context window");
      });

      it("returns the percent of the context window used", () => {
        actions.setModel("test-model");
        actions.setContextWindowPerModel({ "test-model": 10_000 });
        actions.setConversationMessages([{ role: "user", content: "hi" }]);
        actions.setPromptTokens(5_000);
        actions.setPromptTokensDirty(false);
        const result = getPrettyContextWindowUsage();
        assert.strictEqual(result, "50% of context window");
      });

      it("rounds partial percents to 3 decimal places", () => {
        actions.setModel("test-model");
        actions.setContextWindowPerModel({ "test-model": 10_000 });
        actions.setConversationMessages([{ role: "user", content: "hi" }]);
        actions.setPromptTokens(1_666);
        actions.setPromptTokensDirty(false);
        const result = getPrettyContextWindowUsage();
        assert.strictEqual(result, "16.66% of context window");
      });

      it("returns percents above 100", () => {
        actions.setModel("test-model");
        actions.setContextWindowPerModel({ "test-model": 10_000 });
        actions.setConversationMessages([{ role: "user", content: "hi" }]);
        actions.setPromptTokens(15_000);
        actions.setPromptTokensDirty(false);
        const result = getPrettyContextWindowUsage();
        assert.strictEqual(result, "150% of context window");
      });
    });

    describe("token counts", () => {
      it("uses approximated message tokens when tokens are stale", () => {
        actions.setModel("test-model");
        actions.setContextWindowPerModel({ "test-model": 10_000 });
        actions.setConversationMessages([{ role: "user", content: "hihoho" }]);
        actions.setPromptTokens(5_000);
        actions.setPromptTokensDirty(true);
        const result = getPrettyContextWindowUsage();
        assert.strictEqual(result, "0.12% of context window");
      });

      it("uses the stored token count when tokens are not stale", () => {
        actions.setModel("test-model");
        actions.setContextWindowPerModel({ "test-model": 10_000 });
        actions.setConversationMessages([{ role: "user", content: "hihoho" }]);
        actions.setPromptTokens(5_000);
        actions.setPromptTokensDirty(false);
        const result = getPrettyContextWindowUsage();
        assert.strictEqual(result, "50% of context window");
      });
    });

    it("ignores terminal width", () => {
      mock.method(processDeps.stdout, "getColumns", () => 79);
      actions.setModel("test-model");
      actions.setContextWindowPerModel({ "test-model": 10_000 });
      const result = getPrettyContextWindowUsage();
      assert.strictEqual(result, "0% of context window");
    });
  });

  describe("getUsageMoneyForModel", () => {
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
    });

    it("throws when the model has no pricing configured", () => {
      actions.setPricingPerModel({});
      assert.throws(() =>
        getUsageMoneyForModel(
          {
            inputTokens: 1,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          "gpt-4",
        ),
      );
    });

    it("computes the total cost from all token types", () => {
      const result = getUsageMoneyForModel(
        {
          inputTokens: 900_000,
          outputTokens: 200_000,
          cacheReadTokens: 300_000,
          cacheWriteTokens: 100_000,
        },
        "gpt-4",
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
        "gpt-4",
      );
      assert.strictEqual(result, 0.2);
    });

    it("falls back to the input price when cache pricing is omitted", () => {
      actions.setPricingPerModel({
        "gpt-4": {
          inputPerMillion: 2,
          outputPerMillion: 10,
        },
      });
      const result = getUsageMoneyForModel(
        {
          inputTokens: 2_000_000,
          outputTokens: 0,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 500_000,
        },
        "gpt-4",
      );
      assert.strictEqual(result, 4);
    });
  });

  describe("sumUsageTokens", () => {
    it("returns all zeros for an empty array", () => {
      const result = sumUsageTokens([]);
      assert.deepStrictEqual(result, {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });

    it("sums all token types across multiple entries", () => {
      const result = sumUsageTokens([
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
      ]);
      assert.deepStrictEqual(result, {
        inputTokens: 250,
        outputTokens: 130,
        cacheReadTokens: 30,
        cacheWriteTokens: 15,
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

describe("differ", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe("createToolCallDiffer", () => {
    beforeEach(() => {
      setupTestContext();
    });

    describe("snapshots", () => {
      it("creates and cleans up a tool call snapshot", async () => {
        testFs._files.set("/source/file.txt", "original content");
        const differ = createToolCallDiffer();

        await differ.setTempFileBefore("call-1", "/source/file.txt");

        assert.strictEqual(
          testFs._files.get("/tmp/lasso-test-uuid.txt"),
          "original content",
        );
        assert.strictEqual(
          differ.getTempFileBefore("call-1"),
          "/tmp/lasso-test-uuid.txt",
        );

        await differ.cleanupTempFileBefore("call-1");

        assert.strictEqual(
          testFs._files.has("/tmp/lasso-test-uuid.txt"),
          false,
        );
        assert.strictEqual(
          differ.toolCallIdToTempFileBefore.has("call-1"),
          false,
        );
      });

      it("warns when the before temp file cannot be created", async () => {
        testFs._files.set("/test/file.txt", "original content");
        mock.method(fsDeps, "writeFile", () =>
          Promise.reject(new Error("write failed")),
        );
        const writes = mockStdoutWrites();

        const differ = createToolCallDiffer();
        await differ.setTempFileBefore("call-1", "/test/file.txt");
        await differ.diffAndCleanup("call-1", "/test/file.txt");

        assert.deepStrictEqual(writes(), [
          `${RED}Failed to write a temp file with the content from path /test/file.txt: write failed${RESET}\n`,
          `${RED}Failed to write a temp file with the content from path /test/file.txt: write failed${RESET}\n`,
        ]);
        assert.deepStrictEqual(getState().conversation.toolEditDiffs, []);
      });

      it("registers an empty snapshot when the source file does not exist", async () => {
        const differ = createToolCallDiffer();

        await differ.setTempFileBefore("call-1", "/missing/file.txt");

        assert.equal(testFs._files.get("/tmp/lasso-test-uuid.txt"), "");
        assert.equal(
          differ.toolCallIdToTempFileBefore.get("call-1"),
          "/tmp/lasso-test-uuid.txt",
        );
      });

      it("cleans up an empty snapshot", async () => {
        const differ = createToolCallDiffer();

        await differ.setTempFileBefore("call-1", "/missing/file.txt");
        await differ.cleanupTempFileBefore("call-1");

        assert.equal(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
        assert.equal(differ.toolCallIdToTempFileBefore.has("call-1"), false);
      });

      it("cleans up all empty snapshots", async () => {
        const differ = createToolCallDiffer();

        await differ.setTempFileBefore("call-1", "/missing/a.txt");
        await differ.setTempFileBefore("call-2", "/missing/b.txt");
        await differ.cleanupAllTempFileBefore();

        assert.deepStrictEqual(
          [...differ.toolCallIdToTempFileBefore.keys()],
          [],
        );
        assert.equal(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
      });

      it("cleans up all outstanding tool call snapshots", async () => {
        const differ = createToolCallDiffer();
        await differ.setTempFileBefore("call-1", "/a");
        await differ.setTempFileBefore("call-2", "/b");

        await differ.cleanupAllTempFileBefore();

        assert.strictEqual(
          testFs._files.has("/tmp/lasso-test-uuid.txt"),
          false,
        );
        assert.strictEqual(
          differ.toolCallIdToTempFileBefore.has("call-1"),
          false,
        );
        assert.strictEqual(
          differ.toolCallIdToTempFileBefore.has("call-2"),
          false,
        );
      });
    });

    describe("ignored paths", () => {
      it("does not snapshot ignores-path files", async () => {
        testFs._files.set("/tmp/file.txt", "original content");
        const differ = createToolCallDiffer();

        await differ.setTempFileBefore("call-1", "/tmp/file.txt");

        assert.equal(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
        assert.equal(differ.toolCallIdToTempFileBefore.has("call-1"), false);
      });

      it("does not diff and cleans up the after file for ignored paths", async () => {
        const commands: string[] = [];
        const getWrites = mockStdoutWrites();
        const differ = createToolCallDiffer();
        mockExecCalls([], commands);

        await differ.setTempFileBefore("call-1", "/tmp/file.txt");
        testFs._files.set("/tmp/file.txt", "new content");
        await differ.diffAndCleanup("call-1", "/tmp/file.txt");

        assert.equal(commands.length, 0);
        assert.deepStrictEqual(getWrites(), []);
        assert.deepStrictEqual(getState().conversation.toolEditDiffs, []);
      });
    });

    describe("diffs", () => {
      it("prints and records the diff for a newly-created file", async () => {
        const commands: string[] = [];
        const getWrites = mockStdoutWrites();
        const differ = createToolCallDiffer();
        mockExecCalls(
          [{ stdout: "delta 0.18.2" }, { stdout: "+created content\n" }],
          commands,
        );

        await differ.setTempFileBefore("call-1", "/test/new-file.txt");
        testFs._files.set("/test/new-file.txt", "created content");
        await differ.diffAndCleanup("call-1", "/test/new-file.txt");

        assert.equal(commands.length, 2);
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${GREY}━━ ${BOLD}File change: /test/new-file.txt${BOLD_RESET} ━━${RESET}\n`,
          "+created content\n\n",
        ]);
        assert.deepStrictEqual(getState().conversation.toolEditDiffs, [
          { fileName: "/test/new-file.txt", diffStdout: "+created content\n" },
        ]);
        assert.equal(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
        assert.equal(differ.toolCallIdToTempFileBefore.has("call-1"), false);
      });

      it("suppresses printing, continues recording tool edit diffs", async () => {
        const commands: string[] = [];
        const getWrites = mockStdoutWrites();
        const differ = createToolCallDiffer();
        mockExecCalls(
          [{ stdout: "delta 0.18.2" }, { stdout: "+created content\n" }],
          commands,
        );
        actions.setSuppressToolEditDiffs(true);

        await differ.setTempFileBefore("call-1", "/test/new-file.txt");
        testFs._files.set("/test/new-file.txt", "created content");
        await differ.diffAndCleanup("call-1", "/test/new-file.txt");

        assert.equal(commands.length, 2);
        assert.deepStrictEqual(getWrites(), []);
        assert.deepStrictEqual(getState().conversation.toolEditDiffs, [
          { fileName: "/test/new-file.txt", diffStdout: "+created content\n" },
        ]);
        assert.equal(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
        assert.equal(differ.toolCallIdToTempFileBefore.has("call-1"), false);
      });

      it("diffs a deleted file against an empty after snapshot", async () => {
        testFs._files.set("/source/file.txt", "original content");
        const commands: string[] = [];
        const differ = createToolCallDiffer();
        mockExecCalls(
          [{ stdout: "delta 0.18.2" }, { stdout: "diff output" }],
          commands,
        );

        await differ.setTempFileBefore("call-1", "/source/file.txt");
        await differ.diffAndCleanup("call-1", "/missing/after.txt");

        assert.equal(commands.length, 2);
        assert.deepStrictEqual(getState().conversation.toolEditDiffs, [
          { fileName: "/missing/after.txt", diffStdout: "diff output" },
        ]);
        assert.equal(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
        assert.equal(differ.toolCallIdToTempFileBefore.has("call-1"), false);
      });

      it("diffs and cleans up a successful tool call", async () => {
        testFs._files.set("/test/file.txt", "original content");
        const commands: string[] = [];
        const differ = createToolCallDiffer();
        mockExecCalls(
          [{ stdout: "delta 0.18.2" }, { stdout: "diff output" }],
          commands,
        );

        await differ.setTempFileBefore("call-1", "/test/file.txt");
        await differ.diffAndCleanup("call-1", "/test/file.txt");

        assert.strictEqual(
          commands[1],
          "git diff --no-index --color=always -U3 /tmp/lasso-test-uuid.txt /tmp/lasso-test-uuid.txt | delta --paging=never --line-numbers --hunk-header-style=omit --file-style=omit",
        );
        assert.strictEqual(
          testFs._files.has("/tmp/lasso-test-uuid.txt"),
          false,
        );
        assert.strictEqual(
          differ.toolCallIdToTempFileBefore.has("call-1"),
          false,
        );
        assert.deepStrictEqual(getState().conversation.toolEditDiffs, [
          { fileName: "/test/file.txt", diffStdout: "diff output" },
        ]);
      });

      it("appends the diff to state and does not print an error when the diff command succeeds", async () => {
        testFs._files.set("/test/file.txt", "original content");
        const getWrites = mockStdoutWrites();
        const differ = createToolCallDiffer();
        mockExecCalls([
          { stdout: "delta 0.18.2" },
          { stdout: "+added line\n" },
        ]);

        await differ.setTempFileBefore("call-1", "/test/file.txt");
        await differ.diffAndCleanup("call-1", "/test/file.txt");

        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${GREY}━━ ${BOLD}File change: /test/file.txt${BOLD_RESET} ━━${RESET}\n`,
          "+added line\n\n",
        ]);
      });
    });
  });

  describe("execGitDiff", () => {
    beforeEach(() => {
      setupTestContext();
    });

    describe("uses delta", () => {
      it("uses delta and three context lines by default", async () => {
        const commands: string[] = [];
        mockExecCalls(
          [{ stdout: "delta 0.18.2" }, { stdout: "diff output" }],
          commands,
        );
        const result = await execGitDiff({
          tempFileBeforePath: "a",
          tempFileAfterPath: "b",
        });
        assert.deepStrictEqual(result, { stdout: "diff output", stderr: "" });
        assert.deepStrictEqual(commands, [
          "delta --version",
          "git diff --no-index --color=always -U3 a b | delta --paging=never --line-numbers --hunk-header-style=omit --file-style=omit",
        ]);
      });

      it("includes the filename when requested", async () => {
        const commands: string[] = [];
        mockExecCalls(
          [{ stdout: "delta 0.18.2" }, { stdout: "diff output" }],
          commands,
        );
        await execGitDiff({
          tempFileBeforePath: "a",
          tempFileAfterPath: "b",
          includeFilename: true,
        });
        assert.strictEqual(
          commands[1],
          "git diff --no-index --color=always -U3 a b | delta --paging=never --line-numbers --hunk-header-style=omit --file-style=normal",
        );
      });

      it("resolves when delta exits with code 1 (differences found)", async () => {
        const err = new Error("diff failed") as Error & { code: number };
        err.code = 1;
        mockExecCalls([{ stdout: "delta 0.18.2" }, { stdout: "", error: err }]);
        const result = await execGitDiff({
          tempFileBeforePath: "a",
          tempFileAfterPath: "b",
        });
        assert.deepStrictEqual(result, { stdout: "", stderr: "" });
      });

      it("returns the diff from the error output when delta exits with code 1", async () => {
        const err = Object.assign(new Error("diff failed"), {
          code: 1,
          stdout: "delta diff output",
          stderr: "delta warning",
        });
        mockExecCalls([{ stdout: "delta 0.18.2" }, { stdout: "", error: err }]);
        const result = await execGitDiff({
          tempFileBeforePath: "a",
          tempFileAfterPath: "b",
        });
        assert.deepStrictEqual(result, {
          stdout: "delta diff output",
          stderr: "delta warning",
        });
      });
    });

    describe("plain git diff", () => {
      it("falls back to plain git diff when delta is not available", async () => {
        mockExecCalls([
          { stdout: "", error: new Error("not found") },
          { stdout: "plain diff" },
        ]);
        const result = await execGitDiff({
          tempFileBeforePath: "a",
          tempFileAfterPath: "b",
        });
        assert.deepStrictEqual(result, { stdout: "plain diff", stderr: "" });
      });

      it("resolves when plain git diff exits with code 1 (differences found)", async () => {
        const err = new Error("diff failed") as Error & { code: number };
        err.code = 1;
        mockExecCalls([
          { stdout: "", error: new Error("not found") },
          { stdout: "", error: err },
        ]);
        const result = await execGitDiff({
          tempFileBeforePath: "a",
          tempFileAfterPath: "b",
        });
        assert.deepStrictEqual(result, { stdout: "", stderr: "" });
      });

      it("returns the diff from the error output when plain git diff exits with code 1", async () => {
        const err = Object.assign(new Error("diff failed"), {
          code: 1,
          stdout: "plain diff output",
          stderr: "",
        });
        mockExecCalls([
          { stdout: "", error: new Error("not found") },
          { stdout: "", error: err },
        ]);
        const result = await execGitDiff({
          tempFileBeforePath: "a",
          tempFileAfterPath: "b",
        });
        assert.deepStrictEqual(result, {
          stdout: "plain diff output",
          stderr: "",
        });
      });

      it("resolves on plain git diff error with an unexpected low exit code", async () => {
        const err = new Error("unexpected failure") as Error & {
          code: number;
        };
        err.code = 3;
        mockExecCalls([
          { stdout: "", error: new Error("not found") },
          { stdout: "", error: err },
        ]);
        const result = await execGitDiff({
          tempFileBeforePath: "a",
          tempFileAfterPath: "b",
        });
        assert.deepStrictEqual(result, { stdout: "", stderr: "" });
      });
    });

    describe("rejects on errors", () => {
      it("rejects when plain git diff exits with code 2 (usage error)", async () => {
        const err = new Error("usage error") as Error & { code: number };
        err.code = 2;
        mockExecCalls([
          { stdout: "", error: new Error("not found") },
          { stdout: "", error: err },
        ]);
        await assert.rejects(
          execGitDiff({ tempFileBeforePath: "a", tempFileAfterPath: "b" }),
          /usage error/,
        );
      });

      it("rejects when git is not installed (plain git diff exit code 127)", async () => {
        const err = new Error("git: command not found") as Error & {
          code: number;
        };
        err.code = 127;
        mockExecCalls([
          { stdout: "", error: new Error("not found") },
          { stdout: "", error: err },
        ]);
        await assert.rejects(
          execGitDiff({ tempFileBeforePath: "a", tempFileAfterPath: "b" }),
          /command not found/,
        );
      });

      it("rejects when plain git diff is killed by a signal (141)", async () => {
        const err = new Error("killed") as Error & { code: number };
        err.code = 141;
        mockExecCalls([
          { stdout: "", error: new Error("not found") },
          { stdout: "", error: err },
        ]);
        await assert.rejects(
          execGitDiff({ tempFileBeforePath: "a", tempFileAfterPath: "b" }),
          /killed/,
        );
      });

      it("rejects on fatal plain git diff error", async () => {
        const err = new Error("fatal") as Error & { code: number };
        err.code = 128;
        mockExecCalls([
          { stdout: "", error: new Error("not found") },
          { stdout: "", error: err },
        ]);
        await assert.rejects(
          execGitDiff({ tempFileBeforePath: "a", tempFileAfterPath: "b" }),
          /fatal/,
        );
      });
    });
  });

  describe("diffAndCleanup error and empty output", () => {
    beforeEach(() => {
      setupTestContext();
    });

    it("prints an error and skips appending when the diff command fails", async () => {
      const getWrites = mockStdoutWrites();
      const err = new Error("fatal") as Error & { code: number };
      err.code = 128;
      mockExecCalls([{ stdout: "delta 0.18.2" }, { stdout: "", error: err }]);
      const differ = createToolCallDiffer();
      testFs._files.set("/test/file.txt", "original content");
      await differ.setTempFileBefore("call-1", "/test/file.txt");
      await differ.diffAndCleanup("call-1", "/test/file.txt");
      assert.deepStrictEqual(getWrites(), [
        `${RED}An error occurred when getting the diff for /test/file.txt: fatal${RESET}\n`,
      ]);
      assert.deepStrictEqual(getState().conversation.toolEditDiffs, []);
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
      assert.strictEqual(
        differ.toolCallIdToTempFileBefore.has("call-1"),
        false,
      );
    });

    it("warns when the after temp file cannot be created", async () => {
      const writes = mockStdoutWrites();
      testFs._files.set("/test/file.txt", "original content");
      const differ = createToolCallDiffer();
      await differ.setTempFileBefore("call-1", "/test/file.txt");
      mock.method(fsDeps, "writeFile", () =>
        Promise.reject(new Error("write failed")),
      );

      await differ.diffAndCleanup("call-1", "/test/file.txt");

      assert.deepStrictEqual(writes(), [
        `${RED}Failed to write a temp file with the content from path /test/file.txt: write failed${RESET}\n`,
      ]);
      assert.deepStrictEqual(getState().conversation.toolEditDiffs, []);
    });

    it("does not append or print when the diff stdout is empty", async () => {
      const getWrites = mockStdoutWrites();
      testFs._files.set("/test/file.txt", "original content");
      mockExecCalls([{ stdout: "delta 0.18.2" }, { stdout: "" }]);
      const differ = createToolCallDiffer();
      await differ.setTempFileBefore("call-1", "/test/file.txt");
      await differ.diffAndCleanup("call-1", "/test/file.txt");
      assert.deepStrictEqual(getWrites(), []);
      assert.deepStrictEqual(getState().conversation.toolEditDiffs, []);
    });
  });
});

describe("model", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext({ model: "claude-sonnet-4-20250514" });
    actions.setBaseURL("https://api.anthropic.com");
  });

  describe("getLanguageModel", () => {
    it("creates an Anthropic language model", () => {
      const model = getLanguageModel();
      assert.deepStrictEqual(
        { modelId: model.modelId, provider: model.provider },
        { modelId: "claude-sonnet-4-20250514", provider: "anthropic.messages" },
      );
    });

    it("creates an OpenAI-compatible language model", () => {
      actions.setSdkProvider("openai-compatible");
      const model = getLanguageModel();
      assert.deepStrictEqual(
        { modelId: model.modelId, provider: model.provider },
        {
          modelId: "claude-sonnet-4-20250514",
          provider: "openai-compatible.chat",
        },
      );
    });

    it("creates an OpenAI language model", () => {
      actions.setSdkProvider("openai");
      const model = getLanguageModel();
      assert.deepStrictEqual(
        { modelId: model.modelId, provider: model.provider },
        { modelId: "claude-sonnet-4-20250514", provider: "openai.responses" },
      );
    });

    it("creates a Google language model", () => {
      actions.setSdkProvider("google");
      const model = getLanguageModel();
      assert.deepStrictEqual(
        { modelId: model.modelId, provider: model.provider },
        {
          modelId: "claude-sonnet-4-20250514",
          provider: "google.generative-ai",
        },
      );
    });
  });

  describe("getTranscriptionProvider", () => {
    beforeEach(() => {
      testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "test-key");
    });

    it("creates an OpenAI transcription model", () => {
      actions.setTranscriptionSdkProvider("openai");
      const model =
        getTranscriptionProvider().transcription("gpt-4o-transcribe");
      assert.equal(model.provider, "openai.transcription");
    });

    it("creates a Google transcription model", () => {
      actions.setTranscriptionSdkProvider("google");
      const model =
        getTranscriptionProvider().transcription("gemini-2.0-flash");
      assert.equal(model.provider, "google.generative-ai.transcription");
    });
  });

  describe("getHeaders", () => {
    it("returns no headers when gateway is not opencode", () => {
      assert.deepStrictEqual(getHeaders(), {});
    });

    it("returns session and client headers when gateway is opencode", () => {
      actions.setGateway("opencode");
      assert.deepStrictEqual(getHeaders(), {
        "x-opencode-session": "test-uuid",
        "x-opencode-client": "lasso",
      });
    });
  });
});

describe("log", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  describe("initSessionFile", () => {
    beforeEach(() => {
      mock.restoreAll();
      setupTestContext({ now: 1_234_567_890_000 });
    });

    it("sets the path without creating the directory or file", () => {
      initSessionFile();
      assert.equal(
        getState().session.sessionFilePath,
        "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
      );
      assert.equal(
        testFs._dirs.has("/fake-home/.local/state/lasso/sessions"),
        false,
      );
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
        ),
        false,
      );
    });

    it("creates the session file on the first sync", async () => {
      initSessionFile();
      await syncSessionFile({ messages: [], summaries: [], transcript: [] });
      assert.equal(
        testFs._files.get(
          "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
        ),
        '{"messages":[],"summaries":[],"transcript":[]}',
      );
    });
  });

  describe("deleteExpiredSessionFiles", () => {
    beforeEach(() => {
      mock.restoreAll();
      setupTestContext({ now: 1_000_000_000_000 });
    });

    it("returns early when directory does not exist", async () => {
      await deleteExpiredSessionFiles();
      assert.equal(
        testFs._dirs.has("/fake-home/.local/state/lasso/sessions"),
        false,
      );
    });

    it("deletes expired files older than 24 hours", async () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
      testFs._files.set(
        "/fake-home/.local/state/lasso/sessions/session-999900000000.json",
        "old",
      );
      await deleteExpiredSessionFiles();
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/sessions/session-999900000000.json",
        ),
        false,
      );
    });

    it("keeps files newer than 24 hours", async () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
      testFs._files.set(
        "/fake-home/.local/state/lasso/sessions/session-999990000000.json",
        "new",
      );
      await deleteExpiredSessionFiles();
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/sessions/session-999990000000.json",
        ),
        true,
      );
    });

    it("skips files without correct format", async () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
      testFs._files.set(
        "/fake-home/.local/state/lasso/sessions/random-file.log",
        "",
      );
      testFs._files.set(
        "/fake-home/.local/state/lasso/sessions/other-uuid-123-notimestamp.log",
        "",
      );
      testFs._files.set(
        "/fake-home/.local/state/lasso/sessions/prompt-history-uuid-999990000001.log",
        "",
      );
      await deleteExpiredSessionFiles();
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/sessions/random-file.log",
        ),
        true,
      );
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/sessions/other-uuid-123-notimestamp.log",
        ),
        true,
      );
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/sessions/prompt-history-uuid-999990000001.log",
        ),
        true,
      );
    });

    it("skips session files with 3 parts", async () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
      testFs._files.set(
        "/fake-home/.local/state/lasso/sessions/session-uuid-999997600000.json",
        "",
      );
      await deleteExpiredSessionFiles();
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/sessions/session-uuid-999997600000.json",
        ),
        true,
      );
    });
  });

  describe("syncSessionFile", () => {
    beforeEach(() => {
      mock.restoreAll();
      setupTestContext({ now: 1_234_567_890_000 });
      actions.setSessionFilePath(
        "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
      );
    });

    it("writes the current state to the session file", async () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
      actions.setConversationMessages([{ role: "user", content: "hello" }]);
      actions.setTranscript([
        {
          timestamp: 0,
          role: "user",
          message: "hi",
        },
      ]);

      await syncSessionFile();

      assert.equal(
        testFs._files.get(
          "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
        ),
        '{"messages":[{"role":"user","content":"hello"}],"summaries":[],"transcript":[{"timestamp":0,"role":"user","message":"hi"}]}',
      );
    });

    it("replaces the provided fields and updates state", async () => {
      actions.setConversationMessages([{ role: "user", content: "old" }]);
      await syncSessionFile({
        messages: [{ role: "assistant", content: "reply" }],
      });

      assert.equal(
        testFs._files.get(
          "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
        ),
        '{"messages":[{"role":"assistant","content":"reply"}],"summaries":[],"transcript":[]}',
      );
      assert.deepStrictEqual(getState().conversation.summaries, []);
      assert.deepStrictEqual(getState().conversation.messages, [
        { role: "assistant", content: "reply" },
      ]);
    });

    it("prints the error and does not write when the session directory cannot be checked", async () => {
      mock.method(fsDeps, "existsSync", () => {
        throw makeErrnoError("EACCES");
      });
      const writes = mockStdoutWrites();

      await syncSessionFile();

      assert.deepStrictEqual(writes(), [
        `${RED}Failed to check if /fake-home/.local/state/lasso/sessions exists. Error: EACCES${RESET}\n`,
      ]);
      assert.strictEqual(
        testFs._files.has(
          "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
        ),
        false,
      );
    });

    it("creates the directory when it does not exist", async () => {
      await syncSessionFile();
      assert.equal(
        testFs._dirs.has("/fake-home/.local/state/lasso/sessions"),
        true,
      );
    });

    it("warns and updates state when writing fails", async () => {
      mock.method(fsDeps, "writeFile", () =>
        Promise.reject(new Error("Permission denied")),
      );
      const getWrites = mockStdoutWrites();

      await syncSessionFile();

      assert.deepStrictEqual(getWrites(), [
        `${RED}Failed to write the session file to /fake-home/.local/state/lasso/sessions/session-1234567890000.json${RESET}\n`,
      ]);
      assert.deepStrictEqual(getState().conversation.messages, []);
    });

    it("warns and updates state when stringifying fails", async () => {
      const circularContent: { self?: unknown } = {};
      circularContent.self = circularContent;

      const getWrites = mockStdoutWrites();
      await syncSessionFile({
        messages: [{ role: "user", content: circularContent }],
      });

      assert.deepStrictEqual(getWrites(), [
        `${RED}Failed to stringify the session file${RESET}\n`,
      ]);
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
        ),
        false,
      );
      assert.deepStrictEqual(getState().conversation.messages, [
        { role: "user", content: circularContent },
      ]);
    });
  });

  describe("resumeFromSessionFile", () => {
    beforeEach(() => {
      mock.restoreAll();
      setupTestContext({ now: 1_234_567_890_000 });
    });

    it("loads messages, summaries, and transcript into state and returns true", async () => {
      actions.setConversationMessages([{ role: "user", content: "old" }]);
      testFs._files.set(
        "/test/session.json",
        JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          summaries: [{ compacted: "summary", compactedAt: 123, tokens: 456 }],
          transcript: [{ timestamp: 0, role: "user", message: "hello" }],
        }),
      );

      actions.setPromptTokens(100);

      const result = await resumeFromSessionFile("/test/session.json");

      assert.equal(result, true);
      assert.deepStrictEqual(getState().conversation.summaries, [
        { compacted: "summary", compactedAt: 123, tokens: 456 },
      ]);
      assert.deepStrictEqual(getState().conversation.messages, [
        { role: "user", content: "hello" },
      ]);
      assert.deepStrictEqual(getState().conversation.transcript, [
        { timestamp: 0, role: "user", message: "hello" },
      ]);
      assert.deepStrictEqual(getState().usage.promptTokens, {
        value: 100,
        dirty: true,
      });
    });

    it("prints an error and returns false when the session file cannot be read", async () => {
      const getWrites = mockStdoutWrites();

      const result = await resumeFromSessionFile("/test/missing.json");

      assert.equal(result, false);
      assert.deepStrictEqual(getWrites(), [
        `${RED}Failed to read the session file at /test/missing.json${RESET}\n`,
        "\n",
      ]);
    });

    it("prints an error and returns false when the session file is not valid json", async () => {
      testFs._files.set("/test/broken.json", "not json");
      const getWrites = mockStdoutWrites();

      const result = await resumeFromSessionFile("/test/broken.json");

      assert.equal(result, false);
      assert.deepStrictEqual(getWrites(), [
        `${RED}Failed to parse the session file at /test/broken.json${RESET}\n`,
        "\n",
      ]);
    });

    it("prints an error and returns false when the session file fails validation", async () => {
      testFs._files.set("/test/invalid.json", "{}");
      const getWrites = mockStdoutWrites();

      const result = await resumeFromSessionFile("/test/invalid.json");

      assert.equal(result, false);
      assert.deepStrictEqual(getWrites(), [
        `${RED}Failed to validate the session file at /test/invalid.json${RESET}\n`,
        "\n",
      ]);
    });
  });
});

describe("mcp", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  it("sets clients and tools", () => {
    const firstClient = makeFakeMcpClient();
    const secondClient = makeFakeMcpClient();
    const clients = { first: firstClient, second: secondClient };
    const tools = makeFakeMcpToolSet({});

    setMcpClients({ clients, tools });

    assert.strictEqual(getState().mcp.clients, clients);
    assert.strictEqual(getState().mcp.tools, tools);
  });

  describe("executeMcpListResourcesTool", () => {
    it("returns the resources of the given server", async () => {
      setMcpClients({
        clients: {
          first: makeFakeMcpClient({
            listResources: () =>
              Promise.resolve({
                resources: [
                  {
                    uri: "file:///a.txt",
                    name: "a",
                    description: "File a",
                    mimeType: "text/plain",
                  },
                ],
                nextCursor: "cursor-2",
              }),
          }),
        },
      });

      const result = await executeMcpListResourcesTool({ server: "first" });

      assert.deepStrictEqual(result, {
        isError: false,
        content: stringify({
          resources: [
            {
              uri: "file:///a.txt",
              name: "a",
              description: "File a",
              mimeType: "text/plain",
            },
          ],
          nextCursor: "cursor-2",
        }),
      });
    });

    it("passes the cursor to the client and returns no next cursor", async () => {
      let capturedCursor: string | undefined;
      const listResources = mock.fn(
        (options?: { params?: { cursor: string } }) => {
          capturedCursor = options?.params?.cursor;
          return Promise.resolve({ resources: [{ uri: "file:///a.txt" }] });
        },
      );
      setMcpClients({
        clients: { first: makeFakeMcpClient({ listResources }) },
      });

      const result = await executeMcpListResourcesTool({
        server: "first",
        cursor: "cursor-1",
      });

      assert.strictEqual(capturedCursor, "cursor-1");
      assert.deepStrictEqual(result, {
        isError: false,
        content: stringify({
          resources: [{ uri: "file:///a.txt" }],
          nextCursor: null,
        }),
      });
    });

    it("returns an error for an unknown server", async () => {
      const result = await executeMcpListResourcesTool({ server: "missing" });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "Unknown mcp server: missing",
      });
    });

    it("returns isError when listing fails", async () => {
      setMcpClients({
        clients: {
          first: makeFakeMcpClient({
            listResources: () => Promise.reject(new Error("boom")),
          }),
        },
      });

      const result = await executeMcpListResourcesTool({ server: "first" });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "boom",
      });
    });
  });

  describe("executeMcpReadResourceTool", () => {
    it("returns the text contents of the given resource", async () => {
      setMcpClients({
        clients: {
          first: makeFakeMcpClient({
            readResource: ({ uri }: { uri: string }) =>
              Promise.resolve({
                contents: [
                  { uri, mimeType: "text/plain", text: "resource text" },
                ],
              }),
          }),
        },
      });

      const result = await executeMcpReadResourceTool({
        server: "first",
        uri: "file:///a.txt",
      });

      assert.deepStrictEqual(result, {
        isError: false,
        content: stringify([
          {
            uri: "file:///a.txt",
            mimeType: "text/plain",
            text: "resource text",
            blob: null,
          },
        ]),
      });
    });

    it("returns blob contents as base64", async () => {
      setMcpClients({
        clients: {
          first: makeFakeMcpClient({
            readResource: () =>
              Promise.resolve({
                contents: [{ uri: "file:///a.png", blob: "aGVsbG8=" }],
              }),
          }),
        },
      });

      const result = await executeMcpReadResourceTool({
        server: "first",
        uri: "file:///a.png",
      });

      assert.deepStrictEqual(result, {
        isError: false,
        content: stringify([
          {
            uri: "file:///a.png",
            mimeType: null,
            text: null,
            blob: "aGVsbG8=",
          },
        ]),
      });
    });

    it("returns an error for an unknown server", async () => {
      const result = await executeMcpReadResourceTool({
        server: "missing",
        uri: "file:///a.txt",
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "Unknown mcp server: missing",
      });
    });

    it("returns isError when reading fails", async () => {
      setMcpClients({
        clients: {
          first: makeFakeMcpClient({
            readResource: () => Promise.reject(new Error("boom")),
          }),
        },
      });

      const result = await executeMcpReadResourceTool({
        server: "first",
        uri: "file:///a.txt",
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "boom",
      });
    });
  });

  describe("initMcpState", () => {
    it("closes existing clients and resets MCP state", async () => {
      const closeFirst = mock.fn(() => undefined);
      const closeSecond = mock.fn(() => undefined);
      const firstClient = makeFakeMcpClient({ close: closeFirst });
      const secondClient = makeFakeMcpClient({ close: closeSecond });
      setMcpClients({ clients: { first: firstClient, second: secondClient } });

      const performanceLogger = makeStartupPerformanceLogger();
      await initMcpState({ performanceLogger });

      assert.equal(closeFirst.mock.callCount(), 1);
      assert.equal(closeSecond.mock.callCount(), 1);
      assert.deepStrictEqual(getState().mcp.clients, {});
      assert.deepStrictEqual(getState().mcp.tools, {});
    });

    it("ignores MCP clients that fail during initialization", async () => {
      mockMcpClients(new Error("connection refused"));
      setMcps("first", "second");

      const performanceLogger = makeStartupPerformanceLogger();
      await initMcpState({ performanceLogger });

      assert.deepStrictEqual(getState().mcp.clients, {});
      assert.deepStrictEqual(getState().mcp.tools, {});
    });

    it("keeps all clients when one client's tools() call fails", async () => {
      const closeFirst = mock.fn(() => undefined);
      const closeSecond = mock.fn(() => undefined);
      const firstClient = makeFakeMcpClient({
        tools: () => Promise.reject(new Error("boom")),
        close: closeFirst,
      });
      const secondClient = makeFakeMcpClient({ close: closeSecond });
      mockMcpClients(firstClient, secondClient);
      setMcps("first", "second");

      const performanceLogger = makeStartupPerformanceLogger();
      await initMcpState({ performanceLogger });

      assert.deepStrictEqual(getState().mcp.clients, {
        first: firstClient,
        second: secondClient,
      });
      assert.deepStrictEqual(getState().mcp.tools, {});
      await getState().mcp.close();
      assert.equal(closeFirst.mock.callCount(), 1);
      assert.equal(closeSecond.mock.callCount(), 1);
    });

    it("keeps the tools of clients whose tools() call succeeds", async () => {
      const tools = makeFakeMcpToolSet({
        greet: { description: "says hello" },
      });
      const firstClient = makeFakeMcpClient({
        tools: () => Promise.reject(new Error("boom")),
      });
      const secondClient = makeFakeMcpClient({
        tools: () => Promise.resolve(tools),
      });
      mockMcpClients(firstClient, secondClient);
      setMcps("first", "second");

      const performanceLogger = makeStartupPerformanceLogger();
      await initMcpState({ performanceLogger });

      assert.deepStrictEqual(getState().mcp.tools, {
        greet: { description: "says hello" },
      });
    });
  });

  describe("startup printing", () => {
    it("records a warning when a client fails to start", async () => {
      mockMcpClients(new Error("connection refused"));
      setMcps("first");

      const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });
      const performanceLogger = makeStartupPerformanceLogger();
      performanceLogger.printAllLabels();
      await initMcpState({ performanceLogger });

      assert.deepStrictEqual(getWrites(), [
        `${BLUE}Starting first mcp server: ${RESET}\n`,
        `${UP_1}${CLEAR_LINE}${CR}`,
        `${BLUE}Starting first mcp server: ${RESET}`,
        `${GREEN}0.0ms${RESET}`,
        `${DOWN_1}${CR}`,
      ]);
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "Failed to start the first mcp server, ignoring. Error: connection refused",
      ]);
    });

    it("records a warning for every server that fails to start", async () => {
      mockMcpClients(new Error("first error"), new Error("second error"));
      setMcps("first", "second");

      const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });
      const performanceLogger = makeStartupPerformanceLogger();
      performanceLogger.printAllLabels();
      await initMcpState({ performanceLogger });

      assert.deepStrictEqual(getWrites(), [
        `${BLUE}Starting first mcp server: ${RESET}\n`,
        `${BLUE}Starting second mcp server: ${RESET}\n`,
        `${UP_2}${CLEAR_LINE}${CR}`,
        `${BLUE}Starting first mcp server: ${RESET}`,
        `${GREEN}0.0ms${RESET}`,
        `${DOWN_2}${CR}`,
        `${UP_1}${CLEAR_LINE}${CR}`,
        `${BLUE}Starting second mcp server: ${RESET}`,
        `${GREEN}0.0ms${RESET}`,
        `${DOWN_1}${CR}`,
      ]);
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "Failed to start the first mcp server, ignoring. Error: first error",
        "Failed to start the second mcp server, ignoring. Error: second error",
      ]);
    });

    it("prints the mcp server start duration when suppressStartupDurations is false", async () => {
      mockMcpClients(makeFakeMcpClient());
      setMcps("first");

      const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });
      const performanceLogger = makeStartupPerformanceLogger();
      performanceLogger.printAllLabels();
      await initMcpState({ performanceLogger });

      assert.deepStrictEqual(getWrites(), [
        `${BLUE}Starting first mcp server: ${RESET}\n`,
        `${UP_1}${CLEAR_LINE}${CR}`,
        `${BLUE}Starting first mcp server: ${RESET}`,
        `${GREEN}0.0ms${RESET}`,
        `${DOWN_1}${CR}`,
      ]);
    });

    it("hides the mcp server start duration when suppressStartupDurations is true", async () => {
      mockMcpClients(makeFakeMcpClient());
      actions.setSuppressStartupDurations(true);
      setMcps("first");

      const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });
      const performanceLogger = makeStartupPerformanceLogger();
      await initMcpState({ performanceLogger });

      assert.deepStrictEqual(getWrites(), []);
    });

    it("prints an error when a client's tools() call fails", async () => {
      mockMcpClients(
        makeFakeMcpClient({ tools: () => Promise.reject(new Error("boom")) }),
      );
      setMcps("first");

      const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });
      const performanceLogger = makeStartupPerformanceLogger();
      performanceLogger.printAllLabels();
      await initMcpState({ performanceLogger });

      assert.deepStrictEqual(getWrites(), [
        `${BLUE}Starting first mcp server: ${RESET}\n`,
        `${UP_1}${CLEAR_LINE}${CR}`,
        `${BLUE}Starting first mcp server: ${RESET}`,
        `${GREEN}0.0ms${RESET}`,
        `${DOWN_1}${CR}`,
      ]);
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "Failed to import the tools for the `first` mcp server, ignoring. Error: boom",
      ]);
    });
  });
});

describe("terminal", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  describe("openWithPager", () => {
    beforeEach(() => {
      setupTestContext();
    });

    let spawned: string[];
    let unlinked: string[];

    beforeEach(() => {
      const pager = mockPagerSpawn();
      spawned = pager.spawned;
      unlinked = pager.unlinked;
      actions.setBatAvailable(true);
    });

    describe("selects the pager", () => {
      it("ignores per-view pager env vars in favor of LASSO_PAGER", async () => {
        testProcessEnv._set("LASSO_PAGER_HISTORY", "nano __FILE__");
        testProcessEnv._set("LASSO_PAGER", "bat __FILE__");
        await openWithPager({
          initialContentStr: "",
          contentType: "markdown",
        });
        assert.strictEqual(spawned[0], "bat /tmp/lasso-test-uuid.txt");
      });

      it("falls back to LASSO_PAGER env var", async () => {
        testProcessEnv._set("LASSO_PAGER", "bat __FILE__");
        await openWithPager({
          initialContentStr: "",
          contentType: "markdown",
        });
        assert.strictEqual(spawned[0], "bat /tmp/lasso-test-uuid.txt");
      });

      it("falls back to PAGER env var with quoted temp file", async () => {
        testProcessEnv._set("PAGER", "more");
        await openWithPager({
          initialContentStr: "",
          contentType: "markdown",
        });
        assert.strictEqual(spawned[0], `more '/tmp/lasso-test-uuid.txt'`);
      });

      it("falls back to bat", async () => {
        await openWithPager({
          initialContentStr: "",
          contentType: "markdown",
        });
        assert.strictEqual(spawned[0], batPagerCmd("/tmp/lasso-test-uuid.txt"));
      });

      it("falls back to less when bat is unavailable", async () => {
        actions.setBatAvailable(false);
        await openWithPager({
          initialContentStr: "",
          contentType: "markdown",
        });
        assert.strictEqual(spawned[0], `less '/tmp/lasso-test-uuid.txt'`);
      });
    });

    describe("spawns the pager", () => {
      it("uses base bat flags without markdown flags for diff contentType", async () => {
        await openWithPager({
          initialContentStr: "",
          contentType: "diff",
        });
        assert.strictEqual(
          spawned[0],
          batPagerCmd("/tmp/lasso-test-uuid.txt", "diff"),
        );
      });

      it("spawns pager with shell and inherit stdio", async () => {
        let spawnArgs: unknown[] = [];
        mock.method(childProcessDeps, "spawnSync", (...args: unknown[]) => {
          spawnArgs = args;
        });
        await openWithPager({
          initialContentStr: "",
          contentType: "markdown",
        });
        assert.deepStrictEqual(spawnArgs, [
          batPagerCmd("/tmp/lasso-test-uuid.txt"),
          { shell: true, stdio: "inherit" },
        ]);
      });

      it("writes initialContentStr into the temp file", async () => {
        await openWithPager({
          initialContentStr: "string content",
          contentType: "markdown",
        });
        assert.strictEqual(
          testFs._files.get("/tmp/lasso-test-uuid.txt"),
          "string content\n\n",
        );
      });

      it("trims trailing newlines before appending exactly two", async () => {
        await openWithPager({
          initialContentStr: "content\n\n\n\n",
          contentType: "markdown",
        });
        assert.strictEqual(
          testFs._files.get("/tmp/lasso-test-uuid.txt"),
          "content\n\n",
        );
      });

      it("deletes the temp file after the pager exits", async () => {
        await openWithPager({
          initialContentStr: "content",
          contentType: "markdown",
        });
        assert.deepStrictEqual(unlinked, ["/tmp/lasso-test-uuid.txt"]);
      });

      it("does not spawn a pager when the temp file cannot be created", async () => {
        mock.method(fsDeps, "writeFile", () =>
          Promise.reject(new Error("write failed")),
        );
        const writes = mockStdoutWrites();

        await openWithPager({
          initialContentStr: "content",
          contentType: "markdown",
        });

        assert.deepStrictEqual(spawned, []);
        assert.deepStrictEqual(writes(), [
          `${RED}Failed to write to a temp file. Error: write failed${RESET}\n`,
        ]);
      });
    });
  });

  describe("formatMarkdown", () => {
    it("formats markdown tables with aligned columns", async () => {
      const unaligned = `|a|b|
|-|-|
|x|y|`;
      const result = await formatMarkdown(unaligned);
      assert.strictEqual(
        result,
        `| a   | b   |
| --- | --- |
| x   | y   |
`,
      );
    });

    it("returns original content and warns when formatting fails", async () => {
      const getWrites = mockStdoutWrites();
      const invalid = makeInvalidString();
      const result = await formatMarkdown(invalid);
      assert.equal(result, invalid);
      assert.deepStrictEqual(getWrites(), [
        `${RED}Outputting raw content, markdown formatting failed: Cannot read properties of null (reading 'length')${RESET}\n`,
      ]);
    });
  });

  describe("executeBat", () => {
    beforeEach(() => {
      mock.restoreAll();
      actions.resetState();
      actions.setModel("test-model");
    });

    describe("uses the bat output", () => {
      it("formats markdown and outputs the content through bat when available", async () => {
        actions.setBatAvailable(true);
        mockSpawnSync({ echoInput: true });

        const getWrites = mockStdoutWrites();

        await executeBat("# Hello\n");

        assert.deepStrictEqual(getWrites(), ["# Hello\n\n"]);
      });

      it("prints bat stdout when status is null", async () => {
        actions.setBatAvailable(true);
        mockSpawnSync({
          result: { status: null, stdout: "bat-rendered\n", stderr: "" },
        });

        const getWrites = mockStdoutWrites();

        await executeBat("test content\n");

        assert.deepStrictEqual(getWrites(), ["bat-rendered\n\n"]);
      });

      it("prints bat stdout when stderr is empty", async () => {
        actions.setBatAvailable(true);
        mockSpawnSync({
          result: { status: 0, stdout: "bat-rendered\n", stderr: "" },
        });

        const getWrites = mockStdoutWrites();

        await executeBat("test content\n");

        assert.deepStrictEqual(getWrites(), ["bat-rendered\n\n"]);
      });
    });

    describe("falls back to plain text", () => {
      it("falls back to plain text when bat is not available", async () => {
        actions.setBatAvailable(false);

        const getWrites = mockStdoutWrites();

        await executeBat("test content\n");

        assert.deepStrictEqual(getWrites(), ["test content\n\n"]);
      });

      it("falls back to plain text when bat spawn fails", async () => {
        actions.setBatAvailable(true);
        mockSpawnSync({ error: new Error("spawn failed") });

        const getWrites = mockStdoutWrites();

        await executeBat("test content\n");

        assert.deepStrictEqual(getWrites(), [
          `${RED}Falling back to plain text rendering, an error occurred when spawning \`bat\`: spawn failed${RESET}\n`,
          "test content\n\n",
        ]);
      });

      it("falls back to plain text when bat exits with non-zero status", async () => {
        actions.setBatAvailable(true);
        mockSpawnSync({
          result: { status: 1, stdout: "bat-rendered\n", stderr: "bat error" },
        });

        const getWrites = mockStdoutWrites();

        await executeBat("test content\n");

        assert.deepStrictEqual(getWrites(), [
          `${RED}Falling back to plain text rendering, an error occurred when spawning \`bat\`: \`bat\` returned code 1${RESET}\n`,
          "test content\n\n",
        ]);
      });

      it("falls back to plain text when bat writes stderr", async () => {
        actions.setBatAvailable(true);
        mockSpawnSync({
          result: {
            status: 0,
            stdout: "bat-rendered\n",
            stderr: "bat warning",
          },
        });

        const getWrites = mockStdoutWrites();

        await executeBat("test content\n");

        assert.deepStrictEqual(getWrites(), [
          `${RED}Falling back to plain text rendering, an error occurred when spawning \`bat\`: bat warning${RESET}\n`,
          "test content\n\n",
        ]);
      });
    });
  });
});

describe("getAvailableSlashCommands", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  describe("returns an empty array", () => {
    it("returns empty array when no commands found", async () => {
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, []);
    });

    it("returns empty array when glob throws", async () => {
      mock.method(fsDeps, "glob", () =>
        Promise.reject(new Error("permission denied")),
      );
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, []);
    });

    it("returns empty array when glob returns empty", async () => {
      testFs._globResults.set("/test-cwd/.lasso/commands/**/*.md", []);
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, []);
    });
  });

  describe("returns commands", () => {
    it("includes custom slash command dirs", async () => {
      actions.setCustomSlashCommandDirs(["/custom-commands"]);
      testFs._globResults.set("/custom-commands/**/*.md", [
        "/custom-commands/foo.md",
      ]);
      testFs._files.set("/custom-commands/foo.md", "custom content");
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, [
        {
          name: "foo",
          filePath: "/custom-commands/foo.md",
          content: "custom content",
        },
      ]);
    });

    it("returns commands from local and global dirs", async () => {
      testFs._globResults.set("/test-cwd/.lasso/commands/**/*.md", [
        "/test-cwd/.lasso/commands/help.md",
      ]);
      testFs._globResults.set("/fake-home/.config/lasso/commands/**/*.md", [
        "/fake-home/.config/lasso/commands/status.md",
      ]);
      testFs._files.set("/test-cwd/.lasso/commands/help.md", "help content");
      testFs._files.set(
        "/fake-home/.config/lasso/commands/status.md",
        "status content",
      );
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, [
        {
          name: "help",
          filePath: "/test-cwd/.lasso/commands/help.md",
          content: "help content",
        },
        {
          name: "status",
          filePath: "/fake-home/.config/lasso/commands/status.md",
          content: "status content",
        },
      ]);
    });

    it("deduplicates by name keeping first occurrence", async () => {
      testFs._globResults.set("/test-cwd/.lasso/commands/**/*.md", [
        "/test-cwd/.lasso/commands/help.md",
      ]);
      testFs._globResults.set("/fake-home/.config/lasso/commands/**/*.md", [
        "/fake-home/.config/lasso/commands/help.md",
      ]);
      testFs._files.set("/test-cwd/.lasso/commands/help.md", "local content");
      testFs._files.set(
        "/fake-home/.config/lasso/commands/help.md",
        "global content",
      );
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, [
        {
          name: "help",
          filePath: "/test-cwd/.lasso/commands/help.md",
          content: "local content",
        },
      ]);
    });
  });

  describe("handles errors", () => {
    it("skips files that fail to read", async () => {
      mock.method(fsDeps, "readFile", (path: string) =>
        path.includes("bad")
          ? Promise.reject(new Error("read failed"))
          : Promise.resolve(Buffer.from("content").toString()),
      );
      testFs._globResults.set("/test-cwd/.lasso/commands/**/*.md", [
        "/test-cwd/.lasso/commands/good.md",
        "/test-cwd/.lasso/commands/bad.md",
      ]);
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, [
        {
          name: "good",
          filePath: "/test-cwd/.lasso/commands/good.md",
          content: "content",
        },
      ]);
    });

    it("warns when glob fails", async () => {
      mock.method(fsDeps, "glob", () =>
        Promise.reject(new Error("permission denied")),
      );
      const getWrites = mockStdoutWrites();

      const result = await getAvailableSlashCommands();

      assert.deepStrictEqual(result, []);
      assert.deepStrictEqual(getWrites(), []);
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "Failed to list the slash command files in `/test-cwd/.lasso/commands`, ignoring. Error: permission denied",
        "Failed to list the slash command files in `/fake-home/.config/lasso/commands`, ignoring. Error: permission denied",
      ]);
    });

    it("warns when a slash command file cannot be read", async () => {
      mock.method(fsDeps, "readFile", (path: string) =>
        path.includes("bad")
          ? Promise.reject(new Error("read failed"))
          : Promise.resolve(Buffer.from("content").toString()),
      );
      testFs._globResults.set("/test-cwd/.lasso/commands/**/*.md", [
        "/test-cwd/.lasso/commands/bad.md",
      ]);
      const getWrites = mockStdoutWrites();

      const result = await getAvailableSlashCommands();

      assert.deepStrictEqual(result, []);
      assert.deepStrictEqual(getWrites(), []);
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "Failed to read the slash command file at `/test-cwd/.lasso/commands/bad.md`, ignoring. Error: read failed",
      ]);
    });
  });
});

describe("getCustomSlashCommandsStr", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  it("normalizes CRLF and strips trailing newlines from content", () => {
    actions.setSlashCommands([
      {
        name: "deploy",
        filePath: "/test-cwd/.lasso/commands/deploy.md",
        content: "line one\r\nline two\r\n\r\n",
      },
    ]);
    assert.strictEqual(
      getCustomSlashCommandsStr(),
      `# [lasso] Slash commands:

## /test-cwd/.lasso/commands/deploy.md

line one\r\nline two`,
    );
  });
});

describe("tools", () => {
  beforeEach(() => {
    setupTestContext();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe("bashToolInputSchema", () => {
    it("produces a regular object schema", () => {
      const jsonSchema = z.toJSONSchema(bashToolInputSchema);
      assert.strictEqual(jsonSchema.type, "object");
    });

    it("accepts read commands without a file path", () => {
      const result = bashToolInputSchema.parse({
        fileSystemAccessType: "read",
        command: "cat file.txt",
      });
      assert.deepStrictEqual(result, {
        fileSystemAccessType: "read",
        command: "cat file.txt",
      });
    });

    it("requires a file path for create-update-delete commands", () => {
      assert.throws(
        () =>
          bashToolInputSchema.parse({
            fileSystemAccessType: "create-update-delete",
            command: "write file.txt",
          }),
        /filePath is required when fileSystemAccessType is create-update-delete/,
      );
    });

    it("accepts create-update-delete commands with a file path", () => {
      const result = bashToolInputSchema.parse({
        fileSystemAccessType: "create-update-delete",
        filePath: "file.txt",
        command: "write file.txt",
      });
      assert.deepStrictEqual(result, {
        fileSystemAccessType: "create-update-delete",
        filePath: "file.txt",
        command: "write file.txt",
      });
    });
  });

  describe("toolPrint", () => {
    describe("prints the detail", () => {
      it("prints the detail with a labeled prefix on the first line", () => {
        mock.method(processDeps.stdout, "getColumns", () => 30);
        const getWrites = mockStdoutWrites();
        toolPrint("bash", "hello");
        assert.deepStrictEqual(getWrites(), [
          `${BLUE}${BOLD}bash${BOLD_RESET}: hello${RESET}
`,
        ]);
      });

      it("ignores empty detail lines", () => {
        mock.method(processDeps.stdout, "getColumns", () => 30);
        const getWrites = mockStdoutWrites();
        toolPrint("bash", "one\n\ntwo");
        assert.deepStrictEqual(getWrites(), [
          `${BLUE}${BOLD}bash${BOLD_RESET}: one
       ┊two${RESET}
`,
        ]);
      });

      it("does not wrap a detail that fits within the cap", () => {
        mock.method(processDeps.stdout, "getColumns", () => 30);
        const getWrites = mockStdoutWrites();
        toolPrint("bash", "abcd");
        assert.deepStrictEqual(getWrites(), [
          `${BLUE}${BOLD}bash${BOLD_RESET}: abcd${RESET}
`,
        ]);
      });

      it("prints nothing but the label prefix when detail is only whitespace lines", () => {
        mock.method(processDeps.stdout, "getColumns", () => 30);
        const getWrites = mockStdoutWrites();
        toolPrint("bash", "\n\n\n");
        assert.deepStrictEqual(getWrites(), [`${BLUE}${RESET}\n`]);
      });
    });

    describe("wraps the detail", () => {
      it("wraps a detail that does not fit within maxLen", () => {
        mock.method(processDeps.stdout, "getColumns", () => 30);
        const getWrites = mockStdoutWrites();
        toolPrint("bash", "abcdefghijklmnopqrstuvwxyz");
        assert.deepStrictEqual(getWrites(), [
          `${BLUE}${BOLD}bash${BOLD_RESET}: abcdefghijklmnopqrstuvwx
       ┊yz${RESET}
`,
        ]);
      });

      it("wraps without regard to whitespace inside the detail", () => {
        mock.method(processDeps.stdout, "getColumns", () => 30);
        const getWrites = mockStdoutWrites();
        toolPrint("bash", "abc defghijklmnop");
        assert.deepStrictEqual(getWrites(), [
          `${BLUE}${BOLD}bash${BOLD_RESET}: abc defghijklmnop${RESET}
`,
        ]);
      });

      it("wraps multiple original lines and combines them under the same cap", () => {
        mock.method(processDeps.stdout, "getColumns", () => 30);
        const getWrites = mockStdoutWrites();
        toolPrint("bash", "abcdefghij\nkl");
        assert.deepStrictEqual(getWrites(), [
          `${BLUE}${BOLD}bash${BOLD_RESET}: abcdefghij
       ┊kl${RESET}
`,
        ]);
      });

      it("uses label length plus padding for the maxLen when it exceeds the indent", () => {
        mock.method(processDeps.stdout, "getColumns", () => 40);
        const getWrites = mockStdoutWrites();
        toolPrint("abcdefghijklmnopqrst", "abcdefghijklmnopqrstuvwx");
        assert.deepStrictEqual(getWrites(), [
          `${BLUE}${BOLD}abcdefghijklmnopqrst${BOLD_RESET}: abcdefghijklmnopqr
       ┊stuvwx${RESET}
`,
        ]);
      });

      it("falls back to one char per line when the terminal is narrower than the label", () => {
        mock.method(processDeps.stdout, "getColumns", () => 5);
        const getWrites = mockStdoutWrites();
        toolPrint("bash", "abcdefghijklmnopqrstuvwxyz");
        assert.deepStrictEqual(getWrites(), [
          `${BLUE}${BOLD}bash${BOLD_RESET}: a
       ┊b
       ┊c
       ┊d
       ┊…${RESET}
`,
        ]);
      });
    });

    describe("caps at five lines", () => {
      it("caps the total output at five lines", () => {
        mock.method(processDeps.stdout, "getColumns", () => 30);
        const getWrites = mockStdoutWrites();
        toolPrint("bash", "a\nb\nc\nd\ne\nf");
        assert.deepStrictEqual(getWrites(), [
          `${BLUE}${BOLD}bash${BOLD_RESET}: a
       ┊b
       ┊c
       ┊d
       ┊e…${RESET}
`,
        ]);
      });

      it("stops mid-wrap once the five line cap is reached, ending with an ellipsis", () => {
        mock.method(processDeps.stdout, "getColumns", () => 30);
        const getWrites = mockStdoutWrites();
        toolPrint("bash", "abcdefghij\nkl\nm\nn\no\np");
        assert.deepStrictEqual(getWrites(), [
          `${BLUE}${BOLD}bash${BOLD_RESET}: abcdefghij
       ┊kl
       ┊m
       ┊n
       ┊o…${RESET}
`,
        ]);
      });

      it("replaces the last char of a full fifth line with an ellipsis", () => {
        mock.method(processDeps.stdout, "getColumns", () => 30);
        const getWrites = mockStdoutWrites();
        toolPrint("bash", "a".repeat(113));
        assert.deepStrictEqual(getWrites(), [
          `${BLUE}${BOLD}bash${BOLD_RESET}: ${"a".repeat(24)}
       ┊${"a".repeat(22)}
       ┊${"a".repeat(22)}
       ┊${"a".repeat(22)}
       ┊${"a".repeat(21)}…${RESET}
`,
        ]);
      });
    });
  });

  describe("executeBashTool", () => {
    it("returns a successful tool_result with stdout/stderr JSON", async () => {
      const result = await executeBashTool(
        {
          fileSystemAccessType: "read",
          command: "echo hello",
        },
        undefined,
      );
      assert.deepStrictEqual(result, {
        content: JSON.stringify({ stdout: "hello\n", stderr: "" }),
      });
    });

    it("captures stderr in the JSON payload", async () => {
      const result = await executeBashTool(
        {
          fileSystemAccessType: "read",
          command: "echo error >&2",
        },
        undefined,
      );
      assert.deepStrictEqual(result, {
        content: JSON.stringify({ stdout: "", stderr: "error\n" }),
      });
    });

    it("returns isError when command exits with non-zero code", async () => {
      const result = await executeBashTool(
        { fileSystemAccessType: "read", command: "exit 1" },
        undefined,
      );
      assert.strictEqual(result.isError, true);
      assert.match(result.content, /Command failed: exit 1/);
    });

    it("runs the command with /bin/bash as the shell", async () => {
      const optionsCalls = mockExecRecordingOptions();
      await executeBashTool(
        { fileSystemAccessType: "read", command: "echo hi" },
        undefined,
      );
      assert.deepStrictEqual(optionsCalls, [{ shell: "/bin/bash" }]);
    });

    it("passes the abort signal alongside the bash shell", async () => {
      const optionsCalls = mockExecRecordingOptions();
      const controller = new AbortController();
      await executeBashTool(
        { fileSystemAccessType: "read", command: "echo hi" },
        controller.signal,
      );
      assert.deepStrictEqual(optionsCalls, [
        { shell: "/bin/bash", signal: controller.signal },
      ]);
    });
  });

  function makeHangingFetch() {
    let onFetchCalled: () => void = () => undefined;
    const fetchCalledPromise = new Promise<void>((resolve) => {
      onFetchCalled = resolve;
    });
    const fakeFetch = (_input: unknown, init?: { signal: AbortSignal }) => {
      onFetchCalled();
      assert(init?.signal !== undefined);
      const { signal } = init;
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason as Error);
          return;
        }
        signal.addEventListener("abort", () => {
          reject(signal.reason as Error);
        });
      });
    };
    return { fakeFetch, fetchCalledPromise };
  }

  describe("executeWebFetchHtmlTool", () => {
    it("returns parsed article content on success", async () => {
      const html = `
        <html>
          <head><title>Test Page</title></head>
          <body><p>This is the main content of the article that should be extracted.</p></body>
        </html>
      `;
      mock.method(globalThis, "fetch", makeFakeFetch({ text: html }));

      const result = await executeWebFetchHtmlTool({
        href: "https://example.com/article",
      });
      assert.strictEqual(result.isError, undefined);
      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      assert.equal(parsed["title"], "Test Page");
      assert.equal(
        parsed["textContent"],
        `This is the main content of the article that should be extracted.\n        \n      `,
      );
    });

    it("closes the happy-dom window after parsing", async () => {
      const html = `<html><head><title>Test Page</title></head><body><p>Content</p></body></html>`;
      mock.method(globalThis, "fetch", makeFakeFetch({ text: html }));
      const closeSpy = mock.method(DetachedWindowAPI.prototype, "close");

      await executeWebFetchHtmlTool({ href: "https://example.com/article" });
      assert.strictEqual(closeSpy.mock.callCount(), 1);
    });

    it("closes the happy-dom window when no article is found", async () => {
      mock.method(globalThis, "fetch", makeFakeFetch());
      const closeSpy = mock.method(DetachedWindowAPI.prototype, "close");

      const result = await executeWebFetchHtmlTool({
        href: "https://example.com/empty",
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "Failed to parse article from https://example.com/empty",
      });
      assert.strictEqual(closeSpy.mock.callCount(), 1);
    });

    it("returns isError when fetch throws", async () => {
      mock.method(
        globalThis,
        "fetch",
        makeFakeFetch({ error: new Error("network error") }),
      );

      const result = await executeWebFetchHtmlTool({
        href: "https://example.com/fail",
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "network error",
      });
    });

    it("returns isError when response is not ok", async () => {
      mock.method(
        globalThis,
        "fetch",
        makeFakeFetch({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: "server error",
        }),
      );

      const result = await executeWebFetchHtmlTool({
        href: "https://example.com/broken",
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "HTTP 500: Internal Server Error",
      });
    });

    it("returns isError when the request times out", async () => {
      const { fakeFetch, fetchCalledPromise } = makeHangingFetch();
      mock.method(globalThis, "fetch", fakeFetch);

      const controller = new AbortController();
      const resultPromise = executeWebFetchHtmlTool(
        { href: "https://example.com/slow" },
        controller.signal,
      );
      await fetchCalledPromise;
      controller.abort(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      );
      const result = await resultPromise;
      assert.deepStrictEqual(result, {
        isError: true,
        content: "The operation was aborted due to timeout",
      });
    });

    it("rethrows when aborted by the caller", async () => {
      const controller = new AbortController();
      const { fakeFetch } = makeHangingFetch();
      mock.method(globalThis, "fetch", fakeFetch);

      const resultPromise = executeWebFetchHtmlTool(
        { href: "https://example.com/slow" },
        controller.signal,
      );
      controller.abort();
      await assert.rejects(resultPromise, { name: "AbortError" });
    });
  });

  describe("executeWebFetchJsonTool", () => {
    it("returns parsed JSON content on success", async () => {
      const jsonData = { name: "test", value: 42 };
      mock.method(globalThis, "fetch", makeFakeFetch({ json: jsonData }));

      const result = await executeWebFetchJsonTool({
        href: "https://api.example.com/data",
      });
      assert.deepStrictEqual(result, {
        content: JSON.stringify(jsonData, null, 2),
      });
    });

    it("returns isError when fetch throws", async () => {
      mock.method(
        globalThis,
        "fetch",
        makeFakeFetch({ error: new Error("network error") }),
      );

      const result = await executeWebFetchJsonTool({
        href: "https://api.example.com/fail",
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "network error",
      });
    });

    it("returns isError when response is not ok", async () => {
      mock.method(
        globalThis,
        "fetch",
        makeFakeFetch({ ok: false, status: 404, statusText: "Not Found" }),
      );

      const result = await executeWebFetchJsonTool({
        href: "https://api.example.com/missing",
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "HTTP 404: Not Found",
      });
    });

    it("returns isError when JSON parsing fails", async () => {
      const fakeFetch = () => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.reject(new Error("Invalid JSON")),
        } as Response);
      };
      mock.method(globalThis, "fetch", fakeFetch);

      const result = await executeWebFetchJsonTool({
        href: "https://api.example.com/bad-json",
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "Invalid JSON",
      });
    });

    it("returns isError when the request times out", async () => {
      const { fakeFetch, fetchCalledPromise } = makeHangingFetch();
      mock.method(globalThis, "fetch", fakeFetch);

      const controller = new AbortController();
      const resultPromise = executeWebFetchJsonTool(
        { href: "https://api.example.com/slow" },
        controller.signal,
      );
      await fetchCalledPromise;
      controller.abort(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      );
      const result = await resultPromise;
      assert.deepStrictEqual(result, {
        isError: true,
        content: "The operation was aborted due to timeout",
      });
    });
  });

  describe("executeReadImageTool", () => {
    it("returns base64 data and the media type for an image file", async () => {
      testFs.writeFile("/test/cwd/image.png", "png bytes");
      const result = await executeReadImageTool({
        filePath: "/test/cwd/image.png",
      });
      assert.deepStrictEqual(result, {
        isError: false,
        base64Data: "cG5nIGJ5dGVz",
        mediaType: "image/png",
      });
    });

    it("matches the extension case-insensitively", async () => {
      testFs.writeFile("/test/cwd/photo.JPEG", "jpeg bytes");
      const result = await executeReadImageTool({
        filePath: "/test/cwd/photo.JPEG",
      });
      assert.deepStrictEqual(result, {
        isError: false,
        base64Data: Buffer.from("jpeg bytes").toString("base64"),
        mediaType: "image/jpeg",
      });
    });

    it("passes the model output through in toModelOutput", async () => {
      const { toModelOutput } = harnessTools.read_image;
      assert(toModelOutput !== undefined);
      const result = await toModelOutput({
        toolCallId: "tool-id",
        input: { filePath: "/test/cwd/image.png" },
        output: {
          isError: false,
          base64Data: "cG5nIGJ5dGVz",
          mediaType: "image/png",
        },
      } as never);
      assert.deepStrictEqual(result, {
        type: "content",
        value: [
          {
            type: "file",
            data: { type: "data", data: "cG5nIGJ5dGVz" },
            mediaType: "image/png",
          },
        ],
      });
    });

    it("maps an error output to text in toModelOutput", async () => {
      const { toModelOutput } = harnessTools.read_image;
      assert(toModelOutput !== undefined);
      const result = await toModelOutput({
        toolCallId: "tool-id",
        input: { filePath: "/test/cwd/notes.txt" },
        output: {
          isError: true,
          content: "Unsupported image file type: .txt",
        },
      } as never);
      assert.deepStrictEqual(result, {
        type: "text",
        value: "Unsupported image file type: .txt",
      });
    });

    it("returns isError for an unsupported file extension", async () => {
      testFs.writeFile("/test/cwd/notes.txt", "text");
      const result = await executeReadImageTool({
        filePath: "/test/cwd/notes.txt",
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "Unsupported image file type: .txt",
      });
    });

    it("returns isError when the file does not exist", async () => {
      const result = await executeReadImageTool({
        filePath: "/test/cwd/missing.png",
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "ENOENT: /test/cwd/missing.png",
      });
    });
  });

  describe("TOOLS", () => {
    it("registers tools under the names referenced by the system prompt", () => {
      assert.deepStrictEqual(Object.keys(harnessTools), [
        "web_fetch_html",
        "web_fetch_json",
        "load_skill",
        "bash",
        "read_image",
        "mcp_list_resources",
        "mcp_read_resource",
        "create_subagent",
      ]);
    });
  });

  describe("stringifyTools", () => {
    it("returns the harness and mcp tools as compact json", () => {
      actions.setMcp({}, { mcp_tool: makeMcpTool() });

      assert.strictEqual(
        stringifyTools(),
        safeStringify({ ...harnessTools, mcp_tool: makeMcpTool() }),
      );
    });
  });

  describe("loadSkillTool", () => {
    beforeEach(() => {
      actions.resetState();
    });

    it("returns loaded skill content when skill exists in state", () => {
      actions.setSkills([
        {
          name: "deploy",
          description: "Deploy skill",
          dir: "/skills/deploy",
          content: "# Deploy instructions",
        },
      ]);
      const result = loadSkillTool({ name: "deploy" });
      assert.deepStrictEqual(result, {
        content: JSON.stringify(
          {
            name: "deploy",
            description: "Deploy skill",
            dir: "/skills/deploy",
            content: "# Deploy instructions",
          },
          null,
          2,
        ),
      });
    });

    it("finds the correct skill when multiple skills are stored", () => {
      actions.setSkills([
        {
          name: "skill-a",
          description: "Skill A",
          dir: "/a",
          content: "content a",
        },
        {
          name: "skill-b",
          description: "Skill B",
          dir: "/b",
          content: "content b",
        },
      ]);
      const result = loadSkillTool({ name: "skill-b" });
      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      assert.equal(parsed["name"], "skill-b");
    });

    it("returns isError when skill is not found", () => {
      const result = loadSkillTool({ name: "nonexistent" });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "Could not find a skill with name: nonexistent",
      });
    });

    it("returns isError when no skills are loaded", () => {
      const result = loadSkillTool({ name: "any" });
      assert.strictEqual(result.isError, true);
    });
  });

  describe("createSubagentTaskSchema", () => {
    it("accepts the current model", () => {
      actions.setModel("model-a");
      assert.strictEqual(
        createSubagentTaskSchema.safeParse({
          prompt: "inspect",
          access: "read-only",
          model: "model-a",
        }).success,
        true,
      );
    });

    it("requires and validates the model", () => {
      actions.setModel("model-a");
      assert.strictEqual(
        createSubagentTaskSchema.safeParse({
          prompt: "inspect",
          access: "read-only",
        }).success,
        false,
      );
      assert.strictEqual(
        createSubagentTaskSchema.safeParse({
          prompt: "inspect",
          access: "read-only",
          model: "model-a",
        }).success,
        true,
      );
      assert.strictEqual(
        createSubagentTaskSchema.safeParse({
          prompt: "inspect",
          access: "read-only",
          model: "unknown",
        }).success,
        false,
      );
    });

    it("accepts configured subagent models from state", () => {
      actions.setModel("main-model");
      actions.setSubagentModels(["fast-model", "strong-model"]);
      assert.strictEqual(
        createSubagentTaskSchema.safeParse({
          prompt: "inspect",
          access: "read-only",
          model: "strong-model",
        }).success,
        true,
      );
      assert.strictEqual(
        createSubagentTaskSchema.safeParse({
          prompt: "inspect",
          access: "read-only",
          model: "main-model",
        }).success,
        false,
      );
    });

    it("uses the current model when configured subagent models are empty", () => {
      actions.setModel("main-model");
      actions.setSubagentModels([]);
      assert.strictEqual(
        createSubagentTaskSchema.safeParse({
          prompt: "inspect",
          access: "read-only",
          model: "main-model",
        }).success,
        true,
      );
    });
  });

  describe("createSubagentTool", () => {
    describe("runs subagents", () => {
      it("runs read-only subagents in parallel and returns structured results", async () => {
        const calls: Record<string, unknown>[] = [];
        mockGenerateText((options: Record<string, unknown>) => {
          calls.push(options);
          return makeGenerateTextResult({
            text: `result-${String(calls.length)}`,
          });
        });

        const result = await createSubagentTool({
          tasks: [
            { prompt: "inspect one", access: "read-only", model: "model-one" },
            { prompt: "inspect two", access: "read-only", model: "model-two" },
          ],
        });

        assert.deepStrictEqual(JSON.parse(result.content), [
          {
            model: "model-one",
            prompt: "inspect one",
            content: "result-1",
          },
          {
            model: "model-two",
            prompt: "inspect two",
            content: "result-2",
          },
        ]);
        const firstCall = calls[0];
        assert(firstCall !== undefined);

        const firstTools = firstCall["tools"];
        const firstMessages = firstCall["messages"] as { role: string }[];
        assert(firstTools !== undefined && firstTools !== null);

        const firstMessage = firstMessages[0];
        assert(firstMessage !== undefined);

        assert.deepStrictEqual(Object.keys(firstTools), [
          "web_fetch_html",
          "web_fetch_json",
          "load_skill",
          "bash",
          "read_image",
          "mcp_list_resources",
          "mcp_read_resource",
        ]);
        assert.strictEqual(firstMessage.role, "user");
      });

      it("gives read-write subagents write tools and prints file diffs", async () => {
        const mcpTool = makeMcpTool();
        actions.setMcp({}, { mcp_tool: mcpTool });
        const getWrites = mockStdoutWrites();
        testFs._files.set("/test/file.txt", "original content");
        mockGenerateText(async (options: Record<string, unknown>) => {
          const writeTools = options["tools"];
          assert(writeTools !== undefined && writeTools !== null);
          assert.deepStrictEqual(Object.keys(writeTools), [
            "web_fetch_html",
            "web_fetch_json",
            "load_skill",
            "bash",
            "read_image",
            "mcp_list_resources",
            "mcp_read_resource",
            "mcp_tool",
          ]);
          const onStart = options["onToolExecutionStart"] as (
            arg: Record<string, unknown>,
          ) => Promise<unknown>;
          const onFinish = options["onToolExecutionEnd"] as (
            arg: Record<string, unknown>,
          ) => Promise<void>;
          assert.strictEqual(typeof onStart, "function");
          assert.strictEqual(typeof onFinish, "function");
          await onStart({
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
          testFs._files.set("/test/file.txt", "modified content");
          mockExec({ stdout: "+modified content" });
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
          return makeGenerateTextResult({ text: "done" });
        });

        const result = await createSubagentTool({
          tasks: [
            { prompt: "edit", access: "read-write", model: "main-model" },
          ],
        });

        assert.deepStrictEqual(JSON.parse(result.content), [
          { model: "main-model", prompt: "edit", content: "done" },
        ]);
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${GREY}━━ ${BOLD}File change: /test/file.txt${BOLD_RESET} ━━${RESET}\n`,
          "+modified content\n\n",
        ]);
      });

      it("builds subagent systemContent from prompt, context, and skills", async () => {
        actions.setContextStr("ctx body");
        actions.setSkillsStr("skills body");
        const calls: Record<string, unknown>[] = [];
        mockGenerateText((options: Record<string, unknown>) => {
          calls.push(options);
          return makeGenerateTextResult({ text: "ok" });
        });

        await createSubagentTool({
          tasks: [
            { prompt: "inspect", access: "read-only", model: "main-model" },
          ],
        });

        const firstCall = calls[0];
        assert(firstCall !== undefined);
        assert.strictEqual(
          firstCall["instructions"],
          `${getSubagentPrompt("read-only", [])}

ctx body

skills body`,
        );
      });
    });

    describe("selects the model", () => {
      it("uses the configured model when a task model is omitted", async () => {
        mockGenerateText((options: { model: { modelId: string } }) => {
          assert.strictEqual(options.model.modelId, "main-model");
          return Promise.resolve(makeGenerateTextResult({ text: "ok" }));
        });

        const result = await createSubagentTool({
          tasks: [
            { prompt: "inspect", access: "read-only", model: "main-model" },
          ],
        });

        assert.deepStrictEqual(JSON.parse(result.content), [
          { model: "main-model", prompt: "inspect", content: "ok" },
        ]);
      });

      it("uses the task model", async () => {
        mockGenerateText((options: { model: { modelId: string } }) => {
          assert.strictEqual(options.model.modelId, "main-model");
          return Promise.resolve(makeGenerateTextResult({ text: "ok" }));
        });

        const result = await createSubagentTool({
          tasks: [
            { prompt: "inspect", access: "read-only", model: "main-model" },
          ],
        });

        assert.deepStrictEqual(JSON.parse(result.content), [
          { model: "main-model", prompt: "inspect", content: "ok" },
        ]);
      });
    });

    describe("handles failures", () => {
      it("returns errors for failed subagents without hiding successful results", async () => {
        mockGenerateText((options: { model: { modelId: string } }) => {
          if (options.model.modelId === "bad-model") {
            return Promise.reject(new Error("subagent failed"));
          }
          return Promise.resolve(makeGenerateTextResult({ text: "ok" }));
        });

        const result = await createSubagentTool({
          tasks: [
            { prompt: "bad", access: "read-only", model: "bad-model" },
            { prompt: "good", access: "read-only", model: "good-model" },
          ],
        });

        assert.strictEqual(result.isError, true);
        assert.deepStrictEqual(JSON.parse(result.content), [
          {
            model: "bad-model",
            prompt: "bad",
            isError: true,
            content: "subagent failed",
          },
          { model: "good-model", prompt: "good", content: "ok" },
        ]);
      });

      it("returns a timeout error with subagent metadata", async () => {
        mockGenerateText(() =>
          Promise.reject(
            new DOMException(
              "The operation was aborted due to timeout",
              "TimeoutError",
            ),
          ),
        );

        const result = await createSubagentTool({
          tasks: [
            {
              prompt: "inspect timeout",
              access: "read-only",
              model: "slow-model",
            },
          ],
        });

        assert.strictEqual(result.isError, true);
        assert.deepStrictEqual(JSON.parse(result.content), [
          {
            model: "slow-model",
            prompt: "inspect timeout",
            isError: true,
            content: "The operation was aborted due to timeout",
          },
        ]);
      });

      it("rethrows when aborted by the caller", async () => {
        const controller = new AbortController();
        let onGenerateTextCalled: () => void = () => undefined;
        const generateTextCalledPromise = new Promise<void>((resolve) => {
          onGenerateTextCalled = resolve;
        });
        mockGenerateText((options: { abortSignal?: AbortSignal }) => {
          onGenerateTextCalled();
          assert(options.abortSignal !== undefined);
          const { abortSignal } = options;
          return new Promise((_resolve, reject) => {
            abortSignal.addEventListener("abort", () => {
              reject(
                new DOMException("This operation was aborted", "AbortError"),
              );
            });
          });
        });

        const resultPromise = createSubagentTool(
          {
            tasks: [
              {
                prompt: "inspect abort",
                access: "read-only",
                model: "main-model",
              },
            ],
          },
          controller.signal,
        );
        await generateTextCalledPromise;
        controller.abort();

        await assert.rejects(resultPromise, { name: "AbortError" });
      });
    });
  });
});

const testConfig = {
  model: "claude-sonnet-4-6",
  baseURL: "https://api.example.com",
};

describe("config", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  it("requires edit in the defaulted keymaps", () => {
    const result = DefaultedConfigSchema.safeParse({
      ...defaultConfig,
      keymaps: {},
    });
    assert.equal(result.success, false);
  });

  describe("when local config exists", () => {
    describe("model and provider settings", () => {
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

        assert.deepStrictEqual(getState().config.subagentModels, [
          "local-model",
        ]);
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

      it("appends the api key error to config error messages when the api key is missing", async () => {
        testProcessEnv._clear();
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            model: testConfig.model,
            baseURL: testConfig.baseURL,
            sdkProvider: "anthropic",
          }),
        );
        testFs._files.set(
          getLocalConfigPath(),
          JSON.stringify({
            model: testConfig.model,
            baseURL: testConfig.baseURL,
            sdkProvider: "anthropic",
          }),
        );

        await initState();

        assert.deepStrictEqual(getState().content.configErrorMessages, [
          "Set the `LASSO_API_KEY` environment variable, e.g. `export LASSO_API_KEY=...`",
        ]);
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
    });

    describe("transcription settings", () => {
      it("uses its transcriptionSdkProvider over the global config, default config", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            sdkProvider: "anthropic",
            transcriptionSdkProvider: "google",
          }),
        );
        testFs._files.set(
          getLocalConfigPath(),
          JSON.stringify({
            ...testConfig,
            sdkProvider: "anthropic",
            transcriptionSdkProvider: "openai",
          }),
        );

        await initState();

        assert.equal(getState().config.transcriptionSdkProvider, "openai");
      });

      it("uses its transcriptionModel over the global config, default config", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            sdkProvider: "anthropic",
            transcriptionModel: "global-transcribe",
          }),
        );
        testFs._files.set(
          getLocalConfigPath(),
          JSON.stringify({
            ...testConfig,
            sdkProvider: "anthropic",
            transcriptionModel: "local-transcribe",
          }),
        );

        await initState();

        assert.equal(getState().config.transcriptionModel, "local-transcribe");
      });

      it("uses its transcriptionBaseURL over config absence", async () => {
        testFs._files.set(
          getLocalConfigPath(),
          JSON.stringify({
            ...testConfig,
            transcriptionBaseURL: "https://transcribe.example.com",
          }),
        );

        await initState();

        assert.equal(
          getState().config.transcriptionBaseURL,
          "https://transcribe.example.com",
        );
      });

      it("uses defaults when transcription options are not set", async () => {
        testFs._files.set(
          getLocalConfigPath(),
          JSON.stringify({ ...testConfig }),
        );

        await initState();

        assert.equal(getState().config.transcriptionSdkProvider, undefined);
        assert.equal(getState().config.transcriptionModel, undefined);
        assert.equal(getState().config.transcriptionBaseURL, undefined);
      });
    });

    describe("gateway and mcps", () => {
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

      it("merges its mcps with the global and default config", async () => {
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

        const { globalConfig, localConfig } = await initStateFirst();
        initStateFromConfig({ globalConfig, localConfig });

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
    });

    describe("pricing and context windows", () => {
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
    });

    describe("keymaps", () => {
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

        await initState();
        const messages = getState().content.configErrorMessages.filter(
          (message) => message.includes("`keymaps` must be unique"),
        );
        assert.strictEqual(messages.length, 1);
        assert.match(
          first(messages),
          /`keymaps` must be unique: `edit` and `clear` are both bound to/,
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

        await initState();
        const messages = getState().content.configErrorMessages;
        const keymapMessages = messages.filter((message) =>
          message.includes("`keymaps` must be unique"),
        );
        assert.strictEqual(keymapMessages.length, 1);
        assert.match(
          first(keymapMessages),
          /`keymaps` must be unique: `clear` and `history` are both bound to/,
        );
      });
    });

    describe("directories and loading state", () => {
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
    });

    describe("settings overrides", () => {
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

      it("uses its suppressStartupDurations over the global config, default config", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            suppressStartupDurations: true,
          }),
        );
        testFs._files.set(
          getLocalConfigPath(),
          JSON.stringify({
            ...testConfig,
            suppressStartupDurations: false,
          }),
        );

        await initState();

        assert.strictEqual(getState().config.suppressStartupDurations, false);
      });

      it("uses its suppressConfigWarnings over the global config, default config", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            suppressConfigWarnings: true,
          }),
        );
        testFs._files.set(
          getLocalConfigPath(),
          JSON.stringify({
            ...testConfig,
            suppressConfigWarnings: false,
          }),
        );

        await initState();

        assert.strictEqual(getState().config.suppressConfigWarnings, false);
      });

      it("uses its suppressToolEditDiffs over the global config, default config", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            suppressToolEditDiffs: true,
          }),
        );
        testFs._files.set(
          getLocalConfigPath(),
          JSON.stringify({
            ...testConfig,
            suppressToolEditDiffs: false,
          }),
        );

        await initState();

        assert.strictEqual(getState().config.suppressToolEditDiffs, false);
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

      it("uses its asciiOnly over the global config, default config", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            asciiOnly: true,
          }),
        );
        testFs._files.set(
          getLocalConfigPath(),
          JSON.stringify({
            ...testConfig,
            asciiOnly: false,
          }),
        );

        await initState();

        assert.strictEqual(getState().config.asciiOnly, false);
      });

      it("uses its compactWithStructuredOutput over the global config, default config", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            compactWithStructuredOutput: false,
          }),
        );
        testFs._files.set(
          getLocalConfigPath(),
          JSON.stringify({
            ...testConfig,
            compactWithStructuredOutput: true,
          }),
        );

        await initState();

        assert.strictEqual(getState().config.compactWithStructuredOutput, true);
      });

      it("uses its reasoning over the global config, default config", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            reasoning: "low",
          }),
        );
        testFs._files.set(
          getLocalConfigPath(),
          JSON.stringify({
            ...testConfig,
            reasoning: "high",
          }),
        );

        await initState();

        assert.strictEqual(getState().config.reasoning, "high");
      });
    });

    describe("rejects invalid values", () => {
      it("rejects an invalid reasoning", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            reasoning: "maximum",
          }),
        );

        await initState();
        const invalidOptionMessages =
          getState().content.configErrorMessages.filter((message) =>
            message.includes("Failed to validate"),
          );
        assert.strictEqual(invalidOptionMessages.length, 1);
        assert.match(first(invalidOptionMessages), /Invalid option/);
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

        await initState();
        const invalidOptionMessages =
          getState().content.configErrorMessages.filter((message) =>
            message.includes("Failed to validate"),
          );
        assert.strictEqual(invalidOptionMessages.length, 1);
        assert.match(
          first(invalidOptionMessages),
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

        await initState();
        const invalidOptionMessages =
          getState().content.configErrorMessages.filter((message) =>
            message.includes("Failed to validate"),
          );
        assert.strictEqual(invalidOptionMessages.length, 1);
        assert.match(
          first(invalidOptionMessages),
          /Invalid string: must end with \\"\\n\\"/,
        );
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

        await initState();
        const invalidOptionMessages =
          getState().content.configErrorMessages.filter((message) =>
            message.includes("Failed to validate"),
          );
        assert.strictEqual(invalidOptionMessages.length, 1);
        assert.match(first(invalidOptionMessages), /Unrecognized key/);
      });
    });

    describe("usage limit settings", () => {
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

        await initState();
        const invalidOptionMessages =
          getState().content.configErrorMessages.filter((message) =>
            message.includes("Failed to validate"),
          );
        assert.strictEqual(invalidOptionMessages.length, 1);
        assert.match(
          first(invalidOptionMessages),
          /Invalid input: expected string/,
        );
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

        await initState();
        const invalidOptionMessages =
          getState().content.configErrorMessages.filter((message) =>
            message.includes("Failed to validate"),
          );
        assert.strictEqual(invalidOptionMessages.length, 1);
        assert.match(
          first(invalidOptionMessages),
          /Invalid input: expected number/,
        );
      });
    });

    describe("rejects invalid usage limits", () => {
      it("rejects non-string usageLimit.duration", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            usageLimit: { duration: 3_600_000, dollarAmount: 10 },
          }),
        );

        await initState();
        const invalidOptionMessages =
          getState().content.configErrorMessages.filter((message) =>
            message.includes("Failed to validate"),
          );
        assert.strictEqual(invalidOptionMessages.length, 1);
        assert.match(
          first(invalidOptionMessages),
          /Invalid input: expected string/,
        );
      });

      it("rejects usageLimit.duration with an invalid suffix", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            usageLimit: { duration: "10x", dollarAmount: 10 },
          }),
        );

        await initState();
        const invalidOptionMessages =
          getState().content.configErrorMessages.filter((message) =>
            message.includes("Failed to validate"),
          );
        assert.strictEqual(invalidOptionMessages.length, 1);
        assert.match(
          first(invalidOptionMessages),
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

        await initState();
        const invalidOptionMessages =
          getState().content.configErrorMessages.filter((message) =>
            message.includes("Failed to validate"),
          );
        assert.strictEqual(invalidOptionMessages.length, 1);
        assert.match(
          first(invalidOptionMessages),
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

        await initState();
        const invalidOptionMessages =
          getState().content.configErrorMessages.filter((message) =>
            message.includes("Failed to validate"),
          );
        assert.strictEqual(invalidOptionMessages.length, 1);
        assert.match(
          first(invalidOptionMessages),
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

        await initState();
        const invalidOptionMessages =
          getState().content.configErrorMessages.filter((message) =>
            message.includes("Failed to validate"),
          );
        assert.strictEqual(invalidOptionMessages.length, 1);
        assert.match(
          first(invalidOptionMessages),
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

        await initState();
        const invalidOptionMessages =
          getState().content.configErrorMessages.filter((message) =>
            message.includes("Failed to validate"),
          );
        assert.strictEqual(invalidOptionMessages.length, 1);
        assert.match(
          first(invalidOptionMessages),
          /Invalid input: expected number/,
        );
      });
    });

    describe("rejects non-boolean values", () => {
      it("rejects non-boolean asciiOnly", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            asciiOnly: "yes",
          }),
        );

        await initState();
        const invalidOptionMessages =
          getState().content.configErrorMessages.filter((message) =>
            message.includes("Failed to validate"),
          );
        assert.strictEqual(invalidOptionMessages.length, 1);
        assert.match(
          first(invalidOptionMessages),
          /Invalid input: expected boolean/,
        );
      });

      it("rejects non-boolean suppressStartupDurations", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            suppressStartupDurations: "yes",
          }),
        );

        await initState();
        const invalidOptionMessages =
          getState().content.configErrorMessages.filter((message) =>
            message.includes("Failed to validate"),
          );
        assert.strictEqual(invalidOptionMessages.length, 1);
        assert.match(
          first(invalidOptionMessages),
          /Invalid input: expected boolean/,
        );
      });

      it("rejects non-boolean compactWithStructuredOutput", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            compactWithStructuredOutput: "yes",
          }),
        );

        await initState();
        const invalidOptionMessages =
          getState().content.configErrorMessages.filter((message) =>
            message.includes("Failed to validate"),
          );
        assert.strictEqual(invalidOptionMessages.length, 1);
        assert.match(
          first(invalidOptionMessages),
          /Invalid input: expected boolean/,
        );
      });

      it("rejects non-boolean suppressToolEditDiffs", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            suppressToolEditDiffs: "yes",
          }),
        );

        await initState();
        const invalidOptionMessages =
          getState().content.configErrorMessages.filter((message) =>
            message.includes("Failed to validate"),
          );
        assert.strictEqual(invalidOptionMessages.length, 1);
        assert.match(
          first(invalidOptionMessages),
          /Invalid input: expected boolean/,
        );
      });

      it("rejects non-boolean suppressConfigWarnings", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            suppressConfigWarnings: "yes",
          }),
        );

        await initState();
        const invalidOptionMessages =
          getState().content.configErrorMessages.filter((message) =>
            message.includes("Failed to validate"),
          );
        assert.strictEqual(invalidOptionMessages.length, 1);
        assert.match(
          first(invalidOptionMessages),
          /Invalid input: expected boolean/,
        );
      });
    });
  });

  describe("when local config does not exist", () => {
    describe("when the global config exists", () => {
      describe("model, pricing, and warnings", () => {
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

        it("warns when the model has no contextWindowPerModel entry", async () => {
          testFs._files.set(
            getGlobalConfigPath(),
            JSON.stringify({
              model: testConfig.model,
              suppressStartupDurations: true,
            }),
          );

          const getWrites = mockStdoutWrites();
          await initState();
          assert.deepStrictEqual(getState().content.configWarningMessages, [
            "A default context window of 128,000 tokens is used because there is no `contextWindowPerModel` entry for the current model `claude-sonnet-4-6`",
          ]);
          warnOnMissingConfig();
          assert.deepStrictEqual(getWrites(), [
            "\n",
            `${YELLOW}Warnings:${RESET}\n`,
            `${YELLOW}- A default context window of 128,000 tokens is used because there is no \`contextWindowPerModel\` entry for the current model \`claude-sonnet-4-6\`${RESET}\n`,
            "\n",
            `${YELLOW}Suppress these warnings via the \`suppressConfigWarnings\` config option${RESET}\n`,
            "\n",
          ]);
        });

        it("when suppressConfigWarnings is true it suppresses the warnings", async () => {
          testFs._files.set(
            getGlobalConfigPath(),
            JSON.stringify({
              model: testConfig.model,
              sdkProvider: "anthropic",
              suppressStartupDurations: true,
              suppressConfigWarnings: true,
            }),
          );

          const getWrites = mockStdoutWrites();
          await initState();
          assert.deepStrictEqual(getState().content.configWarningMessages, [
            "A default context window of 128,000 tokens is used because there is no `contextWindowPerModel` entry for the current model `claude-sonnet-4-6`",
          ]);
          warnOnMissingConfig();
          assert.deepStrictEqual(getWrites(), []);
        });

        it("when bat is unavailable and suppressConfigWarnings is true it suppresses the warning", async () => {
          testFs._files.set(
            getGlobalConfigPath(),
            JSON.stringify({
              model: testConfig.model,
              sdkProvider: "anthropic",
              contextWindowPerModel: { "claude-sonnet-4-6": 200_000 },
              suppressStartupDurations: true,
              suppressConfigWarnings: true,
            }),
          );
          mockExec({ stdout: "", error: new Error("bat: command not found") });

          const getWrites = mockStdoutWrites();
          await initState();
          assert.deepStrictEqual(getState().content.configWarningMessages, [
            "`bat` is not available; consider installing it to properly render markdown responses",
          ]);
          warnOnMissingConfig();
          assert.deepStrictEqual(getWrites(), []);
        });

        it("does not warn when the model has a contextWindowPerModel entry", async () => {
          testFs._files.set(
            getGlobalConfigPath(),
            JSON.stringify({
              model: testConfig.model,
              contextWindowPerModel: { "claude-sonnet-4-6": 200_000 },
              suppressStartupDurations: true,
            }),
          );

          const getWrites = mockStdoutWrites();
          await initState();
          assert.deepStrictEqual(getWrites(), []);
        });

        it("warns when the usage limit has no pricingPerModel entry for the current model", async () => {
          testFs._files.set(
            getGlobalConfigPath(),
            JSON.stringify({
              ...testConfig,
              usageLimit: { duration: "2h", dollarAmount: 10 },
              contextWindowPerModel: { "claude-sonnet-4-6": 200_000 },
              suppressStartupDurations: true,
            }),
          );

          const getWrites = mockStdoutWrites();
          await initState();
          assert.deepStrictEqual(getState().content.configWarningMessages, [
            "Usage limit is disabled because there is no `pricingPerModel` entry for the current model `claude-sonnet-4-6`",
          ]);
          assert.deepStrictEqual(getWrites(), []);
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
      });

      describe("keymaps and loading state", () => {
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
      });

      describe("settings overrides", () => {
        it("hides startup durations when suppressStartupDurations is true", async () => {
          testFs._files.set(
            getGlobalConfigPath(),
            JSON.stringify({
              model: testConfig.model,
              sdkProvider: "anthropic",
              suppressStartupDurations: true,
              baseURL: "https://api.example.com",
            }),
          );

          const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });
          await initState();
          assert.deepStrictEqual(getWrites(), []);
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

        it("uses its suppressStartupDurations over the default config", async () => {
          testFs._files.set(
            getGlobalConfigPath(),
            JSON.stringify({
              ...testConfig,
              suppressStartupDurations: true,
            }),
          );

          await initState();

          assert.strictEqual(getState().config.suppressStartupDurations, true);
        });

        it("uses its suppressConfigWarnings over the default config", async () => {
          testFs._files.set(
            getGlobalConfigPath(),
            JSON.stringify({
              ...testConfig,
              suppressConfigWarnings: true,
            }),
          );

          await initState();

          assert.strictEqual(getState().config.suppressConfigWarnings, true);
        });

        it("uses its asciiOnly over the default config", async () => {
          testFs._files.set(
            getGlobalConfigPath(),
            JSON.stringify({
              ...testConfig,
              asciiOnly: true,
            }),
          );

          await initState();

          assert.strictEqual(getState().config.asciiOnly, true);
        });

        it("uses its compactWithStructuredOutput over the default config", async () => {
          testFs._files.set(
            getGlobalConfigPath(),
            JSON.stringify({
              ...testConfig,
              compactWithStructuredOutput: false,
            }),
          );

          await initState();

          assert.strictEqual(
            getState().config.compactWithStructuredOutput,
            false,
          );
        });

        it("uses its reasoning over the default config", async () => {
          testFs._files.set(
            getGlobalConfigPath(),
            JSON.stringify({
              ...testConfig,
              reasoning: "medium",
            }),
          );

          await initState();

          assert.strictEqual(getState().config.reasoning, "medium");
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

      describe("usage limits", () => {
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
        await initState();
        const messages = getState().content.configErrorMessages;
        assert.strictEqual(messages.length, 1);
        assert.match(
          first(messages),
          /A `baseURL` is required when `sdkProvider` is `openai-compatible`/,
        );
      });
    });
  });

  describe("validates loadingStateFrames", () => {
    it("throws when loadingStateFrames have unequal lengths", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
          loadingStateFrames: ["..", "...", ".."],
        }),
      );

      await initState();
      const invalidOptionMessages =
        getState().content.configErrorMessages.filter((message) =>
          message.includes("Failed to validate"),
        );
      assert.strictEqual(invalidOptionMessages.length, 1);
      assert.match(
        first(invalidOptionMessages),
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

      await initState();
      const invalidOptionMessages =
        getState().content.configErrorMessages.filter((message) =>
          message.includes("Failed to validate"),
        );
      assert.strictEqual(invalidOptionMessages.length, 1);
      assert.match(
        first(invalidOptionMessages),
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

      await initState();
      const invalidOptionMessages =
        getState().content.configErrorMessages.filter((message) =>
          message.includes("Failed to validate"),
        );
      assert.strictEqual(invalidOptionMessages.length, 1);
      assert.match(
        first(invalidOptionMessages),
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
  });

  describe("throws on invalid config", () => {
    it("throws on invalid YAML in global config", async () => {
      testFs._files.set(getGlobalConfigPath(), "key: [unclosed");

      await initState();
      const messages = getState().content.configErrorMessages.filter(
        (message) => message.includes("Invalid YAML"),
      );
      assert.strictEqual(messages.length, 1);
      assert.match(
        first(messages),
        /`\/fake-home\/.config\/lasso\/settings.yaml`, using the default config/,
      );
    });

    it("throws on invalid YAML in local config", async () => {
      testFs._files.set(getLocalConfigPath(), "key: [unclosed");

      await initState();
      const messages = getState().content.configErrorMessages.filter(
        (message) => message.includes("Invalid YAML"),
      );
      assert.strictEqual(messages.length, 1);
      assert.match(
        first(messages),
        /`\/test-cwd\/.lasso\/settings.yaml`, using the default config/,
      );
    });

    describe("throws on invalid config", () => {
      it("throws on invalid global config option", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            ...testConfig,
            invalidOption: true,
          }),
        );

        await initState();
        const messages = getState().content.configErrorMessages.filter(
          (message) => message.includes("Failed to validate"),
        );
        assert.strictEqual(messages.length, 1);
        assert.match(
          first(messages),
          /Failed to validate `\/fake-home\/.config\/lasso\/settings\.yaml`/,
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

        await initState();
        const messages = getState().content.configErrorMessages.filter(
          (message) => message.includes("Failed to validate"),
        );
        assert.strictEqual(messages.length, 1);
        assert.match(
          first(messages),
          /Failed to validate `\/test-cwd\/.lasso\/settings\.yaml`/,
        );
      });
    });

    it("sets debug from DEBUG env var", async () => {
      testProcessEnv._clear();
      testProcessEnv._set("DEBUG", "1");
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
        }),
      );

      await initState();
      assert.equal(getState().debug.debugLog, true);
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
        getState().content.contextStr,
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
        getState().content.globalConfigStr,
        JSON.stringify({ model: "gpt-4" }),
      );
      assert.equal(
        getState().content.localConfigStr,
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
      assert.equal(getState().content.localConfigStr, "{}");
    });

    it("sets skillsStr from dep", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
        }),
      );

      await initState();
      assert.equal(getState().content.skillsStr, "");
    });

    it("preserves the initialized sessionStartDate", async () => {
      const sessionStartDate = getState().session.sessionStartDate;
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
        }),
      );

      await initState();
      assert.strictEqual(getState().session.sessionStartDate, sessionStartDate);
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
        getState().debug.debugLogPath,
        "/fake-home/.local/state/lasso/debug/debug-test-uuid.log",
      );
    });

    it("wires the tools content string for token counting", async () => {
      testFs._files.set(getLocalConfigPath(), JSON.stringify(testConfig));

      await initState();

      assert.strictEqual(promptDeps.getToolsContentStr(), stringifyTools());
    });
  });

  describe("loads usage from the log", () => {
    it("sets modelUsageForLimitWindow to an empty object", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          ...testConfig,
        }),
      );

      await initState();
      assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {});
      assert.deepStrictEqual(getState().usage.modelUsageForSession, {});
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

      assert.deepStrictEqual(getState().usage.modelUsageForLimitWindow, {
        "gpt-4": [recent],
      });
    });
  });

  describe("initStateFirst", () => {
    it("sets debug flag when DEBUG=1", async () => {
      testProcessEnv._clear();
      testProcessEnv._set("DEBUG", "1");

      await initStateFirst();

      assert.strictEqual(getState().debug.debugLog, true);
    });

    it("keeps debug flag off when DEBUG is not set", async () => {
      await initStateFirst();

      assert.strictEqual(getState().debug.debugLog, false);
    });

    it("reads each config file once and reuses the same read for parsing", async () => {
      const globalConfigStr = JSON.stringify({ ...testConfig });
      testFs._files.set(getGlobalConfigPath(), globalConfigStr);
      const localConfigStr = JSON.stringify({ promptPrefix: ">>> " });
      testFs._files.set(getLocalConfigPath(), localConfigStr);

      let globalReads = 0;
      let localReads = 0;
      mock.method(fsDeps, "readFile", async (path: string) => {
        if (path === getGlobalConfigPath()) globalReads += 1;
        if (path === getLocalConfigPath()) localReads += 1;
        return testFs.readFile(path, "utf8");
      });

      const { globalConfig, localConfig } = await initStateFirst();

      assert.strictEqual(globalReads, 1);
      assert.strictEqual(localReads, 1);
      assert.strictEqual(getState().content.globalConfigStr, globalConfigStr);
      assert.strictEqual(getState().content.localConfigStr, localConfigStr);
      assert.strictEqual(globalConfig.model, testConfig.model);
      assert.strictEqual(localConfig.promptPrefix, ">>> ");
    });

    it("prints the error and returns the default config when the config file cannot be checked", async () => {
      testFs._files.set(getGlobalConfigPath(), "model: gpt-4");
      mock.method(fsDeps, "existsSync", () => {
        throw makeErrnoError("EACCES");
      });
      const writes = mockStdoutWrites();

      const globalConfigStr = await readConfigFileStr(getGlobalConfigPath());

      assert.strictEqual(globalConfigStr, "{}");
      assert.deepStrictEqual(writes(), [
        `${RED}Failed to check if ${getGlobalConfigPath()} exists. Error: EACCES${RESET}\n`,
      ]);
      assert.deepStrictEqual(getState().content.configWarningMessages, []);
    });

    it("warns when reading an existing config file fails", async () => {
      testFs._files.set(getGlobalConfigPath(), "model: gpt-4");
      mock.method(fsDeps, "readFile", () =>
        Promise.reject(new Error("read failed")),
      );
      const writes = mockStdoutWrites();

      const globalConfigStr = await readConfigFileStr(getGlobalConfigPath());

      assert.strictEqual(globalConfigStr, "{}");
      assert.deepStrictEqual(writes(), []);
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "Failed to read the config file at `/fake-home/.config/lasso/settings.yaml`, using the default config. Error: read failed",
      ]);
    });
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

      assert.strictEqual(promptDeps.getToolsContentStr(), stringifyTools());
    });
  });

  describe("blockOnMissingConfig", () => {
    beforeEach(() => {
      setupTestContext({ model: "claude-sonnet-4-20250514" });
      actions.setBaseURL("https://api.anthropic.com");
    });

    it("returns false and prints nothing when there are no config error messages", () => {
      const getWrites = mockStdoutWrites();
      assert.strictEqual(blockOnMissingConfig(), false);
      assert.deepStrictEqual(getWrites(), []);
    });

    it("prints the config error messages and returns true when there are config error messages", () => {
      actions.appendConfigErrorMessage("Set `model` in your config file");
      actions.appendConfigErrorMessage(
        "Set the `LASSO_API_KEY` environment variable, e.g. `export LASSO_API_KEY=...`",
      );
      const getWrites = mockStdoutWrites();
      assert.strictEqual(blockOnMissingConfig(), true);
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${RED}Errors:${RESET}\n`,
        `${RED}- Set \`model\` in your config file\n- Set the \`LASSO_API_KEY\` environment variable, e.g. \`export LASSO_API_KEY=...\`${RESET}\n`,
        "\n",
      ]);
    });

    it("prints the init command hint when includeConfigInitMessage is true", () => {
      actions.appendConfigErrorMessage("Set `model` in your config file");
      actions.setIncludeConfigInitMessage(true);
      const getWrites = mockStdoutWrites();
      assert.strictEqual(blockOnMissingConfig(), true);
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${RED}Errors:${RESET}\n`,
        `${RED}- Set \`model\` in your config file${RESET}\n`,
        "\n",
        `${RED}Run /initlocal or /initglobal to generate a sample config in \`./.lasso\` or \`~/.config/lasso\` respectively.${RESET}\n`,
        "\n",
      ]);
    });
  });
});

describe("temp-file", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  describe("getTempFileName", () => {
    it("returns temp file path without initial content", async () => {
      const result = await getTempFileName();
      assert.equal(result, "/tmp/lasso-test-uuid.txt");
    });

    it("copies initial content when initialContentPath is provided", async () => {
      testFs._files.set("/source/file.txt", "initial content");
      const result = await getTempFileName({
        initialContentPath: "/source/file.txt",
      });
      assert.equal(result, "/tmp/lasso-test-uuid.txt");
      assert.equal(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        "initial content",
      );
    });

    it("creates an empty temp file when the initial content path does not exist", async () => {
      const result = await getTempFileName({
        initialContentPath: "/missing/file.txt",
      });
      assert.equal(result, "/tmp/lasso-test-uuid.txt");
      assert.equal(testFs._files.get("/tmp/lasso-test-uuid.txt"), "");
    });

    it("returns null when reading an existing path fails", async () => {
      testFs._files.set("/source/file.txt", "initial content");
      mock.method(fsDeps, "readFile", () => Promise.reject(new Error("EIO")));
      const result = await getTempFileName({
        initialContentPath: "/source/file.txt",
      });
      assert.equal(result, null);
      assert.equal(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
    });

    it("returns null when write fails", async () => {
      testFs._files.set("/source.txt", "content");
      mock.method(fsDeps, "writeFile", () => Promise.reject(new Error("EIO")));
      const result = await getTempFileName({
        initialContentPath: "/source.txt",
      });
      assert.equal(result, null);

      const strResult = await getTempFileName({ initialContentStr: "content" });
      assert.equal(strResult, null);

      const noArgsResult = await getTempFileName();
      assert.equal(noArgsResult, null);
    });

    it("writes initialContentStr into the temp file", async () => {
      const result = await getTempFileName({
        initialContentStr: "string content",
      });
      assert.equal(result, "/tmp/lasso-test-uuid.txt");
      assert.equal(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        "string content",
      );
    });

    it("uses the extension in the temp file path", async () => {
      const result = await getTempFileName({ extension: "wav" });
      assert.equal(result, "/tmp/lasso-test-uuid.wav");
    });

    it("uses the path prefix in the temp file path", async () => {
      const result = await getTempFileName({
        pathPrefix: "lasso-local",
        initialContentStr: "local content",
      });
      assert.equal(result, "/tmp/lasso-local-test-uuid.txt");
      assert.equal(
        testFs._files.get("/tmp/lasso-local-test-uuid.txt"),
        "local content",
      );
    });

    it("throws when both initialContentPath and initialContentStr are provided", async () => {
      await assert.rejects(
        () =>
          getTempFileName({
            initialContentPath: "/source/file.txt",
            initialContentStr: "string content",
          }),
        /falsy value/,
      );
    });
    it("prints the error when checking the initial content path fails", async () => {
      mock.method(fsDeps, "existsSync", () => {
        throw new Error("EACCES");
      });
      const writes = mockStdoutWrites();
      const result = await getTempFileName({
        initialContentPath: "/source/file.txt",
      });
      assert.equal(result, null);
      assert.deepStrictEqual(writes(), [
        `${RED}Failed to create a temp file with content from path /source/file.txt. Error: EACCES${RESET}\n`,
      ]);
    });

    it("prints the error when reading the initial content fails", async () => {
      testFs._files.set("/source/file.txt", "initial content");
      mock.method(fsDeps, "readFile", () => Promise.reject(new Error("EIO")));
      const writes = mockStdoutWrites();
      const result = await getTempFileName({
        initialContentPath: "/source/file.txt",
      });
      assert.equal(result, null);
      assert.deepStrictEqual(writes(), [
        `${RED}Failed to read the content from path /source/file.txt to prepopulate a temp file. Error: EIO${RESET}\n`,
      ]);
    });

    it("prints the error when writing the initial content path fails", async () => {
      testFs._files.set("/source/file.txt", "initial content");
      mock.method(fsDeps, "writeFile", () =>
        Promise.reject(new Error("ENOSPC")),
      );
      const writes = mockStdoutWrites();
      const result = await getTempFileName({
        initialContentPath: "/source/file.txt",
      });
      assert.equal(result, null);
      assert.deepStrictEqual(writes(), [
        `${RED}Failed to write a temp file with the content from path /source/file.txt: ENOSPC${RESET}\n`,
      ]);
    });

    it("prints the error when the temp file cannot be created", async () => {
      mock.method(fsDeps, "writeFile", () => Promise.reject(new Error("EIO")));
      const writes = mockStdoutWrites();
      const result = await getTempFileName({ initialContentStr: "content" });
      assert.equal(result, null);
      assert.deepStrictEqual(writes(), [
        `${RED}Failed to write to a temp file. Error: EIO${RESET}\n`,
      ]);
    });

    it("prints the error when the empty temp file for a missing path cannot be created", async () => {
      mock.method(fsDeps, "writeFile", () => Promise.reject(new Error("EIO")));
      const writes = mockStdoutWrites();
      const result = await getTempFileName({
        initialContentPath: "/missing/file.txt",
      });
      assert.equal(result, null);
      assert.deepStrictEqual(writes(), [
        `${RED}Failed to write an empty temp file. Error: EIO${RESET}\n`,
      ]);
    });

    it("prints the error when no initial content is given and the temp file cannot be created", async () => {
      mock.method(fsDeps, "writeFile", () => Promise.reject(new Error("EIO")));
      const writes = mockStdoutWrites();
      const result = await getTempFileName();
      assert.equal(result, null);
      assert.deepStrictEqual(writes(), [
        `${RED}Failed to create an empty temp file. Error: EIO${RESET}\n`,
      ]);
    });
  });
});

async function resolveInterruptWithAnswer(answer: string) {
  actions.setEditorInputValue("queued input");
  actions.setRl(makeFakeRl({ question: () => Promise.resolve(answer) }));
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
    actions.setKeymaps({
      ...defaultConfig.keymaps,
      edit: { name: "e", ctrl: true },
    });
    actions.setRl(
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
    actions.setRl(
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
    actions.setRl(
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
