import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { childProcessDeps, fsDeps } from "./deps.ts";
import { getGlobalConfigPath, getLocalConfigPath } from "./paths.ts";
import { actions, getState } from "./state.ts";
import {
  executeBat,
  formatMarkdown,
  openWithPager,
  warnOnMissingBat,
} from "./terminal.ts";
import {
  batPagerCmd,
  mockExec,
  mockSpawnSync,
  mockStdoutWrites,
  mockPagerSpawn,
  setupTestContext,
  testFs,
  testProcessEnv,
  YELLOW,
  RED,
  RESET,
} from "./test-helpers.ts";

describe("terminal", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  describe("openWithPager", () => {
    beforeEach(() => {
      setupTestContext();
    });

    let spawned: string[];

    beforeEach(() => {
      spawned = mockPagerSpawn().spawned;
      actions.setBatAvailable(true);
    });

    describe("selects the pager", () => {
      it("ignores per-view pager env vars in favor of LASSO_PAGER", async () => {
        testProcessEnv._set("LASSO_PAGER_HISTORY", "nano __FILE__");
        testProcessEnv._set("LASSO_PAGER", "bat __FILE__");
        await openWithPager({
          initialContentStr: "",
          contentType: "markdown",
        });
        assert.strictEqual(spawned[0], "bat /tmp/lasso-test-uuid.txt");
      });

      it("falls back to LASSO_PAGER env var", async () => {
        testProcessEnv._set("LASSO_PAGER", "bat __FILE__");
        await openWithPager({
          initialContentStr: "",
          contentType: "markdown",
        });
        assert.strictEqual(spawned[0], "bat /tmp/lasso-test-uuid.txt");
      });

      it("falls back to PAGER env var with quoted temp file", async () => {
        testProcessEnv._set("PAGER", "more");
        await openWithPager({
          initialContentStr: "",
          contentType: "markdown",
        });
        assert.strictEqual(spawned[0], `more "/tmp/lasso-test-uuid.txt"`);
      });

      it("falls back to bat", async () => {
        await openWithPager({
          initialContentStr: "",
          contentType: "markdown",
        });
        assert.strictEqual(spawned[0], batPagerCmd("/tmp/lasso-test-uuid.txt"));
      });

      it("falls back to less when bat is unavailable", async () => {
        actions.setBatAvailable(false);
        await openWithPager({
          initialContentStr: "",
          contentType: "markdown",
        });
        assert.strictEqual(spawned[0], `less "/tmp/lasso-test-uuid.txt"`);
      });
    });

    describe("spawns the pager", () => {
      it("uses base bat flags without markdown flags for diff contentType", async () => {
        await openWithPager({
          initialContentStr: "",
          contentType: "diff",
        });
        assert.strictEqual(
          spawned[0],
          batPagerCmd("/tmp/lasso-test-uuid.txt", "diff"),
        );
      });

      it("spawns pager with shell and inherit stdio", async () => {
        let spawnArgs: unknown[] = [];
        mock.method(childProcessDeps, "spawnSync", (...args: unknown[]) => {
          spawnArgs = args;
        });
        await openWithPager({
          initialContentStr: "",
          contentType: "markdown",
        });
        assert.deepStrictEqual(spawnArgs, [
          batPagerCmd("/tmp/lasso-test-uuid.txt"),
          { shell: true, stdio: "inherit" },
        ]);
      });

      it("writes initialContentStr into the temp file", async () => {
        await openWithPager({
          initialContentStr: "string content",
          contentType: "markdown",
        });
        assert.strictEqual(
          testFs._files.get("/tmp/lasso-test-uuid.txt"),
          "string content\n\n",
        );
      });

      it("trims trailing newlines before appending exactly two", async () => {
        await openWithPager({
          initialContentStr: "content\n\n\n\n",
          contentType: "markdown",
        });
        assert.strictEqual(
          testFs._files.get("/tmp/lasso-test-uuid.txt"),
          "content\n\n",
        );
      });

      it("does not spawn a pager when the temp file cannot be created", async () => {
        mock.method(fsDeps, "writeFile", () =>
          Promise.reject(new Error("write failed")),
        );
        await openWithPager({
          initialContentStr: "content",
          contentType: "markdown",
        });
        assert.deepStrictEqual(spawned, []);
      });
    });
  });

  describe("formatMarkdown", () => {
    it("formats markdown tables with aligned columns", async () => {
      const unaligned = `|a|b|
|-|-|
|x|y|`;
      const result = await formatMarkdown(unaligned);
      assert.strictEqual(
        result,
        `| a   | b   |
| --- | --- |
| x   | y   |
`,
      );
    });

    it("returns original content and warns when formatting fails", async () => {
      const getWrites = mockStdoutWrites();
      const invalid = null as unknown as string;
      const result = await formatMarkdown(invalid);
      assert.equal(result, invalid);
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}Outputting raw content, markdown formatting failed: Cannot read properties of null (reading 'length')${RESET}\n`,
      ]);
    });
  });

  describe("executeBat", () => {
    beforeEach(() => {
      mock.restoreAll();
      actions.resetState();
      actions.setModel("test-model");
    });

    describe("uses the bat output", () => {
      it("formats markdown and outputs the content through bat when available", async () => {
        actions.setBatAvailable(true);
        mockSpawnSync({ echoInput: true });

        const getWrites = mockStdoutWrites();

        await executeBat("# Hello\n");

        assert.deepStrictEqual(getWrites(), ["# Hello\n\n"]);
      });

      it("prints bat stdout when status is null", async () => {
        actions.setBatAvailable(true);
        mockSpawnSync({
          result: { status: null, stdout: "bat-rendered\n", stderr: "" },
        });

        const getWrites = mockStdoutWrites();

        await executeBat("test content\n");

        assert.deepStrictEqual(getWrites(), ["bat-rendered\n\n"]);
      });

      it("prints bat stdout when stderr is empty", async () => {
        actions.setBatAvailable(true);
        mockSpawnSync({
          result: { status: 0, stdout: "bat-rendered\n", stderr: "" },
        });

        const getWrites = mockStdoutWrites();

        await executeBat("test content\n");

        assert.deepStrictEqual(getWrites(), ["bat-rendered\n\n"]);
      });
    });

    describe("falls back to plain text", () => {
      it("falls back to plain text when bat is not available", async () => {
        actions.setBatAvailable(false);

        const getWrites = mockStdoutWrites();

        await executeBat("test content\n");

        assert.deepStrictEqual(getWrites(), ["test content\n\n"]);
      });

      it("falls back to plain text when bat spawn fails", async () => {
        actions.setBatAvailable(true);
        mockSpawnSync({ error: new Error("spawn failed") });

        const getWrites = mockStdoutWrites();

        await executeBat("test content\n");

        assert.deepStrictEqual(getWrites(), [
          `${RED}Falling back to plain text rendering, an error occurred when spawning \`bat\`: spawn failed${RESET}\n`,
          "test content\n\n",
        ]);
      });

      it("falls back to plain text when bat exits with non-zero status", async () => {
        actions.setBatAvailable(true);
        mockSpawnSync({
          result: { status: 1, stdout: "bat-rendered\n", stderr: "bat error" },
        });

        const getWrites = mockStdoutWrites();

        await executeBat("test content\n");

        assert.deepStrictEqual(getWrites(), [
          `${RED}Falling back to plain text rendering, an error occurred when spawning \`bat\`: \`bat\` returned code 1${RESET}\n`,
          "test content\n\n",
        ]);
      });

      it("falls back to plain text when bat writes stderr", async () => {
        actions.setBatAvailable(true);
        mockSpawnSync({
          result: {
            status: 0,
            stdout: "bat-rendered\n",
            stderr: "bat warning",
          },
        });

        const getWrites = mockStdoutWrites();

        await executeBat("test content\n");

        assert.deepStrictEqual(getWrites(), [
          `${RED}Falling back to plain text rendering, an error occurred when spawning \`bat\`: bat warning${RESET}\n`,
          "test content\n\n",
        ]);
      });
    });
  });

  describe("warnOnMissingBat", () => {
    beforeEach(() => {
      mock.restoreAll();
      actions.resetState();
    });

    it("warns when bat is not available", async () => {
      mockExec({ stdout: "", error: new Error("not found") });

      const getWrites = mockStdoutWrites();

      await warnOnMissingBat();

      assert.strictEqual(getState().app.batAvailable, false);
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}\`bat\` is not available, consider installing it to properly render markdown responses in the terminal. Suppress this warning with \`suppressBatUnavailableWarning: true\` in ${getGlobalConfigPath()} or ${getLocalConfigPath()}${RESET}\n`,
      ]);
    });

    it("does not warn when bat is available", async () => {
      mockExec({ stdout: "bat 0.25.0" });

      const getWrites = mockStdoutWrites();

      await warnOnMissingBat();

      assert.strictEqual(getState().app.batAvailable, true);
      assert.deepStrictEqual(getWrites(), []);
    });

    it("does not warn when bat is unavailable and the warning is suppressed", async () => {
      mockExec({ stdout: "", error: new Error("not found") });
      actions.setSuppressBatUnavailableWarning(true);

      const getWrites = mockStdoutWrites();

      await warnOnMissingBat();

      assert.strictEqual(getState().app.batAvailable, false);
      assert.deepStrictEqual(getWrites(), []);
    });
  });
});
