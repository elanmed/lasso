import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { createToolCallDiffer, execGitDiff } from "./differ.ts";
import { fsDeps } from "./deps.ts";
import { actions, getState } from "./state.ts";
import {
  BOLD,
  BOLD_RESET,
  GREY,
  mockExecCalls,
  mockStdoutWrites,
  RED,
  RESET,
  setupTestContext,
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

    describe("snapshots", () => {
      it("creates and cleans up a tool call snapshot", async () => {
        testFs._files.set("/source/file.txt", "original content");
        const differ = createToolCallDiffer();

        await differ.setTempFileBefore("call-1", "/source/file.txt");

        assert.strictEqual(
          testFs._files.get("/tmp/lasso-test-uuid.txt"),
          "original content",
        );
        assert.strictEqual(
          differ.getTempFileBefore("call-1"),
          "/tmp/lasso-test-uuid.txt",
        );

        await differ.cleanupTempFileBefore("call-1");

        assert.strictEqual(
          testFs._files.has("/tmp/lasso-test-uuid.txt"),
          false,
        );
        assert.strictEqual(
          differ.toolCallIdToTempFileBefore.has("call-1"),
          false,
        );
      });

      it("warns when the before temp file cannot be created", async () => {
        testFs._files.set("/test/file.txt", "original content");
        mock.method(fsDeps, "writeFile", () =>
          Promise.reject(new Error("write failed")),
        );
        const writes = mockStdoutWrites();

        const differ = createToolCallDiffer();
        await differ.setTempFileBefore("call-1", "/test/file.txt");
        await differ.diffAndCleanup("call-1", "/test/file.txt");

        assert.deepStrictEqual(writes(), [
          `${RED}Failed to create the before diff temp file for /test/file.txt${RESET}\n`,
          `${RED}Failed to create the after diff temp file for /test/file.txt${RESET}\n`,
        ]);
        assert.deepStrictEqual(getState().conversation.toolEditDiffs, []);
      });

      it("registers an empty snapshot when the source file does not exist", async () => {
        const differ = createToolCallDiffer();

        await differ.setTempFileBefore("call-1", "/missing/file.txt");

        assert.equal(testFs._files.get("/tmp/lasso-test-uuid.txt"), "");
        assert.equal(
          differ.toolCallIdToTempFileBefore.get("call-1"),
          "/tmp/lasso-test-uuid.txt",
        );
      });

      it("cleans up an empty snapshot", async () => {
        const differ = createToolCallDiffer();

        await differ.setTempFileBefore("call-1", "/missing/file.txt");
        await differ.cleanupTempFileBefore("call-1");

        assert.equal(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
        assert.equal(differ.toolCallIdToTempFileBefore.has("call-1"), false);
      });

      it("cleans up all empty snapshots", async () => {
        const differ = createToolCallDiffer();

        await differ.setTempFileBefore("call-1", "/missing/a.txt");
        await differ.setTempFileBefore("call-2", "/missing/b.txt");
        await differ.cleanupAllTempFileBefore();

        assert.deepStrictEqual(
          [...differ.toolCallIdToTempFileBefore.keys()],
          [],
        );
        assert.equal(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
      });

      it("cleans up all outstanding tool call snapshots", async () => {
        const differ = createToolCallDiffer();
        await differ.setTempFileBefore("call-1", "/a");
        await differ.setTempFileBefore("call-2", "/b");

        await differ.cleanupAllTempFileBefore();

        assert.strictEqual(
          testFs._files.has("/tmp/lasso-test-uuid.txt"),
          false,
        );
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

    describe("ignored paths", () => {
      it("does not snapshot ignores-path files", async () => {
        testFs._files.set("/tmp/file.txt", "original content");
        const differ = createToolCallDiffer();

        await differ.setTempFileBefore("call-1", "/tmp/file.txt");

        assert.equal(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
        assert.equal(differ.toolCallIdToTempFileBefore.has("call-1"), false);
      });

      it("does not diff and cleans up the after file for ignored paths", async () => {
        const commands: string[] = [];
        const getWrites = mockStdoutWrites();
        const differ = createToolCallDiffer();
        mockExecCalls([], commands);

        await differ.setTempFileBefore("call-1", "/tmp/file.txt");
        testFs._files.set("/tmp/file.txt", "new content");
        await differ.diffAndCleanup("call-1", "/tmp/file.txt");

        assert.equal(commands.length, 0);
        assert.deepStrictEqual(getWrites(), []);
        assert.deepStrictEqual(getState().conversation.toolEditDiffs, []);
      });
    });

    describe("diffs", () => {
      it("prints and records the diff for a newly-created file", async () => {
        const commands: string[] = [];
        const getWrites = mockStdoutWrites();
        const differ = createToolCallDiffer();
        mockExecCalls(
          [{ stdout: "delta 0.18.2" }, { stdout: "+created content\n" }],
          commands,
        );

        await differ.setTempFileBefore("call-1", "/test/new-file.txt");
        testFs._files.set("/test/new-file.txt", "created content");
        await differ.diffAndCleanup("call-1", "/test/new-file.txt");

        assert.equal(commands.length, 2);
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${GREY}━━ ${BOLD}File change: /test/new-file.txt${BOLD_RESET} ━━${RESET}\n`,
          "+created content\n\n",
        ]);
        assert.deepStrictEqual(getState().conversation.toolEditDiffs, [
          { fileName: "/test/new-file.txt", diffStdout: "+created content\n" },
        ]);
        assert.equal(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
        assert.equal(differ.toolCallIdToTempFileBefore.has("call-1"), false);
      });

      it("suppresses printing, continues recording tool edit diffs", async () => {
        const commands: string[] = [];
        const getWrites = mockStdoutWrites();
        const differ = createToolCallDiffer();
        mockExecCalls(
          [{ stdout: "delta 0.18.2" }, { stdout: "+created content\n" }],
          commands,
        );
        actions.setSuppressToolEditDiffs(true);

        await differ.setTempFileBefore("call-1", "/test/new-file.txt");
        testFs._files.set("/test/new-file.txt", "created content");
        await differ.diffAndCleanup("call-1", "/test/new-file.txt");

        assert.equal(commands.length, 2);
        assert.deepStrictEqual(getWrites(), []);
        assert.deepStrictEqual(getState().conversation.toolEditDiffs, [
          { fileName: "/test/new-file.txt", diffStdout: "+created content\n" },
        ]);
        assert.equal(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
        assert.equal(differ.toolCallIdToTempFileBefore.has("call-1"), false);
      });

      it("diffs a deleted file against an empty after snapshot", async () => {
        testFs._files.set("/source/file.txt", "original content");
        const commands: string[] = [];
        const differ = createToolCallDiffer();
        mockExecCalls(
          [{ stdout: "delta 0.18.2" }, { stdout: "diff output" }],
          commands,
        );

        await differ.setTempFileBefore("call-1", "/source/file.txt");
        await differ.diffAndCleanup("call-1", "/missing/after.txt");

        assert.equal(commands.length, 2);
        assert.deepStrictEqual(getState().conversation.toolEditDiffs, [
          { fileName: "/missing/after.txt", diffStdout: "diff output" },
        ]);
        assert.equal(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
        assert.equal(differ.toolCallIdToTempFileBefore.has("call-1"), false);
      });

      it("diffs and cleans up a successful tool call", async () => {
        testFs._files.set("/test/file.txt", "original content");
        const commands: string[] = [];
        const differ = createToolCallDiffer();
        mockExecCalls(
          [{ stdout: "delta 0.18.2" }, { stdout: "diff output" }],
          commands,
        );

        await differ.setTempFileBefore("call-1", "/test/file.txt");
        await differ.diffAndCleanup("call-1", "/test/file.txt");

        assert.strictEqual(
          commands[1],
          "git diff --no-index --color=always -U3 /tmp/lasso-test-uuid.txt /tmp/lasso-test-uuid.txt | delta --paging=never --line-numbers --hunk-header-style=omit --file-style=omit",
        );
        assert.strictEqual(
          testFs._files.has("/tmp/lasso-test-uuid.txt"),
          false,
        );
        assert.strictEqual(
          differ.toolCallIdToTempFileBefore.has("call-1"),
          false,
        );
        assert.deepStrictEqual(getState().conversation.toolEditDiffs, [
          { fileName: "/test/file.txt", diffStdout: "diff output" },
        ]);
      });

      it("appends the diff to state and does not print an error when the diff command succeeds", async () => {
        testFs._files.set("/test/file.txt", "original content");
        const getWrites = mockStdoutWrites();
        const differ = createToolCallDiffer();
        mockExecCalls([
          { stdout: "delta 0.18.2" },
          { stdout: "+added line\n" },
        ]);

        await differ.setTempFileBefore("call-1", "/test/file.txt");
        await differ.diffAndCleanup("call-1", "/test/file.txt");

        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${GREY}━━ ${BOLD}File change: /test/file.txt${BOLD_RESET} ━━${RESET}\n`,
          "+added line\n\n",
        ]);
      });
    });
  });

  describe("execGitDiff", () => {
    beforeEach(() => {
      setupTestContext();
    });

    describe("uses delta", () => {
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
    });

    describe("plain git diff", () => {
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
    });

    describe("rejects on errors", () => {
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
  });

  describe("diffAndCleanup error and empty output", () => {
    beforeEach(() => {
      setupTestContext();
    });

    it("prints an error and skips appending when the diff command fails", async () => {
      const getWrites = mockStdoutWrites();
      const err = new Error("fatal") as Error & { code: number };
      err.code = 128;
      mockExecCalls([{ stdout: "delta 0.18.2" }, { stdout: "", error: err }]);
      const differ = createToolCallDiffer();
      testFs._files.set("/test/file.txt", "original content");
      await differ.setTempFileBefore("call-1", "/test/file.txt");
      await differ.diffAndCleanup("call-1", "/test/file.txt");
      assert.deepStrictEqual(getWrites(), [
        `${RED}An error occurred when getting the diff for /test/file.txt: fatal${RESET}\n`,
      ]);
      assert.deepStrictEqual(getState().conversation.toolEditDiffs, []);
    });

    it("warns when the after temp file cannot be created", async () => {
      const writes = mockStdoutWrites();
      testFs._files.set("/test/file.txt", "original content");
      const differ = createToolCallDiffer();
      await differ.setTempFileBefore("call-1", "/test/file.txt");
      mock.method(fsDeps, "writeFile", () =>
        Promise.reject(new Error("write failed")),
      );

      await differ.diffAndCleanup("call-1", "/test/file.txt");

      assert.deepStrictEqual(writes(), [
        `${RED}Failed to create the after diff temp file for /test/file.txt${RESET}\n`,
      ]);
      assert.deepStrictEqual(getState().conversation.toolEditDiffs, []);
    });

    it("does not append or print when the diff stdout is empty", async () => {
      const getWrites = mockStdoutWrites();
      testFs._files.set("/test/file.txt", "original content");
      mockExecCalls([{ stdout: "delta 0.18.2" }, { stdout: "" }]);
      const differ = createToolCallDiffer();
      await differ.setTempFileBefore("call-1", "/test/file.txt");
      await differ.diffAndCleanup("call-1", "/test/file.txt");
      assert.deepStrictEqual(getWrites(), []);
      assert.deepStrictEqual(getState().conversation.toolEditDiffs, []);
    });
  });
});
