import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { getEventListeners } from "node:events";
import {
  executeBashTool,
  executeCreateFileTool,
  executeViewFileTool,
  executeStrReplaceTool,
  executeInsertLinesTool,
  executeWebFetchHtmlTool,
  executeWebFetchJsonTool,
  loadSkillTool,
  createSubagentTool,
  createSubagentTaskSchema,
  printGitDiff,
  harnessTools,
  toolPrint,
} from "./tools.ts";
import {
  testFs,
  setupTestContext,
  setupApiCallState,
  mockExec,
  mockGenerateText,
  stripAnsi,
  mockStdout,
  makeGenerateTextResult,
  makeMcpTool,
} from "./test-helpers.ts";
import { fsDeps, processDeps } from "./deps.ts";
import { actions } from "./state.ts";

describe("tools", () => {
  beforeEach(() => {
    setupTestContext();
  });

  afterEach(() => {
    mock.restoreAll();
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
        `bash: abcdefghijklmnopqrstuv
       ┊wxyz
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

    it("caps the total output at four lines", () => {
      mock.method(processDeps.stdout, "getColumns", () => 30);
      const getCaptured = mockStdout();
      toolPrint("bash", "a\nb\nc\nd\ne");
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `bash: a
       ┊b
       ┊c
       ┊d
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

    it("stops mid-wrap once the four line cap is reached", () => {
      mock.method(processDeps.stdout, "getColumns", () => 30);
      const getCaptured = mockStdout();
      toolPrint("bash", "abcdefghij\nkl\nm\nn\no");
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `bash: abcdefghij
       ┊kl
       ┊m
       ┊n
`,
      );
    });

    it("caps a long single detail at four full lines", () => {
      mock.method(processDeps.stdout, "getColumns", () => 30);
      const getCaptured = mockStdout();
      toolPrint("bash", "a".repeat(91));
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `bash: ${"a".repeat(22)}
       ┊${"a".repeat(22)}
       ┊${"a".repeat(22)}
       ┊${"a".repeat(22)}
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
  });

  describe("executeBashTool", () => {
    it("returns a successful tool_result with stdout/stderr JSON", async () => {
      const result = await executeBashTool(
        { command: "echo hello" },
        undefined,
      );
      assert.deepStrictEqual(result, {
        content: JSON.stringify({ stdout: "hello\n", stderr: "" }),
      });
    });

    it("captures stderr in the JSON payload", async () => {
      const result = await executeBashTool(
        { command: "echo error >&2" },
        undefined,
      );
      assert.deepStrictEqual(result, {
        content: JSON.stringify({ stdout: "", stderr: "error\n" }),
      });
    });

    it("returns isError when command exits with non-zero code", async () => {
      const result = await executeBashTool({ command: "exit 1" }, undefined);
      assert.strictEqual(result.isError, true);
      assert.match(result.content, /Command failed: exit 1/);
    });
  });

  describe("executeCreateFileTool", () => {
    it("creates a new file and returns success", () => {
      const result = executeCreateFileTool(
        { content: "hello world", path: "/test/new.txt" },
        undefined,
      );
      assert.deepStrictEqual(result, {
        content: `/test/new.txt created successfully`,
      });
      assert.equal(testFs._files.get("/test/new.txt"), "hello world");
    });

    it("returns isError when the file already exists", () => {
      testFs._files.set("/test/existing.txt", "already here");
      const result = executeCreateFileTool(
        { content: "new content", path: "/test/existing.txt" },
        undefined,
      );
      assert.deepStrictEqual(result, {
        isError: true,
        content: `/test/existing.txt already exists`,
      });
    });

    it("returns isError when write fails", () => {
      mock.method(fsDeps, "writeFileSync", () => {
        throw new Error("EIO");
      });
      const result = executeCreateFileTool(
        { content: "x", path: "/test/file.txt" },
        undefined,
      );
      assert.deepStrictEqual(result, {
        isError: true,
        content: "EIO",
      });
    });
  });

  describe("executeViewFileTool", () => {
    it("returns file contents with line numbers", () => {
      testFs._files.set("/test/lines.txt", "aaa\nbbb\nccc");
      const result = executeViewFileTool({ path: "/test/lines.txt" });
      assert.deepStrictEqual(result, {
        content: `1\taaa
2\tbbb
3\tccc`,
      });
    });

    it("returns a slice when start_line and end_line are specified", () => {
      testFs._files.set("/test/lines.txt", "line1\nline2\nline3\nline4\nline5");
      const result = executeViewFileTool({
        path: "/test/lines.txt",
        start_line: 2,
        end_line: 4,
      });
      assert.deepStrictEqual(result, {
        content: `2\tline2
3\tline3
4\tline4`,
      });
    });

    it("treats end_line=-1 as end of file", () => {
      testFs._files.set("/test/lines.txt", "a\nb\nc");
      const result = executeViewFileTool({
        path: "/test/lines.txt",
        start_line: 2,
        end_line: -1,
      });
      assert.deepStrictEqual(result, {
        content: `2\tb
3\tc`,
      });
    });

    it("lists directory contents for a directory path", () => {
      testFs._dirs.add("/test/dir");
      testFs._files.set("/test/dir/alpha.txt", "");
      testFs._files.set("/test/dir/beta.txt", "");
      const result = executeViewFileTool({ path: "/test/dir" });
      assert.deepStrictEqual(result, {
        content: `alpha.txt
beta.txt`,
      });
    });

    it("returns isError for a nonexistent path", () => {
      const result = executeViewFileTool({
        path: "/no/such/path/file.txt",
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "ENOENT: /no/such/path/file.txt",
      });
    });

    it("returns isError when start_line is less than 1", () => {
      testFs._files.set("/test/lines.txt", "line1\nline2\nline3");
      const result = executeViewFileTool({
        path: "/test/lines.txt",
        start_line: 0,
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "start_line must be at least 1, got 0",
      });
    });

    it("returns isError when end_line is less than 1 (and not -1)", () => {
      testFs._files.set("/test/lines.txt", "line1\nline2\nline3");
      const result = executeViewFileTool({
        path: "/test/lines.txt",
        end_line: 0,
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "end_line must be at least 1 or -1, got 0",
      });
    });

    it("returns isError when start_line is past end of file", () => {
      testFs._files.set("/test/lines.txt", "line1\nline2");
      const result = executeViewFileTool({
        path: "/test/lines.txt",
        start_line: 5,
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "start_line 5 is past end of file (file has 2 lines)",
      });
    });

    it("returns isError when end_line is past end of file", () => {
      testFs._files.set("/test/lines.txt", "line1\nline2");
      const result = executeViewFileTool({
        path: "/test/lines.txt",
        end_line: 10,
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "end_line 10 is past end of file (file has 2 lines)",
      });
    });

    it("returns isError when start_line is greater than or equal to end_line", () => {
      testFs._files.set("/test/lines.txt", "line1\nline2\nline3");
      const result = executeViewFileTool({
        path: "/test/lines.txt",
        start_line: 3,
        end_line: 2,
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "start_line (3) must be less than end_line (2)",
      });
    });

    it("returns single line when start_line equals end_line", () => {
      testFs._files.set("/test/lines.txt", "line1\nline2\nline3");
      const result = executeViewFileTool({
        path: "/test/lines.txt",
        start_line: 2,
        end_line: 2,
      });
      assert.deepStrictEqual(result, {
        content: "2\tline2",
      });
    });
  });

  describe("executeStrReplaceTool", () => {
    it("replaces old_str with new_str when exactly one match exists", () => {
      testFs._files.set("/test/file.txt", "foo bar baz");
      const result = executeStrReplaceTool(
        { path: "/test/file.txt", old_str: "bar", new_str: "qux" },
        undefined,
      );
      assert.deepStrictEqual(result, {
        content: `/test/file.txt updated successfully`,
      });
      assert.equal(testFs._files.get("/test/file.txt"), "foo qux baz");
    });

    it("returns isError when old_str is not found", () => {
      testFs._files.set("/test/file.txt", "foo bar baz");
      const result = executeStrReplaceTool(
        { path: "/test/file.txt", old_str: "missing", new_str: "x" },
        undefined,
      );
      assert.deepStrictEqual(result, {
        isError: true,
        content: "old_str not found in file",
      });
    });

    it("returns isError when old_str matches more than once", () => {
      testFs._files.set("/test/file.txt", "aaa bbb aaa");
      const result = executeStrReplaceTool(
        { path: "/test/file.txt", old_str: "aaa", new_str: "x" },
        undefined,
      );
      assert.deepStrictEqual(result, {
        isError: true,
        content: "old_str matched 2 times — must match exactly once",
      });
    });

    it("returns isError when the file does not exist", () => {
      const result = executeStrReplaceTool(
        { path: "/no/such/path/file.txt", old_str: "a", new_str: "b" },
        undefined,
      );
      assert.deepStrictEqual(result, {
        isError: true,
        content: "ENOENT: /no/such/path/file.txt",
      });
    });
  });

  describe("executeInsertLinesTool", () => {
    it("inserts text after a specific line", () => {
      testFs._files.set("/test/file.txt", "line1\nline2\nline3");
      const result = executeInsertLinesTool(
        { path: "/test/file.txt", after_line: 2, content: "inserted" },
        undefined,
      );
      assert.deepStrictEqual(result, {
        content: `/test/file.txt updated successfully`,
      });
      assert.equal(
        testFs._files.get("/test/file.txt"),
        `line1
line2
inserted
line3`,
      );
    });

    it("inserts at the beginning when after_line is 0", () => {
      testFs._files.set("/test/file.txt", "line1\nline2");
      const result = executeInsertLinesTool(
        { path: "/test/file.txt", after_line: 0, content: "top" },
        undefined,
      );
      assert.deepStrictEqual(result, {
        content: `/test/file.txt updated successfully`,
      });
      assert.equal(
        testFs._files.get("/test/file.txt"),
        `top
line1
line2`,
      );
    });

    it("inserts at the end when after_line equals the number of lines", () => {
      testFs._files.set("/test/file.txt", "line1\nline2");
      const result = executeInsertLinesTool(
        { path: "/test/file.txt", after_line: 2, content: "bottom" },
        undefined,
      );
      assert.deepStrictEqual(result, {
        content: `/test/file.txt updated successfully`,
      });
      assert.equal(
        testFs._files.get("/test/file.txt"),
        `line1
line2
bottom`,
      );
    });

    it("returns isError when after_line is out of range (negative)", () => {
      testFs._files.set("/test/file.txt", "line1");
      const result = executeInsertLinesTool(
        { path: "/test/file.txt", after_line: -1, content: "x" },
        undefined,
      );
      assert.deepStrictEqual(result, {
        isError: true,
        content: `after_line -1 is out of range (file has 1 lines)`,
      });
    });

    it("returns isError when after_line is out of range (too large)", () => {
      testFs._files.set("/test/file.txt", "line1");
      const result = executeInsertLinesTool(
        { path: "/test/file.txt", after_line: 5, content: "x" },
        undefined,
      );
      assert.deepStrictEqual(result, {
        isError: true,
        content: `after_line 5 is out of range (file has 1 lines)`,
      });
    });

    it("returns isError when the file does not exist", () => {
      const result = executeInsertLinesTool(
        { path: "/no/such/path/file.txt", after_line: 0, content: "x" },
        undefined,
      );
      assert.deepStrictEqual(result, {
        isError: true,
        content: `ENOENT: /no/such/path/file.txt`,
      });
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
        "view_file",
        "load_skill",
        "create_file",
        "str_replace",
        "insert_lines",
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
      setupApiCallState();
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
        "view_file",
        "load_skill",
      ]);
      assert.strictEqual(firstMessage.role, "user");
    });

    it("gives read-write subagents write tools and prints file diffs", async () => {
      setupApiCallState();
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
          "view_file",
          "load_skill",
          "create_file",
          "str_replace",
          "insert_lines",
          "bash",
          "mcp_tool",
        ]);
        const onStart = options["experimental_onToolCallStart"] as (
          arg: Record<string, unknown>,
        ) => void;
        const onFinish = options["experimental_onToolCallFinish"] as (
          arg: Record<string, unknown>,
        ) => Promise<void>;
        onStart({
          toolCall: {
            toolName: "str_replace",
            toolCallId: "call-1",
            input: { path: "/test/file.txt" },
          },
        });
        testFs._files.set("/test/file.txt", "modified content");
        mockExec({ stdout: "+modified content" });
        await onFinish({
          toolCall: {
            toolName: "str_replace",
            toolCallId: "call-1",
            input: { path: "/test/file.txt" },
          },
          success: true,
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
        `   create_subagent: [main-model] edit

━━ File change: /test/file.txt ━━
+modified content

`,
      );
    });

    it("uses the configured model when a task model is omitted", async () => {
      setupApiCallState();
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
      setupApiCallState();
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
      setupApiCallState();
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
      setupApiCallState();
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
      setupApiCallState();
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
  });

  describe("printGitDiff", () => {
    it("prints diff with lines style", async () => {
      const getCaptured = mockStdout();
      mockExec({ stdout: "+added line" });
      await printGitDiff({
        tempFileBeforePath: "/tmp/before",
        tempFileAfterPath: "/tmp/after",
        path: "/test/file.txt",
      });
      assert.strictEqual(
        stripAnsi(getCaptured()),
        `
━━ File change: /test/file.txt ━━
+added line

`,
      );
    });

    it("prints an error when execGitDiff fails", async () => {
      const getCaptured = mockStdout();
      const err = new Error("fatal") as Error & { code: number };
      err.code = 128;
      mockExec({ stdout: "", error: err });
      await printGitDiff({
        tempFileBeforePath: "/tmp/before",
        tempFileAfterPath: "/tmp/after",
        path: "/test/file.txt",
      });
      assert.strictEqual(
        stripAnsi(getCaptured()),
        "An error occurred when getting the diff for /test/file.txt: fatal\n",
      );
    });

    it("does not print when execGitDiff returns empty stdout", async () => {
      const getCaptured = mockStdout();
      mockExec({ stdout: "" });
      await printGitDiff({
        tempFileBeforePath: "/tmp/before",
        tempFileAfterPath: "/tmp/after",
        path: "/test/file.txt",
      });
      assert.strictEqual(stripAnsi(getCaptured()), "");
    });
  });
});
