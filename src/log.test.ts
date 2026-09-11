import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  prependToChatHistory,
  initPromptHistory,
  deleteExpiredPromptHistory,
} from "./log.ts";
import { actions, getState } from "./state.ts";
import { testFs, setupTestContext } from "./test-helpers.ts";
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

    it("appends content with timestamp and role", () => {
      actions.setChatHistoryPath("/test/editor.log");
      testFs._files.set("/test/editor.log", "");
      prependToChatHistory("test content", "user");
      assert.equal(
        testFs._files.get("/test/editor.log"),
        `
2023-11-14T22:13:20.000Z  *user*
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
        `
2023-11-14T22:13:20.000Z  *assistant*
response

---

2023-11-14T22:13:20.000Z  *user*
hello

---
`,
      );
    });
  });

  describe("initPromptHistory", () => {
    beforeEach(() => {
      mock.restoreAll();
      setupTestContext({ now: 1_234_567_890_000 });
    });

    it("creates directory and sets path when directory does not exist", () => {
      initPromptHistory();
      assert.equal(testFs._dirs.has("/fake-home/.config/lasso/history"), true);
      assert.equal(
        getState().app.chatHistoryPath,
        "/fake-home/.config/lasso/history/chat-history-1234567890000.md",
      );
      assert.equal(
        testFs._files.get(
          "/fake-home/.config/lasso/history/chat-history-1234567890000.md",
        ),
        "",
      );
    });

    it("disables history when mkdir fails", () => {
      mock.method(fsDeps, "existsSync", () => false);
      mock.method(fsDeps, "mkdirSync", () => {
        throw new Error("Permission denied");
      });
      initPromptHistory();
      assert.equal(getState().app.chatHistoryPath, "");
    });

    it("generates correct log path with session start date", () => {
      initPromptHistory();
      assert.equal(
        getState().app.chatHistoryPath,
        "/fake-home/.config/lasso/history/chat-history-1234567890000.md",
      );
      assert.equal(
        testFs._files.get(
          "/fake-home/.config/lasso/history/chat-history-1234567890000.md",
        ),
        "",
      );
    });
  });

  describe("deleteExpiredPromptHistory", () => {
    beforeEach(() => {
      mock.restoreAll();
      setupTestContext({ now: 1_000_000_000_000 });
    });

    it("returns early when directory does not exist", () => {
      deleteExpiredPromptHistory();
      assert.equal(testFs._dirs.has("/fake-home/.config/lasso/history"), false);
    });

    it("deletes expired files older than 24 hours", () => {
      testFs._dirs.add("/fake-home/.config/lasso/history");
      testFs._files.set(
        "/fake-home/.config/lasso/history/chat-history-999900000000.md",
        "old",
      );
      deleteExpiredPromptHistory();
      assert.equal(
        testFs._files.has(
          "/fake-home/.config/lasso/history/chat-history-999900000000.md",
        ),
        false,
      );
    });

    it("keeps files newer than 24 hours", () => {
      testFs._dirs.add("/fake-home/.config/lasso/history");
      testFs._files.set(
        "/fake-home/.config/lasso/history/chat-history-999990000000.md",
        "new",
      );
      deleteExpiredPromptHistory();
      assert.equal(
        testFs._files.has(
          "/fake-home/.config/lasso/history/chat-history-999990000000.md",
        ),
        true,
      );
    });

    it("skips files without correct format", () => {
      testFs._dirs.add("/fake-home/.config/lasso/history");
      testFs._files.set("/fake-home/.config/lasso/history/random-file.log", "");
      testFs._files.set(
        "/fake-home/.config/lasso/history/other-uuid-123-notimestamp.log",
        "",
      );
      testFs._files.set(
        "/fake-home/.config/lasso/history/prompt-history-uuid-999990000001.log",
        "",
      );
      deleteExpiredPromptHistory();
      assert.equal(
        testFs._files.has("/fake-home/.config/lasso/history/random-file.log"),
        true,
      );
      assert.equal(
        testFs._files.has(
          "/fake-home/.config/lasso/history/other-uuid-123-notimestamp.log",
        ),
        true,
      );
      assert.equal(
        testFs._files.has(
          "/fake-home/.config/lasso/history/prompt-history-uuid-999990000001.log",
        ),
        true,
      );
    });

    it("skips non-chat-history files with 4 parts", () => {
      testFs._dirs.add("/fake-home/.config/lasso/history");
      testFs._files.set(
        "/fake-home/.config/lasso/history/chat-history-uuid-999997600000.md",
        "",
      );
      deleteExpiredPromptHistory();
      assert.equal(
        testFs._files.has(
          "/fake-home/.config/lasso/history/chat-history-uuid-999997600000.md",
        ),
        true,
      );
    });
  });
});
