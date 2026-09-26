import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { getEventListeners } from "node:events";
import { z } from "zod";
import {
  bashToolInputSchema,
  executeBashTool,
  executeWebFetchHtmlTool,
  executeWebFetchJsonTool,
  loadSkillTool,
  createSubagentTool,
  createSubagentTaskSchema,
  harnessTools,
  toolPrint,
} from "./tools.ts";
import {
  testFs,
  setupTestContext,
  mockExec,
  mockGenerateText,
  stripAnsi,
  mockStdout,
  makeGenerateTextResult,
  makeMcpTool,
} from "./test-helpers.ts";
import { processDeps } from "./deps.ts";
import { actions } from "./state.ts";
import { getSubagentPrompt } from "./prompts.ts";

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
    it("prints the detail with a labeled prefix on the first line", () => {
      mock.method(processDeps.stdout, "getColumns", () => 30);
      const getCaptured = mockStdout();
      toolPrint("bash", "hello");
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `bash: hello
`,
      );
    });

    it("wraps a detail that does not fit within maxLen", () => {
      mock.method(processDeps.stdout, "getColumns", () => 30);
      const getCaptured = mockStdout();
      toolPrint("bash", "abcdefghijklmnopqrstuvwxyz");
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `bash: abcdefghijklmnopqrstuvwx
       ┊yz
`,
      );
    });

    it("ignores empty detail lines", () => {
      mock.method(processDeps.stdout, "getColumns", () => 30);
      const getCaptured = mockStdout();
      toolPrint("bash", "one\n\ntwo");
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `bash: one
       ┊two
`,
      );
    });

    it("caps the total output at five lines", () => {
      mock.method(processDeps.stdout, "getColumns", () => 30);
      const getCaptured = mockStdout();
      toolPrint("bash", "a\nb\nc\nd\ne\nf");
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `bash: a
       ┊b
       ┊c
       ┊d
       ┊e…
`,
      );
    });

    it("does not wrap a detail that fits within the cap", () => {
      mock.method(processDeps.stdout, "getColumns", () => 30);
      const getCaptured = mockStdout();
      toolPrint("bash", "abcd");
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `bash: abcd
`,
      );
    });

    it("wraps without regard to whitespace inside the detail", () => {
      mock.method(processDeps.stdout, "getColumns", () => 30);
      const getCaptured = mockStdout();
      toolPrint("bash", "abc defghijklmnop");
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `bash: abc defghijklmnop
`,
      );
    });

    it("wraps multiple original lines and combines them under the same cap", () => {
      mock.method(processDeps.stdout, "getColumns", () => 30);
      const getCaptured = mockStdout();
      toolPrint("bash", "abcdefghij\nkl");
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `bash: abcdefghij
       ┊kl
`,
      );
    });

    it("stops mid-wrap once the five line cap is reached, ending with an ellipsis", () => {
      mock.method(processDeps.stdout, "getColumns", () => 30);
      const getCaptured = mockStdout();
      toolPrint("bash", "abcdefghij\nkl\nm\nn\no\np");
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `bash: abcdefghij
       ┊kl
       ┊m
       ┊n
       ┊o…
`,
      );
    });

    it("replaces the last char of a full fifth line with an ellipsis", () => {
      mock.method(processDeps.stdout, "getColumns", () => 30);
      const getCaptured = mockStdout();
      toolPrint("bash", "a".repeat(113));
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `bash: ${"a".repeat(24)}
       ┊${"a".repeat(22)}
       ┊${"a".repeat(22)}
       ┊${"a".repeat(22)}
       ┊${"a".repeat(21)}…
`,
      );
    });

    it("uses label length plus padding for the maxLen when it exceeds the indent", () => {
      mock.method(processDeps.stdout, "getColumns", () => 40);
      const getCaptured = mockStdout();
      toolPrint("abcdefghijklmnopqrst", "abcdefghijklmnopqrstuvwx");
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `abcdefghijklmnopqrst: abcdefghijklmnopqr
       ┊stuvwx
`,
      );
    });

    it("prints nothing but the label prefix when detail is only whitespace lines", () => {
      mock.method(processDeps.stdout, "getColumns", () => 30);
      const getCaptured = mockStdout();
      toolPrint("bash", "\n\n\n");
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `
`,
      );
    });

    it("falls back to one char per line when the terminal is narrower than the label", () => {
      mock.method(processDeps.stdout, "getColumns", () => 5);
      const getCaptured = mockStdout();
      toolPrint("bash", "abcdefghijklmnopqrstuvwxyz");
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `bash: a
       ┊b
       ┊c
       ┊d
       ┊…
`,
      );
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
  });

  function makeHangingFetch() {
    let onFetchCalled: () => void = () => undefined;
    const fetchCalledPromise = new Promise<void>((resolve) => {
      onFetchCalled = resolve;
    });
    const fakeFetch = (_input: unknown, init?: { signal: AbortSignal }) => {
      onFetchCalled();
      return new Promise<Response>((_resolve, reject) => {
        const abortError = new DOMException(
          "This operation was aborted",
          "AbortError",
        );
        if (init?.signal.aborted === true) {
          reject(abortError);
          return;
        }
        init?.signal.addEventListener("abort", () => {
          reject(abortError);
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
      const fakeFetch = () => {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(html),
        } as Response);
      };
      mock.method(globalThis, "fetch", fakeFetch);

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

    it("returns isError when fetch throws", async () => {
      const fakeFetch = () => {
        return Promise.reject(new Error("network error"));
      };
      mock.method(globalThis, "fetch", fakeFetch);

      const result = await executeWebFetchHtmlTool({
        href: "https://example.com/fail",
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "network error",
      });
    });

    it("returns isError when response is not ok", async () => {
      const fakeFetch = () => {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: () => Promise.resolve("server error"),
        } as Response);
      };
      mock.method(globalThis, "fetch", fakeFetch);

      const result = await executeWebFetchHtmlTool({
        href: "https://example.com/broken",
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "HTTP 500: Internal Server Error",
      });
    });

    it("returns isError when the request times out", async () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      const { fakeFetch, fetchCalledPromise } = makeHangingFetch();
      mock.method(globalThis, "fetch", fakeFetch);

      const resultPromise = executeWebFetchHtmlTool({
        href: "https://example.com/slow",
      });
      // await for fetch to have been called
      await fetchCalledPromise;
      mock.timers.tick(10_000);
      const result = await resultPromise;
      assert.deepStrictEqual(result, {
        isError: true,
        content: "Request to https://example.com/slow timed out after 10s",
      });
      mock.timers.reset();
    });

    it("rethrows when aborted by the caller and removes the abort listener", async () => {
      const controller = new AbortController();
      const { fakeFetch } = makeHangingFetch();
      mock.method(globalThis, "fetch", fakeFetch);

      const resultPromise = executeWebFetchHtmlTool(
        { href: "https://example.com/slow" },
        controller.signal,
      );
      controller.abort();
      await assert.rejects(resultPromise, { name: "AbortError" });
      assert.deepStrictEqual(getEventListeners(controller.signal, "abort"), []);
    });
  });

  describe("executeWebFetchJsonTool", () => {
    it("returns parsed JSON content on success", async () => {
      const jsonData = { name: "test", value: 42 };
      const fakeFetch = () => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(jsonData),
        } as Response);
      };
      mock.method(globalThis, "fetch", fakeFetch);

      const result = await executeWebFetchJsonTool({
        href: "https://api.example.com/data",
      });
      assert.deepStrictEqual(result, {
        content: JSON.stringify(jsonData, null, 2),
      });
    });

    it("returns isError when fetch throws", async () => {
      const fakeFetch = () => {
        return Promise.reject(new Error("network error"));
      };
      mock.method(globalThis, "fetch", fakeFetch);

      const result = await executeWebFetchJsonTool({
        href: "https://api.example.com/fail",
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "network error",
      });
    });

    it("returns isError when response is not ok", async () => {
      const fakeFetch = () => {
        return Promise.resolve({
          ok: false,
          status: 404,
          statusText: "Not Found",
        } as Response);
      };
      mock.method(globalThis, "fetch", fakeFetch);

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
      mock.timers.enable({ apis: ["setTimeout"] });
      const { fakeFetch, fetchCalledPromise } = makeHangingFetch();
      mock.method(globalThis, "fetch", fakeFetch);

      try {
        const resultPromise = executeWebFetchJsonTool({
          href: "https://api.example.com/slow",
        });
        await fetchCalledPromise;
        mock.timers.tick(10_000);
        const result = await resultPromise;
        assert.deepStrictEqual(result, {
          isError: true,
          content:
            "Request to https://api.example.com/slow timed out after 10s",
        });
      } finally {
        mock.timers.reset();
      }
    });
  });

  describe("TOOLS", () => {
    it("registers tools under the names referenced by the system prompt", () => {
      assert.deepStrictEqual(Object.keys(harnessTools), [
        "web_fetch_html",
        "web_fetch_json",
        "load_skill",
        "bash",
        "create_subagent",
      ]);
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
      ]);
      assert.strictEqual(firstMessage.role, "user");
    });

    it("gives read-write subagents write tools and prints file diffs", async () => {
      const mcpTool = makeMcpTool();
      actions.setMcp({}, { mcp_tool: mcpTool });
      const getCaptured = mockStdout();
      testFs._files.set("/test/file.txt", "original content");
      mockGenerateText(async (options: Record<string, unknown>) => {
        const writeTools = options["tools"];
        assert(writeTools !== undefined && writeTools !== null);
        assert.deepStrictEqual(Object.keys(writeTools), [
          "web_fetch_html",
          "web_fetch_json",
          "load_skill",
          "bash",
          "mcp_tool",
        ]);
        const onStart = options["onToolExecutionStart"] as (
          arg: Record<string, unknown>,
        ) => void;
        const onFinish = options["onToolExecutionEnd"] as (
          arg: Record<string, unknown>,
        ) => Promise<void>;
        assert.strictEqual(typeof onStart, "function");
        assert.strictEqual(typeof onFinish, "function");
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
        tasks: [{ prompt: "edit", access: "read-write", model: "main-model" }],
      });

      assert.deepStrictEqual(JSON.parse(result.content), [
        { model: "main-model", prompt: "edit", content: "done" },
      ]);
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `
━━ File change: /test/file.txt ━━
+modified content

`,
      );
    });

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
      mock.timers.enable({ apis: ["setTimeout"] });
      let onGenerateTextCalled: () => void = () => undefined;
      const generateTextCalledPromise = new Promise<void>((resolve) => {
        onGenerateTextCalled = resolve;
      });
      mockGenerateText((options: { abortSignal?: AbortSignal }) => {
        onGenerateTextCalled();
        return new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener("abort", () => {
            reject(
              new DOMException("This operation was aborted", "AbortError"),
            );
          });
        });
      });

      try {
        const resultPromise = createSubagentTool({
          tasks: [
            {
              prompt: "inspect timeout",
              access: "read-only",
              model: "slow-model",
              timeout: 1_000,
            },
          ],
        });
        await generateTextCalledPromise;
        mock.timers.tick(1_000);
        const result = await resultPromise;
        assert.strictEqual(result.isError, true);
        assert.deepStrictEqual(JSON.parse(result.content), [
          {
            model: "slow-model",
            prompt: "inspect timeout",
            isError: true,
            content: "Subagent timed out after 1s",
          },
        ]);
      } finally {
        mock.timers.reset();
      }
    });

    it("rethrows when aborted by the caller and removes the abort listener", async () => {
      const controller = new AbortController();
      let onGenerateTextCalled: () => void = () => undefined;
      const generateTextCalledPromise = new Promise<void>((resolve) => {
        onGenerateTextCalled = resolve;
      });
      mockGenerateText((options: { abortSignal?: AbortSignal }) => {
        onGenerateTextCalled();
        return new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener("abort", () => {
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
      assert.deepStrictEqual(getEventListeners(controller.signal, "abort"), []);
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
        `${getSubagentPrompt("read-only")}

ctx body

skills body`,
      );
    });
  });
});
