import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  prependToChatHistory,
  initChatHistory,
  initConversationLog,
  deleteExpiredChatHistory,
  deleteExpiredConversationLog,
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

  describe("initChatHistory", () => {
    beforeEach(() => {
      mock.restoreAll();
      setupTestContext({ now: 1_234_567_890_000 });
    });

    it("creates directory and sets path when directory does not exist", () => {
      initChatHistory();
      assert.equal(
        testFs._dirs.has("/fake-home/.local/state/lasso/history"),
        true,
      );
      assert.equal(
        getState().app.chatHistoryPath,
        "/fake-home/.local/state/lasso/history/chat-history-1234567890000.md",
      );
      assert.equal(
        testFs._files.get(
          "/fake-home/.local/state/lasso/history/chat-history-1234567890000.md",
        ),
        "",
      );
    });

    it("warns and disables history when mkdir fails", () => {
      mock.method(fsDeps, "existsSync", () => false);
      mock.method(fsDeps, "mkdirSync", () => {
        throw new Error("Permission denied");
      });
      const getCaptured = mockStdout();

      initChatHistory();

      assert.equal(
        stripAnsi(getCaptured()),
        "Failed to create the directory: /fake-home/.local/state/lasso/history\n",
      );
      assert.equal(getState().app.chatHistoryPath, "");
    });

    it("generates correct log path with session start date", () => {
      initChatHistory();
      assert.equal(
        getState().app.chatHistoryPath,
        "/fake-home/.local/state/lasso/history/chat-history-1234567890000.md",
      );
      assert.equal(
        testFs._files.get(
          "/fake-home/.local/state/lasso/history/chat-history-1234567890000.md",
        ),
        "",
      );
    });
  });

  describe("initConversationLog", () => {
    beforeEach(() => {
      mock.restoreAll();
      setupTestContext({ now: 1_234_567_890_000 });
    });

    it("creates directory and sets path when directory does not exist", () => {
      initConversationLog();
      assert.equal(
        testFs._dirs.has("/fake-home/.local/state/lasso/conversation"),
        true,
      );
      assert.equal(
        getState().app.conversationLogPath,
        "/fake-home/.local/state/lasso/conversation/conversation-log-1234567890000.json",
      );
      assert.equal(
        testFs._files.get(
          "/fake-home/.local/state/lasso/conversation/conversation-log-1234567890000.json",
        ),
        "[]",
      );
    });

    it("warns and leaves the path unset when mkdir fails", () => {
      mock.method(fsDeps, "existsSync", () => false);
      mock.method(fsDeps, "mkdirSync", () => {
        throw new Error("Permission denied");
      });
      const getCaptured = mockStdout();

      initConversationLog();

      assert.equal(
        stripAnsi(getCaptured()),
        "Failed to create the directory: /fake-home/.local/state/lasso/conversation\n",
      );
      assert.equal(getState().app.conversationLogPath, "");
    });

    it("generates correct log path with session start date", () => {
      initConversationLog();
      assert.equal(
        getState().app.conversationLogPath,
        "/fake-home/.local/state/lasso/conversation/conversation-log-1234567890000.json",
      );
      assert.equal(
        testFs._files.get(
          "/fake-home/.local/state/lasso/conversation/conversation-log-1234567890000.json",
        ),
        "[]",
      );
    });
  });

  describe("initLogs", () => {
    beforeEach(() => {
      mock.restoreAll();
      setupTestContext({ now: 1_234_567_890_000 });
    });

    it("deletes expired chat history and conversation logs, initializes both session logs", () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/history");
      testFs._files.set(
        "/fake-home/.local/state/lasso/history/chat-history-1000000000.md",
        "expired",
      );
      testFs._dirs.add("/fake-home/.local/state/lasso/conversation");
      testFs._files.set(
        "/fake-home/.local/state/lasso/conversation/conversation-log-1000000000.json",
        "expired",
      );

      initLogs();

      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/history/chat-history-1000000000.md",
        ),
        false,
      );
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/conversation/conversation-log-1000000000.json",
        ),
        false,
      );
      assert.equal(
        getState().app.chatHistoryPath,
        "/fake-home/.local/state/lasso/history/chat-history-1234567890000.md",
      );
      assert.equal(
        getState().app.conversationLogPath,
        "/fake-home/.local/state/lasso/conversation/conversation-log-1234567890000.json",
      );
      assert.equal(
        testFs._files.get(
          "/fake-home/.local/state/lasso/conversation/conversation-log-1234567890000.json",
        ),
        "[]",
      );
    });
  });

  describe("deleteExpiredChatHistory", () => {
    beforeEach(() => {
      mock.restoreAll();
      setupTestContext({ now: 1_000_000_000_000 });
    });

    it("returns early when directory does not exist", () => {
      deleteExpiredChatHistory();
      assert.equal(
        testFs._dirs.has("/fake-home/.local/state/lasso/history"),
        false,
      );
    });

    it("deletes expired files older than 24 hours", () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/history");
      testFs._files.set(
        "/fake-home/.local/state/lasso/history/chat-history-999900000000.md",
        "old",
      );
      deleteExpiredChatHistory();
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/history/chat-history-999900000000.md",
        ),
        false,
      );
    });

    it("keeps files newer than 24 hours", () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/history");
      testFs._files.set(
        "/fake-home/.local/state/lasso/history/chat-history-999990000000.md",
        "new",
      );
      deleteExpiredChatHistory();
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/history/chat-history-999990000000.md",
        ),
        true,
      );
    });

    it("skips files without correct format", () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/history");
      testFs._files.set(
        "/fake-home/.local/state/lasso/history/random-file.log",
        "",
      );
      testFs._files.set(
        "/fake-home/.local/state/lasso/history/other-uuid-123-notimestamp.log",
        "",
      );
      testFs._files.set(
        "/fake-home/.local/state/lasso/history/prompt-history-uuid-999990000001.log",
        "",
      );
      deleteExpiredChatHistory();
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/history/random-file.log",
        ),
        true,
      );
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/history/other-uuid-123-notimestamp.log",
        ),
        true,
      );
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/history/prompt-history-uuid-999990000001.log",
        ),
        true,
      );
    });

    it("skips non-chat-history files with 4 parts", () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/history");
      testFs._files.set(
        "/fake-home/.local/state/lasso/history/chat-history-uuid-999997600000.md",
        "",
      );
      deleteExpiredChatHistory();
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/history/chat-history-uuid-999997600000.md",
        ),
        true,
      );
    });
  });

  describe("deleteExpiredConversationLog", () => {
    beforeEach(() => {
      mock.restoreAll();
      setupTestContext({ now: 1_000_000_000_000 });
    });

    it("returns early when directory does not exist", () => {
      deleteExpiredConversationLog();
      assert.equal(
        testFs._dirs.has("/fake-home/.local/state/lasso/conversation"),
        false,
      );
    });

    it("deletes expired files older than 24 hours", () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/conversation");
      testFs._files.set(
        "/fake-home/.local/state/lasso/conversation/conversation-log-999900000000.json",
        "old",
      );
      deleteExpiredConversationLog();
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/conversation/conversation-log-999900000000.json",
        ),
        false,
      );
    });

    it("keeps files newer than 24 hours", () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/conversation");
      testFs._files.set(
        "/fake-home/.local/state/lasso/conversation/conversation-log-999990000000.json",
        "new",
      );
      deleteExpiredConversationLog();
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/conversation/conversation-log-999990000000.json",
        ),
        true,
      );
    });

    it("skips files without correct format", () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/conversation");
      testFs._files.set(
        "/fake-home/.local/state/lasso/conversation/random-file.log",
        "",
      );
      testFs._files.set(
        "/fake-home/.local/state/lasso/conversation/chat-history-999990000001.md",
        "",
      );
      deleteExpiredConversationLog();
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/conversation/random-file.log",
        ),
        true,
      );
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/conversation/chat-history-999990000001.md",
        ),
        true,
      );
    });

    it("skips non-conversation-log files with 4 parts", () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/conversation");
      testFs._files.set(
        "/fake-home/.local/state/lasso/conversation/conversation-log-uuid-999997600000.json",
        "",
      );
      deleteExpiredConversationLog();
      assert.equal(
        testFs._files.has(
          "/fake-home/.local/state/lasso/conversation/conversation-log-uuid-999997600000.json",
        ),
        true,
      );
    });
  });
});
