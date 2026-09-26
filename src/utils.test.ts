import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import {
  isAbortError,
  tryCatch,
  safeStringify,
  strToApproxTokens,
  approxTokensToCharLen,
  tryCatchAsync,
  normalizeLine,
  execPromise,
  getMessageFromError,
  getTempFileName,
  createQueue,
  createLockUtils,
  listChatHistoryFiles,
  getStrFromAssistantContent,
  getPrettyDuration,
  getDurationColor,
  shouldDisableColor,
  decimalToPercent,
} from "./utils.ts";
import {
  testFs,
  mockSetTimeout,
  makeAbortError,
  setupTestContext,
  testProcessEnv,
  drainTimerCallbacks,
  makeErrnoError,
} from "./test-helpers.ts";
import { fsDeps, processDeps } from "./deps.ts";

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

  describe("normalizeLine", () => {
    it("preserves leading whitespace and appends newline", () => {
      assert.equal(normalizeLine("  hello  "), "  hello\n");
      assert.equal(normalizeLine("\t\tcontent"), "\t\tcontent\n");
    });

    it("trims trailing whitespace", () => {
      assert.equal(normalizeLine("content\n\n"), "content\n");
    });

    it("handles empty string", () => {
      assert.equal(normalizeLine(""), "\n");
    });

    it("handles already normalized string", () => {
      assert.equal(normalizeLine("already\n"), "already\n");
    });
  });

  describe("execPromise", () => {
    it("closes stdin so commands reading stdin resolve", async () => {
      const result = await execPromise("cat");
      assert.deepStrictEqual(result, { stdout: "", stderr: "" });
    });
  });

  describe("getTempFileName", () => {
    it("returns temp file path without initial content", () => {
      const result = getTempFileName();
      assert.equal(result, "/tmp/lasso-test-uuid.txt");
    });

    it("copies initial content when initialContentPath is provided", () => {
      testFs._files.set("/source/file.txt", "initial content");
      const result = getTempFileName({
        initialContentPath: "/source/file.txt",
      });
      assert.equal(result, "/tmp/lasso-test-uuid.txt");
      assert.equal(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        "initial content",
      );
    });

    it("creates an empty temp file when the initial content path does not exist", () => {
      const result = getTempFileName({
        initialContentPath: "/missing/file.txt",
      });
      assert.equal(result, "/tmp/lasso-test-uuid.txt");
      assert.equal(testFs._files.get("/tmp/lasso-test-uuid.txt"), "");
    });

    it("returns null when reading an existing path fails", () => {
      testFs._files.set("/source/file.txt", "initial content");
      mock.method(fsDeps, "readFileSync", () => {
        throw new Error("EIO");
      });
      const result = getTempFileName({
        initialContentPath: "/source/file.txt",
      });
      assert.equal(result, null);
      assert.equal(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
    });

    it("returns null when write fails", () => {
      testFs._files.set("/source.txt", "content");
      mock.method(fsDeps, "writeFileSync", () => {
        throw new Error("EIO");
      });
      const result = getTempFileName({
        initialContentPath: "/source.txt",
      });
      assert.equal(result, null);

      const strResult = getTempFileName({ initialContentStr: "content" });
      assert.equal(strResult, null);

      const noArgsResult = getTempFileName();
      assert.equal(noArgsResult, null);
    });

    it("writes initialContentStr into the temp file", () => {
      const result = getTempFileName({
        initialContentStr: "string content",
      });
      assert.equal(result, "/tmp/lasso-test-uuid.txt");
      assert.equal(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        "string content",
      );
    });

    it("uses the path prefix in the temp file path", () => {
      const result = getTempFileName({
        pathPrefix: "lasso-local",
        initialContentStr: "local content",
      });
      assert.equal(result, "/tmp/lasso-local-test-uuid.txt");
      assert.equal(
        testFs._files.get("/tmp/lasso-local-test-uuid.txt"),
        "local content",
      );
    });

    it("throws when both initialContentPath and initialContentStr are provided", () => {
      assert.throws(
        () =>
          getTempFileName({
            initialContentPath: "/source/file.txt",
            initialContentStr: "string content",
          }),
        /falsy value/,
      );
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

  describe("listChatHistoryFiles", () => {
    it("returns an empty array when the directory does not exist", () => {
      assert.deepStrictEqual(listChatHistoryFiles(), []);
    });

    it("returns an empty array when the directory has no files", () => {
      testFs._dirs.add("/fake-home/.config/lasso/history");
      assert.deepStrictEqual(listChatHistoryFiles(), []);
    });

    it("returns valid chat history files with absolute path and timestamp", () => {
      testFs._dirs.add("/fake-home/.config/lasso/history");
      testFs._files.set(
        "/fake-home/.config/lasso/history/chat-history-1234567890000.md",
        "",
      );
      testFs._files.set(
        "/fake-home/.config/lasso/history/chat-history-999990000000.md",
        "",
      );

      assert.deepStrictEqual(listChatHistoryFiles(), [
        {
          absolutePath:
            "/fake-home/.config/lasso/history/chat-history-1234567890000.md",
          timestampMs: 1234567890000,
        },
        {
          absolutePath:
            "/fake-home/.config/lasso/history/chat-history-999990000000.md",
          timestampMs: 999990000000,
        },
      ]);
    });

    it("skips directory entries", () => {
      testFs._dirs.add("/fake-home/.config/lasso/history");
      testFs._dirs.add(
        "/fake-home/.config/lasso/history/chat-history-1234567890000.md",
      );
      assert.deepStrictEqual(listChatHistoryFiles(), []);
    });

    it("skips files that do not match chat-history-<timestamp>", () => {
      testFs._dirs.add("/fake-home/.config/lasso/history");
      testFs._files.set("/fake-home/.config/lasso/history/random-file.md", "");
      testFs._files.set(
        "/fake-home/.config/lasso/history/chat-history-uuid-123.md",
        "",
      );
      testFs._files.set(
        "/fake-home/.config/lasso/history/chat-history-notanumber.md",
        "",
      );
      assert.deepStrictEqual(listChatHistoryFiles(), []);
    });

    it("skips files with non-md extension", () => {
      testFs._dirs.add("/fake-home/.config/lasso/history");
      testFs._files.set(
        "/fake-home/.config/lasso/history/chat-history-123.log",
        "",
      );
      assert.deepStrictEqual(listChatHistoryFiles(), []);
    });

    describe("createLockUtils", () => {
      beforeEach(() => {
        mock.method(
          fsDeps,
          "writeFileSync",
          (path: string, content: string, options?: { flag?: string }) => {
            if (options?.flag === "wx" && testFs._files.has(path)) {
              throw makeErrnoError("EEXIST", `EEXIST: ${path}`);
            }
            testFs.writeFileSync(path, content);
          },
        );
      });

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
        testFs._files.delete("/lock");
        const finalCallback = timerCallbacks.shift();
        assert(finalCallback !== undefined);
        finalCallback();

        assert.equal(await promise, true);
        assert.equal(testFs._files.get("/lock"), String(process.pid));
        mock.restoreAll();
      });

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
        mock.method(fsDeps, "readFileSync", () => {
          throw makeErrnoError("EIO", "I/O error");
        });

        const lockUtils = createLockUtils("/lock");
        assert.equal(await lockUtils.createLock(), true);
        assert.equal(testFs._files.get("/lock"), String(process.pid));
      });

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
});
