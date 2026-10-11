import { describe, it, afterEach, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  orApproxTokens,
  isAbortError,
  isNullish,
  isReadlineClosedError,
  tryCatch,
  safeStringify,
  strToApproxTokens,
  approxTokensToCharLen,
  tryCatchAsync,
  normalizeNewline,
  getMessageFromError,
  createQueue,
  getPrettyDuration,
  getPrettyDate,
  getDurationColor,
  shouldDisableColor,
  decimalToPercent,
  shellQuote,
  isShellSafePath,
  removeMediaReplacer,
} from "./utils.ts";
import { writeDebugLog, getStrFromAssistantContent } from "./app.ts";
import {
  testProcessEnv,
  setupTestContext,
  testFs,
  makeErrnoError,
  makeAbortError,
} from "./test-helpers.ts";
import { processDeps } from "./deps.ts";

describe("orApproxTokens", () => {
  it("returns the usage tokens when present", () => {
    assert.strictEqual(orApproxTokens(7, "one two three"), 7);
  });

  it("returns approx tokens from the text when usage is undefined", () => {
    assert.strictEqual(orApproxTokens(undefined, "abcdef"), 2);
  });
});

describe("debugLog", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  const path = "/fake-home/.config/lasso/debug-test-uuid.log";

  beforeEach(() => {
    setupTestContext({ now: 1_700_000_000_000 });
  });

  describe("does nothing", () => {
    it("does nothing when debugLog is disabled", async () => {
      await writeDebugLog(false, path, "test message");
      assert.equal(testFs._files.has(path), false);
    });

    it("does nothing when no debug log path is set", async () => {
      await writeDebugLog(true, "", "test message");
      assert.equal(testFs._files.has(""), false);
    });
  });

  describe("creates the directory", () => {
    it("creates directory when log file does not exist", async () => {
      await writeDebugLog(true, path, "test message");
      assert.equal(testFs._dirs.has("/fake-home/.config/lasso"), true);
    });

    it("skips mkdir when the directory already exists", async () => {
      const mkdirCalls: string[] = [];
      mock.method(testFs, "mkdir", (dir: string) => {
        mkdirCalls.push(dir);
        testFs._dirs.add(dir);
      });
      testFs._dirs.add("/fake-home/.config/lasso");

      await writeDebugLog(true, path, "test message");

      assert.deepEqual(mkdirCalls, []);
      assert.equal(
        testFs._files.get(path),
        "2023-11-14T22:13:20.000Z :: test message\n",
      );
    });
  });

  describe("appends messages", () => {
    it("appends content to log file with timestamp", async () => {
      await writeDebugLog(true, path, "test message");
      assert.equal(
        testFs._files.get(path),
        "2023-11-14T22:13:20.000Z :: test message\n",
      );
    });

    it("appends multiple messages", async () => {
      await writeDebugLog(true, path, "message 1");
      await writeDebugLog(true, path, "message 2");
      assert.equal(
        testFs._files.get(path),
        `2023-11-14T22:13:20.000Z :: message 1
2023-11-14T22:13:20.000Z :: message 2
`,
      );
    });
  });
});

describe("utils", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  describe("shouldDisableColor", () => {
    it("disables color when NO_COLOR is set", () => {
      testProcessEnv._set("NO_COLOR", "1");
      assert.equal(shouldDisableColor(), true);
    });

    it("disables color when stdout is not a tty", () => {
      mock.method(processDeps.stdout, "isTTY", () => false);
      assert.equal(shouldDisableColor(), true);
    });

    it("keeps color when stdout is a tty and NO_COLOR is unset", () => {
      assert.equal(shouldDisableColor(), false);
    });
  });

  describe("decimalToPercent", () => {
    it("scales decimals to a percent with two decimals by default", () => {
      assert.equal(decimalToPercent(0), "0%");
      assert.equal(decimalToPercent(0.5), "50%");
      assert.equal(decimalToPercent(1), "100%");
      assert.equal(decimalToPercent(1 / 6), "16.67%");
      assert.equal(decimalToPercent(1.5), "150%");
    });

    it("rounds to the configured precision", () => {
      assert.equal(decimalToPercent(1 / 6, { precision: 0 }), "17%");
      assert.equal(decimalToPercent(1 / 6, { precision: 3 }), "16.667%");
    });
  });

  describe("getStrFromAssistantContent", () => {
    it("returns string content unchanged", () => {
      assert.equal(getStrFromAssistantContent("response"), "response");
    });

    it("joins text content and excludes non-text content", () => {
      assert.equal(
        getStrFromAssistantContent([
          { type: "text", text: "first" },
          { type: "reasoning", text: "hidden reasoning" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "tool",
            input: {},
          },
          { type: "text", text: "second" },
        ]),
        "first\n\n\nsecond",
      );
    });

    it("retuns empty strings for unrecognised content types at runtime", () => {
      assert.equal(getStrFromAssistantContent([{ type: "wat" } as never]), "");
    });

    it("excludes tool-result and tool-approval-request content", () => {
      assert.equal(
        getStrFromAssistantContent([
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "tool",
            output: { type: "text", value: "result" },
          },
          {
            type: "tool-approval-request",
            toolCallId: "call-2",
            approvalId: "approval-1",
          },
          { type: "text", text: "after tools" },
        ]),
        "\n\nafter tools",
      );
    });
  });

  describe("safeStringify", () => {
    it("returns an empty string for undefined", () => {
      assert.equal(safeStringify(undefined), "");
    });

    it("returns an empty string for function and symbol top-level values", () => {
      assert.equal(
        safeStringify(() => undefined),
        "",
      );
      assert.equal(safeStringify(Symbol("x")), "");
    });

    it("returns the error message for bigint top-level values", () => {
      assert.match(safeStringify(1n), /Do not know how to serialize a BigInt/);
    });

    it("returns stringify of regular values", () => {
      assert.equal(safeStringify({ a: 1 }), '{"a":1}');
    });

    it("returns the error message for circular structures", () => {
      const circular: Record<string, unknown> = {};
      circular["self"] = circular;
      assert.match(
        safeStringify(circular),
        /Converting circular structure to JSON/,
      );
    });
  });

  describe("getMessageFromError", () => {
    it("returns the message from an Error instance", () => {
      assert.equal(
        getMessageFromError(new Error("test message")),
        "test message",
      );
    });

    it("returns JSON string for non-Error values", () => {
      assert.equal(getMessageFromError("string error"), '"string error"');
      assert.equal(getMessageFromError(42), "42");
      assert.equal(getMessageFromError(null), "null");
    });

    it("returns a string for values JSON.stringify cannot serialize", () => {
      assert.equal(getMessageFromError(undefined), "undefined");
      assert.equal(getMessageFromError(Symbol("test")), "Symbol(test)");
    });

    it("joins multi-line error messages with spaces by default", () => {
      assert.equal(
        getMessageFromError(new Error("first line\nsecond line")),
        "first line second line",
      );
    });

    it("keeps newlines when forceSingleLine is false", () => {
      assert.equal(
        getMessageFromError(new Error("first line\nsecond line"), {
          forceSingleLine: false,
        }),
        `first line
second line`,
      );
    });
  });

  describe("isAbortError", () => {
    it("returns true for an Error with name === 'AbortError'", () => {
      const err = makeAbortError("aborted");
      assert.equal(isAbortError(err), true);
    });

    it("returns false for a plain Error", () => {
      assert.equal(isAbortError(new Error("plain")), false);
    });

    it("returns false for null", () => {
      assert.equal(isAbortError(null), false);
    });

    it("returns false for a string", () => {
      assert.equal(isAbortError("AbortError"), false);
    });
  });

  describe("isNullish", () => {
    it("returns true for null", () => {
      assert.equal(isNullish(null), true);
    });

    it("returns true for undefined", () => {
      assert.equal(isNullish(undefined), true);
    });

    it("returns false for an empty string", () => {
      assert.equal(isNullish(""), false);
    });

    it("returns false for a non-nullish value", () => {
      assert.equal(isNullish("vi"), false);
    });
  });

  describe("isReadlineClosedError", () => {
    it("returns true for an error with the readline closed code", () => {
      assert.equal(
        isReadlineClosedError(
          makeErrnoError("ERR_USE_AFTER_CLOSE", "readline was closed"),
        ),
        true,
      );
    });

    it("returns false for an abort error", () => {
      assert.equal(
        isReadlineClosedError(makeAbortError("Aborted with Ctrl+D")),
        false,
      );
    });

    it("returns false for a plain Error", () => {
      assert.equal(isReadlineClosedError(new Error("plain")), false);
    });

    it("returns false for null", () => {
      assert.equal(isReadlineClosedError(null), false);
    });
  });

  describe("tryCatch", () => {
    it("returns {ok: true, value} when the callback succeeds", () => {
      const result = tryCatch(() => 42);
      assert.deepStrictEqual(result, { ok: true, value: 42 });
    });

    it("returns {ok: false, error} when the callback throws", () => {
      const err = new Error("boom");
      const result = tryCatch(() => {
        throw err;
      });
      assert.deepStrictEqual(result, { ok: false, error: err });
    });
  });

  describe("tryCatchAsync", () => {
    it("returns {ok: true, value} for a resolved promise", async () => {
      const result = await tryCatchAsync(Promise.resolve(42));
      assert.deepStrictEqual(result, { ok: true, value: 42 });
    });

    it("returns {ok: false, error} for a rejected promise", async () => {
      const err = new Error("boom");
      const result = await tryCatchAsync(Promise.reject(err));
      assert.deepStrictEqual(result, { ok: false, error: err });
    });
  });

  describe("getPrettyDuration", () => {
    it("formats sub-second duration as milliseconds", () => {
      assert.strictEqual(
        getPrettyDuration(BigInt(0), BigInt(1_000_999)),
        "1ms",
      );
      assert.strictEqual(
        getPrettyDuration(BigInt(0), BigInt(1_500_000_000)),
        "1s 500ms",
      );
    });

    it("includes microseconds when requested", () => {
      assert.strictEqual(
        getPrettyDuration(BigInt(1_000_000_000), BigInt(1_234_567_890), {
          includeMicroseconds: true,
        }),
        "234.567ms",
      );
    });

    it("nevers truncates nanoseconds", () => {
      assert.strictEqual(
        getPrettyDuration(BigInt(1_000_000_000), BigInt(1_000_123_456), {
          includeMicroseconds: true,
        }),
        "0.123ms",
      );
    });

    it("formats minutes, seconds, and milliseconds", () => {
      assert.strictEqual(
        getPrettyDuration(BigInt(0), BigInt(125_500_000_000)),
        "2m 5s 500ms",
      );
    });

    it("clamps negative durations to zero", () => {
      assert.strictEqual(
        getPrettyDuration(BigInt(0), BigInt(500_000_000)),
        "500ms",
      );
    });
  });

  describe("getPrettyDate", () => {
    it("formats the epoch timestamp as a medium date and time", () => {
      assert.strictEqual(getPrettyDate(0), "Jan 1, 1970, 12:00:00 AM");
    });

    it("formats a later timestamp", () => {
      assert.strictEqual(getPrettyDate(60000), "Jan 1, 1970, 12:01:00 AM");
    });
  });

  describe("getDurationColor", () => {
    it("returns green below 500ms", () => {
      assert.strictEqual(
        getDurationColor(BigInt(0), BigInt(499_999_999)),
        "green",
      );
    });

    it("returns yellow from 500ms to below 1s", () => {
      assert.strictEqual(
        getDurationColor(BigInt(0), BigInt(500_000_000)),
        "yellow",
      );
      assert.strictEqual(
        getDurationColor(BigInt(0), BigInt(999_999_999)),
        "yellow",
      );
    });

    it("returns red at 1s and above", () => {
      assert.strictEqual(
        getDurationColor(BigInt(0), BigInt(1_000_000_000)),
        "red",
      );
      assert.strictEqual(
        getDurationColor(BigInt(0), BigInt(2_000_000_000)),
        "red",
      );
    });

    it("clamps a negative diff to zero and returns green", () => {
      assert.strictEqual(getDurationColor(BigInt(10), BigInt(0)), "green");
    });

    it("returns green for equal start and end", () => {
      assert.strictEqual(getDurationColor(BigInt(5), BigInt(5)), "green");
    });
  });

  describe("normalizeNewline", () => {
    it("preserves leading whitespace and appends newline", () => {
      assert.equal(normalizeNewline("  hello  "), "  hello\n");
      assert.equal(normalizeNewline("\t\tcontent"), "\t\tcontent\n");
    });

    it("trims trailing whitespace", () => {
      assert.equal(normalizeNewline("content\n\n"), "content\n");
    });

    it("handles empty string", () => {
      assert.equal(normalizeNewline(""), "\n");
    });

    it("handles already normalized string", () => {
      assert.equal(normalizeNewline("already\n"), "already\n");
    });

    it("appends two newlines when count is 2", () => {
      assert.equal(
        normalizeNewline("content\n\n\n", { count: 2 }),
        "content\n\n",
      );
    });

    it("defaults to one newline when no options are given", () => {
      assert.equal(normalizeNewline("content\n\n\n"), "content\n");
    });
  });

  describe("createQueue", () => {
    it("runs enqueued tasks in order", async () => {
      const queue = createQueue();
      const results: number[] = [];

      queue.enqueue(() => {
        results.push(1);
        return Promise.resolve();
      });
      queue.enqueue(() => {
        results.push(2);
        return Promise.resolve();
      });
      queue.enqueue(() => {
        results.push(3);
        return Promise.resolve();
      });

      await queue.flush();

      assert.deepStrictEqual(results, [1, 2, 3]);
    });

    it("resolves flush immediately when queue is empty", async () => {
      const queue = createQueue();
      await queue.flush();
    });

    it("continues queue after a rejected task", async () => {
      const queue = createQueue();
      const results: number[] = [];

      queue.enqueue(() => {
        results.push(1);
        return Promise.resolve();
      });
      queue.enqueue(() => Promise.reject(new Error("boom")));
      queue.enqueue(() => {
        results.push(3);
        return Promise.resolve();
      });

      await queue.flush();

      assert.deepStrictEqual(results, [1, 3]);
    });

    it("flush waits for all queued tasks to complete", async () => {
      const queue = createQueue();
      let done = false;

      queue.enqueue(() => {
        return new Promise<void>((r) => {
          setTimeout(() => {
            done = true;
            r();
          }, 10);
        });
      });

      await queue.flush();

      assert.strictEqual(done, true);
    });
  });

  describe("removeMediaReplacer", () => {
    const stringifyWithoutMedia = (messages: unknown[]): unknown =>
      JSON.parse(JSON.stringify(messages, removeMediaReplacer));

    it("replaces top-level image and file parts", () => {
      const messages = [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", image: "AAAA" },
            { type: "file", data: "BBBB", mediaType: "application/pdf" },
          ],
        },
      ];
      assert.deepStrictEqual(stringifyWithoutMedia(messages), [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            "[media omitted]",
            "[media omitted]",
          ],
        },
      ]);
    });

    it("replaces deprecated image-data and file-data values", () => {
      const messages = [
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
                  { type: "image-data", data: "IMG", mediaType: "image/png" },
                  {
                    type: "file-data",
                    data: "FILE",
                    mediaType: "application/pdf",
                  },
                ],
              },
            },
          ],
        },
      ];
      assert.deepStrictEqual(stringifyWithoutMedia(messages), [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "read_image",
              output: {
                type: "content",
                value: ["[media omitted]", "[media omitted]"],
              },
            },
          ],
        },
      ]);
    });

    it("replaces image and file values in tool-result content output", () => {
      const messages = [
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
                  { type: "text", text: "Read image" },
                  {
                    type: "file",
                    data: { type: "data", data: "BASE64" },
                    mediaType: "image/png",
                  },
                ],
              },
            },
          ],
        },
      ];
      assert.deepStrictEqual(stringifyWithoutMedia(messages), [
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
                  { type: "text", text: "Read image" },
                  "[media omitted]",
                ],
              },
            },
          ],
        },
      ]);
    });

    it("leaves string content and non-content tool-result outputs unchanged", () => {
      const messages = [
        { role: "user", content: "hello" },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-2",
              toolName: "bash",
              output: { type: "text", value: "ok" },
            },
          ],
        },
      ];
      assert.deepStrictEqual(stringifyWithoutMedia(messages), messages);
    });
  });

  describe("strToApproxTokens", () => {
    it("splits character length by 3", () => {
      assert.equal(strToApproxTokens(""), 0);
      assert.equal(strToApproxTokens("abc"), 1);
      assert.equal(strToApproxTokens("abcdef"), 2);
      assert.equal(strToApproxTokens("abcdefg"), 2);
    });
  });

  describe("approxTokensToCharLen", () => {
    it("multiplies token count by 3", () => {
      assert.equal(approxTokensToCharLen(0), 0);
      assert.equal(approxTokensToCharLen(1), 3);
      assert.equal(approxTokensToCharLen(250), 750);
    });
  });

  describe("shellQuote", () => {
    it("wraps a safe path in single quotes", () => {
      assert.strictEqual(
        shellQuote("/tmp/lasso-abc.txt"),
        "'/tmp/lasso-abc.txt'",
      );
    });

    it("escapes single quotes in the path", () => {
      assert.strictEqual(
        shellQuote("/tmp/it's a file"),
        "'/tmp/it'\\''s a file'",
      );
    });
  });

  describe("isShellSafePath", () => {
    it("accepts word characters, slashes, dots, underscores, and dashes", () => {
      assert.strictEqual(isShellSafePath("/tmp/lasso-test-uuid.txt"), true);
    });

    it("rejects spaces, quotes, and shell metacharacters", () => {
      assert.strictEqual(isShellSafePath("/tmp/my file;x.txt"), false);
      assert.strictEqual(isShellSafePath("/tmp/a'b.txt"), false);
      assert.strictEqual(isShellSafePath("/tmp/a`ls`.txt"), false);
    });
  });
});
