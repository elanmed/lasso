import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  prependToChatHistory,
  initSessionFile,
  deleteExpiredSessionFiles,
  initLogs,
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

  describe("prependToChatHistory", () => {
    beforeEach(() => {
      mock.restoreAll();
      setupTestContext({ now: 1_700_000_000_000 });
    });

    it("creates directory when log file does not exist", () => {
      actions.setChatHistoryPath("/test/editor.log");
      prependToChatHistory("test message", "user");
      assert.equal(testFs._dirs.has("/test"), true);
    });

    it("warns and skips writing when mkdir fails", () => {
      actions.setChatHistoryPath("/test/editor.log");
      mock.method(fsDeps, "mkdirSync", () => {
        throw new Error("Permission denied");
      });
      const getCaptured = mockStdout();

      prependToChatHistory("test message", "user");

      assert.equal(
        stripAnsi(getCaptured()),
        "Failed to create the directory: /test\n",
      );
      assert.equal(testFs._files.has("/test/editor.log"), false);
    });

    it("warns when writing fails", () => {
      actions.setChatHistoryPath("/test/editor.log");
      testFs._files.set("/test/editor.log", "");
      mock.method(fsDeps, "writeFileSync", () => {
        throw new Error("Permission denied");
      });
      const getCaptured = mockStdout();

      prependToChatHistory("test message", "user");

      assert.equal(
        stripAnsi(getCaptured()),
        "Failed to write the chat history to /test/editor.log\n",
      );
    });

    it("appends content with timestamp and role", () => {
      actions.setChatHistoryPath("/test/editor.log");
      testFs._files.set("/test/editor.log", "");
      prependToChatHistory("test content", "user");
      assert.equal(
        testFs._files.get("/test/editor.log"),
        `2023-11-14T22:13:20.000Z  *user*
test content

---

`,
      );
    });

    it("appends multiple messages with different roles", () => {
      actions.setChatHistoryPath("/test/editor.log");
      testFs._files.set("/test/editor.log", "");
      prependToChatHistory("hello", "user");
      prependToChatHistory("response", "assistant");
      assert.equal(
        testFs._files.get("/test/editor.log"),
        `2023-11-14T22:13:20.000Z  *assistant*
response

---
2023-11-14T22:13:20.000Z  *user*
hello

---


`,
      );
    });
    it("normalizes trailing newlines in content", () => {
      actions.setChatHistoryPath("/test/editor.log");
      testFs._files.set("/test/editor.log", "");
      prependToChatHistory("hello\n\n", "user");
      assert.equal(
        testFs._files.get("/test/editor.log"),
        `2023-11-14T22:13:20.000Z  *user*
hello

---

`,
      );
    });
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
});
