import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  listSessionFiles,
  initSessionFile,
  deleteExpiredSessionFiles,
  deleteExpiredWebpageFiles,
  syncSessionFile,
  resumeFromSessionFile,
} from "./session.ts";
import { actions, getState } from "./state.ts";
import { getWebpagesDir } from "./paths.ts";
import {
  setupTestContext,
  testFs,
  mockStdoutWrites,
  RESET,
  RED,
  makeErrnoError,
} from "./test-helpers.ts";
import { fsDeps } from "./deps.ts";

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

  it("prints the error and returns an empty array when reading the directory fails", async () => {
    testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
    mock.method(fsDeps, "readdir", () =>
      Promise.reject(makeErrnoError("EACCES")),
    );
    const writes = mockStdoutWrites();

    assert.deepStrictEqual(await listSessionFiles(), []);
    assert.deepStrictEqual(writes(), [
      `${RED}Failed to read /fake-home/.local/state/lasso/sessions. Error: EACCES${RESET}\n`,
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

  describe("deleteExpiredWebpageFiles", () => {
    beforeEach(() => {
      mock.restoreAll();
      setupTestContext({ now: 1_000_000_000_000 });
    });

    it("returns early when the webpages directory does not exist", async () => {
      await deleteExpiredWebpageFiles();
      assert.strictEqual(testFs._dirs.has(getWebpagesDir()), false);
    });

    it("logs and returns when reading the webpages directory fails", async () => {
      const webpagesDir = getWebpagesDir();
      testFs._dirs.add(webpagesDir);
      mock.method(fsDeps, "readdir", () => Promise.reject(new Error("EACCES")));
      const writes = mockStdoutWrites();

      await deleteExpiredWebpageFiles();

      assert.deepStrictEqual(writes(), [
        `${RED}Failed to read ${webpagesDir}. Error: EACCES${RESET}\n`,
      ]);
    });

    it("deletes expired markdown and keeps recent or non-markdown files", async () => {
      const webpagesDir = getWebpagesDir();
      testFs._dirs.add(webpagesDir);
      const expiredPath = join(webpagesDir, "article-999900000000.md");
      const recentPath = join(webpagesDir, "article-999990000000.md");
      const otherExtensionPath = join(webpagesDir, "article-999900000000.html");
      const invalidTimestampPath = join(webpagesDir, "article-not-a-time.md");
      testFs._files.set(expiredPath, "expired");
      testFs._files.set(recentPath, "recent");
      testFs._files.set(otherExtensionPath, "html");
      testFs._files.set(invalidTimestampPath, "invalid");

      await deleteExpiredWebpageFiles();

      assert.deepStrictEqual(
        [...testFs._files.keys()],
        [recentPath, otherExtensionPath, invalidTimestampPath],
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
      actions.session.setFilePath(
        "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
      );
    });

    it("writes the current state to the session file", async () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
      actions.conversation.setMessages([{ role: "user", content: "hello" }]);
      actions.conversation.setTranscript([
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
      actions.conversation.setMessages([{ role: "user", content: "old" }]);
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
      actions.conversation.setMessages([{ role: "user", content: "old" }]);
      testFs._files.set(
        "/test/session.json",
        JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          summaries: [{ compacted: "summary", compactedAt: 123, tokens: 456 }],
          transcript: [{ timestamp: 0, role: "user", message: "hello" }],
        }),
      );

      actions.usage.setRequestInputTokens(100);

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
      assert.deepStrictEqual(getState().usage.requestInputTokens, {
        value: 100,
        stale: true,
        charLength: 0,
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
