import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { createToolCallDiffer, execGitDiff } from "./differ.ts";
import { getState } from "./state.ts";
import {
  mockExecCalls,
  mockStdout,
  setupTestContext,
  stripAnsi,
  testFs,
} from "./test-helpers.ts";

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

      differ.setTempFileBefore("call-1", "/source/file.txt");

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

    it("skips registration when the source file cannot be read", () => {
      const differ = createToolCallDiffer();

      differ.setTempFileBefore("call-1", "/missing/file.txt");

      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
      assert.strictEqual(
        differ.toolCallIdToTempFileBefore.has("call-1"),
        false,
      );
    });

    it("cleans up a snapshot whose temp file was never written", () => {
      const differ = createToolCallDiffer();

      differ.setTempFileBefore("call-1", "/missing/file.txt");

      differ.cleanupTempFileBefore("call-1");

      assert.strictEqual(
        differ.toolCallIdToTempFileBefore.has("call-1"),
        false,
      );
    });

    it("cleans up all snapshots whose temp files were never written", () => {
      const differ = createToolCallDiffer();

      differ.setTempFileBefore("call-1", "/missing/a.txt");
      differ.setTempFileBefore("call-2", "/missing/b.txt");

      differ.cleanupAllTempFileBefore();

      assert.deepStrictEqual([...differ.toolCallIdToTempFileBefore.keys()], []);
    });

    it("skipped the diff for a newly-created file with no before snapshot", async () => {
      const commands: string[] = [];
      const differ = createToolCallDiffer();
      mockExecCalls(
        [{ stdout: "delta 0.18.2" }, { stdout: "diff output" }],
        commands,
      );

      differ.setTempFileBefore("call-1", "/test/new-file.txt");
      testFs._files.set("/test/new-file.txt", "created content");
      await differ.diffAndCleanup("call-1", "/test/new-file.txt");

      assert.deepStrictEqual(commands, []);
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
      assert.strictEqual(
        differ.toolCallIdToTempFileBefore.has("call-1"),
        false,
      );
    });

    it("cleans up before snapshot and skips the diff when after snapshot cannot be created", async () => {
      testFs._files.set("/source/file.txt", "original content");
      const commands: string[] = [];
      const differ = createToolCallDiffer();
      mockExecCalls(
        [{ stdout: "delta 0.18.2" }, { stdout: "diff output" }],
        commands,
      );

      differ.setTempFileBefore("call-1", "/source/file.txt");
      await differ.diffAndCleanup("call-1", "/missing/after.txt");

      assert.deepStrictEqual(commands, []);
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

      differ.setTempFileBefore("call-1", "/test/file.txt");
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
      assert.deepStrictEqual(getState().app.toolEditDiffs, [
        { fileName: "/test/file.txt", diffStdout: "diff output" },
      ]);
    });

    it("appends the diff to state and does not print an error when the diff command succeeds", async () => {
      testFs._files.set("/test/file.txt", "original content");
      const getCaptured = mockStdout();
      const differ = createToolCallDiffer();
      mockExecCalls([{ stdout: "delta 0.18.2" }, { stdout: "+added line\n" }]);

      differ.setTempFileBefore("call-1", "/test/file.txt");
      await differ.diffAndCleanup("call-1", "/test/file.txt");

      assert.strictEqual(
        stripAnsi(getCaptured()),
        `━━ File change: /test/file.txt ━━
+added line

`,
      );
    });

    it("cleans up all outstanding tool call snapshots", () => {
      const differ = createToolCallDiffer();
      differ.setTempFileBefore("call-1", "/a");
      differ.setTempFileBefore("call-2", "/b");

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

    it("resolves on plain git diff error with an unexpected low exit code", async () => {
      const err = new Error("unexpected failure") as Error & {
        code: number;
      };
      err.code = 3;
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

    it("rejects when plain git diff exits with code 2 (usage error)", async () => {
      const err = new Error("usage error") as Error & { code: number };
      err.code = 2;
      mockExecCalls([
        { stdout: "", error: new Error("not found") },
        { stdout: "", error: err },
      ]);
      await assert.rejects(
        execGitDiff({ tempFileBeforePath: "a", tempFileAfterPath: "b" }),
        /usage error/,
      );
    });

    it("rejects when git is not installed (plain git diff exit code 127)", async () => {
      const err = new Error("git: command not found") as Error & {
        code: number;
      };
      err.code = 127;
      mockExecCalls([
        { stdout: "", error: new Error("not found") },
        { stdout: "", error: err },
      ]);
      await assert.rejects(
        execGitDiff({ tempFileBeforePath: "a", tempFileAfterPath: "b" }),
        /command not found/,
      );
    });

    it("rejects when plain git diff is killed by a signal (141)", async () => {
      const err = new Error("killed") as Error & { code: number };
      err.code = 141;
      mockExecCalls([
        { stdout: "", error: new Error("not found") },
        { stdout: "", error: err },
      ]);
      await assert.rejects(
        execGitDiff({ tempFileBeforePath: "a", tempFileAfterPath: "b" }),
        /killed/,
      );
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

  describe("diffAndCleanup error and empty output", () => {
    beforeEach(() => {
      setupTestContext();
    });

    it("prints an error and skips appending when the diff command fails", async () => {
      const getCaptured = mockStdout();
      const err = new Error("fatal") as Error & { code: number };
      err.code = 128;
      mockExecCalls([{ stdout: "delta 0.18.2" }, { stdout: "", error: err }]);
      const differ = createToolCallDiffer();
      testFs._files.set("/test/file.txt", "original content");
      differ.setTempFileBefore("call-1", "/test/file.txt");
      await differ.diffAndCleanup("call-1", "/test/file.txt");
      assert.strictEqual(
        stripAnsi(getCaptured()),
        "An error occurred when getting the diff for /test/file.txt: fatal\n",
      );
      assert.deepStrictEqual(getState().app.toolEditDiffs, []);
    });

    it("does not append or print when the diff stdout is empty", async () => {
      const getCaptured = mockStdout();
      testFs._files.set("/test/file.txt", "original content");
      mockExecCalls([{ stdout: "delta 0.18.2" }, { stdout: "" }]);
      const differ = createToolCallDiffer();
      differ.setTempFileBefore("call-1", "/test/file.txt");
      await differ.diffAndCleanup("call-1", "/test/file.txt");
      assert.strictEqual(stripAnsi(getCaptured()), "");
      assert.deepStrictEqual(getState().app.toolEditDiffs, []);
    });
  });
});
