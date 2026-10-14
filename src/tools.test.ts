import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { actions } from "./state.ts";
import { getWebpagesDir } from "./paths.ts";
import { getSubagentPrompt } from "./prompts.ts";
import { safeStringify, stringify } from "./utils.ts";
import {
  createSubagentTaskSchema,
  createSubagentTool,
  harnessTools,
  print,
  stringifyTools,
  toolPrint,
} from "./app.ts";
import {
  timeoutSettings,
  bashToolInputSchema,
  executeBashTool,
  executeMcpListResourcesTool,
  executeMcpReadResourceTool,
  executeReadImageTool,
  executeWebFetchHtmlTool as executeWebFetchHtmlToolImpl,
  executeWebFetchJsonTool as executeWebFetchJsonToolImpl,
  loadSkillTool,
} from "./tools.ts";
import { childProcessDeps, fsDeps, processDeps } from "./deps.ts";
import {
  BLUE,
  BOLD,
  BOLD_RESET,
  GREY,
  RESET,
  setupTestContext,
  testFs,
  mockExec,
  mockStdoutWrites,
  makeGenerateTextResult,
  mockGenerateText,
  makeMcpTool,
  makeFakeMcpClient,
  setMcpClients,
  makeFakeFetch,
  mockExecRecordingOptions,
} from "./test-helpers.ts";

const toolOutput = {
  toolPrint,
  printDoing: (text: string) => print.doing(text),
};

function executeWebFetchHtmlTool(
  input: Parameters<typeof executeWebFetchHtmlToolImpl>[0],
  signal?: AbortSignal,
) {
  return executeWebFetchHtmlToolImpl(input, signal, toolOutput);
}

function executeWebFetchJsonTool(
  input: Parameters<typeof executeWebFetchJsonToolImpl>[0],
  signal?: AbortSignal,
) {
  return executeWebFetchJsonToolImpl(input, signal, toolOutput);
}

describe("tool timeout settings", () => {
  it("sets explicit timeouts for each tool except create_subagent", () => {
    assert.deepStrictEqual(timeoutSettings, {
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
});

describe("mcp resource tools", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
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
        isError: false,
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
        isError: false,
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

    it("returns a timeout error instead of rethrowing an abort", async () => {
      const controller = new AbortController();
      const bashPromise = Object.assign(
        Promise.reject(
          new DOMException("This operation was aborted", "AbortError"),
        ),
        { child: { stdin: null } },
      );
      mock.method(childProcessDeps, "exec", () => bashPromise);
      controller.abort(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      );

      const result = await executeBashTool(
        { fileSystemAccessType: "read", command: "slow command" },
        controller.signal,
      );

      assert.deepStrictEqual(result, {
        isError: true,
        content: "The operation was aborted due to timeout",
      });
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
    it("returns sanitized markdown on success", async () => {
      mock.method(
        globalThis,
        "fetch",
        makeFakeFetch({
          text: "<p>Article content</p><hr><script>ignored()</script>",
        }),
      );

      const result = await executeWebFetchHtmlTool({
        href: "https://example.com/article",
      });
      assert.deepStrictEqual(result, {
        isError: false,
        content: "Article content\n\n---",
        type: "inline-markdown",
      });
    });

    it("rejects invalid URLs without making a request", async () => {
      const fetchMock = mock.method(globalThis, "fetch", makeFakeFetch());
      const result = await executeWebFetchHtmlTool({ href: "not a URL" });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "Cannot parse href not a URL as a URL",
      });
      assert.strictEqual(fetchMock.mock.callCount(), 0);
    });

    it("writes oversized markdown after creating the webpages directory", async () => {
      const getWrites = mockStdoutWrites();
      mock.method(processDeps.stdout, "getColumns", () => 180);
      const html = `<p>${"x".repeat(30_004)}</p>`;
      mock.method(globalThis, "fetch", makeFakeFetch({ text: html }));

      const result = await executeWebFetchHtmlTool({
        href: "https://example.com/large",
      });
      const filePath =
        "/fake-home/.local/state/lasso/webpages/example-com-large-0.md";
      assert.deepStrictEqual(result, {
        isError: false,
        content:
          "The page contains approximately 10,001 tokens. Its Markdown has been saved to `/fake-home/.local/state/lasso/webpages/example-com-large-0.md` rather than included in this response. Use the `bash` tool to search the file or read selected lines.",
        filePath,
        type: "file-path",
      });
      assert.strictEqual(testFs._dirs.has(getWebpagesDir()), true);
      assert.strictEqual(testFs._files.get(filePath)?.length, 30_004);
      assert.deepStrictEqual(getWrites(), [
        `${BLUE}${BOLD}web_fetch_html${BOLD_RESET}: Webpage markdown written to ${filePath} because it exceeded 10,000 tokens${RESET}\n`,
      ]);
    });

    it("returns an error when creating the webpages directory fails", async () => {
      const html = `<p>${"x".repeat(30_004)}</p>`;
      mock.method(globalThis, "fetch", makeFakeFetch({ text: html }));
      mock.method(fsDeps, "mkdir", () =>
        Promise.reject(new Error("mkdir failed")),
      );

      const result = await executeWebFetchHtmlTool({
        href: "https://example.com/large",
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content:
          "Error while creating the local webpages directory. Error: mkdir failed",
      });
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

    it("returns isError when response is not ok and includes the URL", async () => {
      const getWrites = mockStdoutWrites();
      mock.method(processDeps.stdout, "getColumns", () => 180);
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
        content:
          "HTTP 500: Internal Server Error when fetching https://example.com/broken",
      });
      assert.deepStrictEqual(getWrites(), [
        `${BLUE}${BOLD}web_fetch_html${BOLD_RESET}: HTTP 500: Internal Server Error when fetching https://example.com/broken${RESET}\n`,
        `${BLUE}HTTP 500: Internal Server Error when fetching https://example.com/broken${RESET}\n`,
      ]);
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
        isError: false,
      });
    });

    it("rejects invalid URLs without making a request", async () => {
      const fetchMock = mock.method(globalThis, "fetch", makeFakeFetch());
      const result = await executeWebFetchJsonTool({ href: "not a URL" });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "Cannot parse href not a URL as a URL",
      });
      assert.strictEqual(fetchMock.mock.callCount(), 0);
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

    it("returns isError when response is not ok and includes the URL", async () => {
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
        content:
          "HTTP 404: Not Found when fetching https://api.example.com/missing",
      });
    });

    it("returns isError when JSON parsing fails", async () => {
      const fakeFetch = () =>
        Promise.resolve({
          ok: true,
          json: () => Promise.reject(new Error("Invalid JSON")),
        } as Response);
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
        isError: false,
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
            content: "result-1",
            isError: false,
          },
          {
            content: "result-2",
            isError: false,
          },
        ]);
        const firstCall = calls[0];
        assert(firstCall !== undefined);
        assert.strictEqual(firstCall["timeout"], timeoutSettings);

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
          {
            content: "done",
            isError: false,
          },
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
          `${getSubagentPrompt("read-only", {})}

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
          {
            content: "ok",
            isError: false,
          },
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
          {
            content: "ok",
            isError: false,
          },
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
            isError: true,
            content: "subagent failed",
          },
          {
            content: "ok",
            isError: false,
          },
        ]);
      });

      it("returns a timeout error when a subagent times out", async () => {
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
            isError: true,
            content: "The operation was aborted due to timeout",
          },
        ]);
      });

      it("returns an error when a subagent is aborted by a timeout", async () => {
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
                prompt: "inspect timeout",
                access: "read-only",
                model: "slow-model",
              },
            ],
          },
          controller.signal,
        );
        await generateTextCalledPromise;
        controller.abort(
          new DOMException(
            "The operation was aborted due to timeout",
            "TimeoutError",
          ),
        );

        const result = await resultPromise;
        assert.deepStrictEqual(JSON.parse(result.content), [
          {
            isError: true,
            content: "The operation was aborted due to timeout",
          },
        ]);
        assert.strictEqual(result.isError, true);
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
