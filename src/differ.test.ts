import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";

import { createToolCallDiffer, execGitDiff } from "./differ.ts";
import { mockExecCalls, setupTestContext, testFs } from "./test-helpers.ts";

describe("differ", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe("createToolCallDiffer", () => {
    beforeEach(() => {
      setupTestContext();
    });

    it("creates and cleans up a tool call snapshot", () => {
      testFs._files.set("/source/file.txt", "original content");
      const differ = createToolCallDiffer();

      differ.setTempFileBefore("call-1", {
        initialContentPath: "/source/file.txt",
      });

      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        "original content",
      );
      assert.strictEqual(
        differ.getTempFileBefore("call-1"),
        "/tmp/lasso-test-uuid.txt",
      );

      differ.cleanupTempFileBefore("call-1");

      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
      assert.strictEqual(
        differ.toolCallIdToTempFileBefore.has("call-1"),
        false,
      );
    });

    it("diffs and cleans up a successful tool call", async () => {
      testFs._files.set("/test/file.txt", "original content");
      const commands: string[] = [];
      const differ = createToolCallDiffer();
      mockExecCalls(
        [{ stdout: "delta 0.18.2" }, { stdout: "diff output" }],
        commands,
      );

      differ.setTempFileBefore("call-1", {
        initialContentPath: "/test/file.txt",
      });
      await differ.diffAndCleanup("call-1", "/test/file.txt");

      assert.strictEqual(
        commands[1],
        "git diff --no-index --color=always -U3 /tmp/lasso-test-uuid.txt /tmp/lasso-test-uuid.txt | delta --paging=never --line-numbers --hunk-header-style=omit --file-style=omit",
      );
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
      assert.strictEqual(
        differ.toolCallIdToTempFileBefore.has("call-1"),
        false,
      );
    });

    it("cleans up all outstanding tool call snapshots", () => {
      const differ = createToolCallDiffer();
      differ.setTempFileBefore("call-1");
      differ.setTempFileBefore("call-2");

      differ.cleanupAllTempFileBefore();

      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
      assert.strictEqual(
        differ.toolCallIdToTempFileBefore.has("call-1"),
        false,
      );
      assert.strictEqual(
        differ.toolCallIdToTempFileBefore.has("call-2"),
        false,
      );
    });
  });

  describe("execGitDiff", () => {
    beforeEach(() => {
      setupTestContext();
    });

    it("uses delta and three context lines by default", async () => {
      const commands: string[] = [];
      mockExecCalls(
        [{ stdout: "delta 0.18.2" }, { stdout: "diff output" }],
        commands,
      );
      const result = await execGitDiff({
        tempFileBeforePath: "a",
        tempFileAfterPath: "b",
      });
      assert.deepStrictEqual(result, { stdout: "diff output", stderr: "" });
      assert.deepStrictEqual(commands, [
        "delta --version",
        "git diff --no-index --color=always -U3 a b | delta --paging=never --line-numbers --hunk-header-style=omit --file-style=omit",
      ]);
    });

    it("includes the filename when requested", async () => {
      const commands: string[] = [];
      mockExecCalls(
        [{ stdout: "delta 0.18.2" }, { stdout: "diff output" }],
        commands,
      );
      await execGitDiff({
        tempFileBeforePath: "a",
        tempFileAfterPath: "b",
        includeFilename: true,
      });
      assert.strictEqual(
        commands[1],
        "git diff --no-index --color=always -U3 a b | delta --paging=never --line-numbers --hunk-header-style=omit --file-style=normal",
      );
    });

    it("resolves when delta exits with code 1 (differences found)", async () => {
      const err = new Error("diff failed") as Error & { code: number };
      err.code = 1;
      mockExecCalls([{ stdout: "delta 0.18.2" }, { stdout: "", error: err }]);
      const result = await execGitDiff({
        tempFileBeforePath: "a",
        tempFileAfterPath: "b",
      });
      assert.deepStrictEqual(result, { stdout: "", stderr: "" });
    });

    it("falls back to plain git diff when delta is not available", async () => {
      mockExecCalls([
        { stdout: "", error: new Error("not found") },
        { stdout: "plain diff" },
      ]);
      const result = await execGitDiff({
        tempFileBeforePath: "a",
        tempFileAfterPath: "b",
      });
      assert.deepStrictEqual(result, { stdout: "plain diff", stderr: "" });
    });

    it("resolves when plain git diff exits with code 1 (differences found)", async () => {
      const err = new Error("diff failed") as Error & { code: number };
      err.code = 1;
      mockExecCalls([
        { stdout: "", error: new Error("not found") },
        { stdout: "", error: err },
      ]);
      const result = await execGitDiff({
        tempFileBeforePath: "a",
        tempFileAfterPath: "b",
      });
      assert.deepStrictEqual(result, { stdout: "", stderr: "" });
    });

    it("resolves on plain git diff error with code below 128", async () => {
      const err = new Error("git: command not found") as Error & {
        code: number;
      };
      err.code = 127;
      mockExecCalls([
        { stdout: "", error: new Error("not found") },
        { stdout: "", error: err },
      ]);
      const result = await execGitDiff({
        tempFileBeforePath: "a",
        tempFileAfterPath: "b",
      });
      assert.deepStrictEqual(result, { stdout: "", stderr: "" });
    });

    it("rejects on fatal plain git diff error", async () => {
      const err = new Error("fatal") as Error & { code: number };
      err.code = 128;
      mockExecCalls([
        { stdout: "", error: new Error("not found") },
        { stdout: "", error: err },
      ]);
      await assert.rejects(
        execGitDiff({ tempFileBeforePath: "a", tempFileAfterPath: "b" }),
        /fatal/,
      );
    });
  });
});
