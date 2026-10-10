import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { writeDebugLog } from "./utils.ts";
import { setupTestContext, testFs } from "./test-helpers.ts";

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
