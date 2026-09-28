import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  initSessionFile,
  deleteExpiredSessionFiles,
  initLogs,
  syncSessionFile,
  resumeFromSessionFile,
} from "./log.ts";
import { actions, getState } from "./state.ts";
import {
  mockStdout,
  setupTestContext,
  stripAnsi,
  testFs,
} from "./test-helpers.ts";
import { fsDeps } from "./deps.ts";

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

    it("creates directory and sets path when directory does not exist", () => {
      initSessionFile();
      assert.equal(
        testFs._dirs.has("/fake-home/.local/state/lasso/sessions"),
        true,
      );
      assert.equal(
        getState().app.sessionFilePath,
        "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
      );
      assert.equal(
        testFs._files.get(
          "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
        ),
        "",
      );
    });

    it("warns and leaves the session path empty when mkdir fails", () => {
      mock.method(fsDeps, "existsSync", () => false);
      mock.method(fsDeps, "mkdirSync", () => {
        throw new Error("Permission denied");
      });
      const getCaptured = mockStdout();

      initSessionFile();

      assert.equal(
        stripAnsi(getCaptured()),
        "Failed to create the directory: /fake-home/.local/state/lasso/sessions\n",
      );
      assert.equal(getState().app.sessionFilePath, "");
    });

    it("warns when the initial write fails", () => {
      mock.method(fsDeps, "writeFileSync", () => {
        throw new Error("Permission denied");
      });
      const getCaptured = mockStdout();

      initSessionFile();

      assert.equal(
        stripAnsi(getCaptured()),
        "Failed to write the session file to /fake-home/.local/state/lasso/sessions/session-1234567890000.json\n",
      );
    });

    it("generates correct log path with session start date", () => {
      initSessionFile();
      assert.equal(
        getState().app.sessionFilePath,
        "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
      );
      assert.equal(
        testFs._files.get(
          "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
        ),
        "",
      );
    });
  });

  describe("initLogs", () => {
    beforeEach(() => {
      mock.restoreAll();
      setupTestContext({ now: 1_234_567_890_000 });
    });

    it("deletes expired session files, initializes the session file", () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
      testFs._files.set(
        "/fake-home/.local/state/lasso/sessions/session-1000000000.json",
        "expired",
      );
      initLogs();

      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/sessions/session-1000000000.json",
        ),
        false,
      );
      assert.equal(
        getState().app.sessionFilePath,
        "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
      );
    });
  });

  describe("deleteExpiredSessionFiles", () => {
    beforeEach(() => {
      mock.restoreAll();
      setupTestContext({ now: 1_000_000_000_000 });
    });

    it("returns early when directory does not exist", () => {
      deleteExpiredSessionFiles();
      assert.equal(
        testFs._dirs.has("/fake-home/.local/state/lasso/sessions"),
        false,
      );
    });

    it("deletes expired files older than 24 hours", () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
      testFs._files.set(
        "/fake-home/.local/state/lasso/sessions/session-999900000000.json",
        "old",
      );
      deleteExpiredSessionFiles();
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/sessions/session-999900000000.json",
        ),
        false,
      );
    });

    it("keeps files newer than 24 hours", () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
      testFs._files.set(
        "/fake-home/.local/state/lasso/sessions/session-999990000000.json",
        "new",
      );
      deleteExpiredSessionFiles();
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/sessions/session-999990000000.json",
        ),
        true,
      );
    });

    it("skips files without correct format", () => {
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
      deleteExpiredSessionFiles();
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

    it("skips session files with 3 parts", () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
      testFs._files.set(
        "/fake-home/.local/state/lasso/sessions/session-uuid-999997600000.json",
        "",
      );
      deleteExpiredSessionFiles();
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

    it("writes the current state to the session file", () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
      actions.setConversationMessages([{ role: "user", content: "hello" }]);
      actions.setTranscript([
        {
          timestamp: 0,
          role: "user",
          message: "hi",
        },
      ]);

      syncSessionFile();

      assert.equal(
        testFs._files.get(
          "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
        ),
        '{"messages":[{"role":"user","content":"hello"}],"summaries":[],"transcript":[{"timestamp":0,"role":"user","message":"hi"}]}',
      );
    });

    it("replaces the provided fields and updates state", () => {
      actions.setConversationMessages([{ role: "user", content: "old" }]);
      syncSessionFile({ messages: [{ role: "assistant", content: "reply" }] });

      assert.equal(
        testFs._files.get(
          "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
        ),
        '{"messages":[{"role":"assistant","content":"reply"}],"summaries":[],"transcript":[]}',
      );
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [],
        messages: [{ role: "assistant", content: "reply" }],
      });
    });

    it("creates the directory when it does not exist", () => {
      syncSessionFile();
      assert.equal(
        testFs._dirs.has("/fake-home/.local/state/lasso/sessions"),
        true,
      );
    });

    it("warns and updates state when writing fails", () => {
      mock.method(fsDeps, "writeFileSync", () => {
        throw new Error("Permission denied");
      });
      const getCaptured = mockStdout();

      syncSessionFile();

      assert.equal(
        stripAnsi(getCaptured()),
        "Failed to write the session file to /fake-home/.local/state/lasso/sessions/session-1234567890000.json\n",
      );
      assert.deepStrictEqual(getState().app.conversation.messages, []);
    });

    it("warns and updates state when stringifying fails", () => {
      const circularContent: { self?: unknown } = {};
      circularContent.self = circularContent;

      const getCaptured = mockStdout();
      syncSessionFile({
        messages: [{ role: "user", content: circularContent }],
      });

      assert.equal(
        stripAnsi(getCaptured()),
        "Failed to stringify the session file\n",
      );
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
        ),
        false,
      );
      assert.deepStrictEqual(getState().app.conversation.messages, [
        { role: "user", content: circularContent },
      ]);
    });
  });

  describe("resumeFromSessionFile", () => {
    beforeEach(() => {
      mock.restoreAll();
      setupTestContext({ now: 1_234_567_890_000 });
    });

    it("loads messages, summaries, and transcript into state and returns true", () => {
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

      const result = resumeFromSessionFile("/test/session.json");

      assert.equal(result, true);
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [{ compacted: "summary", compactedAt: 123, tokens: 456 }],
        messages: [{ role: "user", content: "hello" }],
      });
      assert.deepStrictEqual(getState().app.transcript, [
        { timestamp: 0, role: "user", message: "hello" },
      ]);
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: 100,
        dirty: true,
      });
    });

    it("prints an error and returns false when the session file cannot be read", () => {
      const getCaptured = mockStdout();

      const result = resumeFromSessionFile("/test/missing.json");

      assert.equal(result, false);
      assert.equal(
        stripAnsi(getCaptured()),
        "\nFailed to read the session file at /test/missing.json\n\n",
      );
    });

    it("prints an error and returns false when the session file is not valid json", () => {
      testFs._files.set("/test/broken.json", "not json");
      const getCaptured = mockStdout();

      const result = resumeFromSessionFile("/test/broken.json");

      assert.equal(result, false);
      assert.equal(
        stripAnsi(getCaptured()),
        "\nFailed to parse the session file at /test/broken.json\n\n",
      );
    });

    it("prints an error and returns false when the session file fails validation", () => {
      testFs._files.set("/test/invalid.json", "{}");
      const getCaptured = mockStdout();

      const result = resumeFromSessionFile("/test/invalid.json");

      assert.equal(result, false);
      assert.equal(
        stripAnsi(getCaptured()),
        "\nFailed to validate the session file at /test/invalid.json\n\n",
      );
    });
  });
});
