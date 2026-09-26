import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import childProcess from "node:child_process";
import { fsDeps } from "./deps.ts";
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
  mockStdout,
  mockPagerSpawn,
  setupTestContext,
  stripAnsi,
  testFs,
  testProcessEnv,
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

    it("ignores per-view pager env vars in favor of LASSO_PAGER", () => {
      testProcessEnv._set("LASSO_PAGER_HISTORY", "nano __FILE__");
      testProcessEnv._set("LASSO_PAGER", "bat __FILE__");
      openWithPager({
        initialContentStr: "",
        contentType: "markdown",
      });
      assert.strictEqual(spawned[0], "bat /tmp/lasso-test-uuid.txt");
    });

    it("falls back to LASSO_PAGER env var", () => {
      testProcessEnv._set("LASSO_PAGER", "bat __FILE__");
      openWithPager({
        initialContentStr: "",
        contentType: "markdown",
      });
      assert.strictEqual(spawned[0], "bat /tmp/lasso-test-uuid.txt");
    });

    it("falls back to PAGER env var with quoted temp file", () => {
      testProcessEnv._set("PAGER", "more");
      openWithPager({
        initialContentStr: "",
        contentType: "markdown",
      });
      assert.strictEqual(spawned[0], `more "/tmp/lasso-test-uuid.txt"`);
    });

    it("falls back to bat", () => {
      openWithPager({
        initialContentStr: "",
        contentType: "markdown",
      });
      assert.strictEqual(spawned[0], batPagerCmd("/tmp/lasso-test-uuid.txt"));
    });

    it("uses base bat flags without markdown flags for diff contentType", () => {
      openWithPager({
        initialContentStr: "",
        contentType: "diff",
      });
      assert.strictEqual(
        spawned[0],
        batPagerCmd("/tmp/lasso-test-uuid.txt", "diff"),
      );
    });

    it("spawns pager with shell and inherit stdio", () => {
      let spawnArgs: unknown[] = [];
      mock.method(childProcess, "spawnSync", (...args: unknown[]) => {
        spawnArgs = args;
      });
      openWithPager({
        initialContentStr: "",
        contentType: "markdown",
      });
      assert.deepStrictEqual(spawnArgs, [
        batPagerCmd("/tmp/lasso-test-uuid.txt"),
        { shell: true, stdio: "inherit" },
      ]);
    });

    it("writes initialContentStr into the temp file", () => {
      openWithPager({
        initialContentStr: "string content",
        contentType: "markdown",
      });
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        "string content\n\n",
      );
    });

    it("trims trailing newlines before appending exactly two", () => {
      openWithPager({
        initialContentStr: "content\n\n\n\n",
        contentType: "markdown",
      });
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        "content\n\n",
      );
    });

    it("falls back to less when bat is unavailable", () => {
      actions.setBatAvailable(false);
      openWithPager({
        initialContentStr: "",
        contentType: "markdown",
      });
      assert.strictEqual(spawned[0], `less "/tmp/lasso-test-uuid.txt"`);
    });

    it("does not spawn a pager when the temp file cannot be created", () => {
      mock.method(fsDeps, "writeFileSync", () => {
        throw new Error("write failed");
      });
      openWithPager({
        initialContentStr: "content",
        contentType: "markdown",
      });
      assert.deepStrictEqual(spawned, []);
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
      const getCaptured = mockStdout();
      const invalid = null as unknown as string;
      const result = await formatMarkdown(invalid);
      assert.equal(result, invalid);
      assert.strictEqual(
        stripAnsi(getCaptured()),
        "Outputting raw content, markdown formatting failed: Cannot read properties of null (reading 'length')\n",
      );
    });
  });

  describe("executeBat", () => {
    beforeEach(() => {
      mock.restoreAll();
      actions.resetState();
      actions.setModel("test-model");
    });

    it("formats markdown and outputs the content through bat when available", async () => {
      actions.setBatAvailable(true);
      mockSpawnSync({ echoInput: true });

      const getCaptured = mockStdout();

      await executeBat("# Hello\n");

      assert.strictEqual(stripAnsi(getCaptured()), "# Hello\n\n");
    });

    it("falls back to plain text when bat is not available", async () => {
      actions.setBatAvailable(false);

      const getCaptured = mockStdout();

      await executeBat("test content\n");

      assert.strictEqual(stripAnsi(getCaptured()), "test content\n\n");
    });

    it("falls back to plain text when bat spawn fails", async () => {
      actions.setBatAvailable(true);
      mockSpawnSync({ error: new Error("spawn failed") });

      const getCaptured = mockStdout();

      await executeBat("test content\n");

      assert.strictEqual(
        stripAnsi(getCaptured()),
        `Falling back to plain text rendering, an error occurred when spawning \`bat\`: spawn failed
test content

`,
      );
    });

    it("falls back to plain text when bat exits with non-zero status", async () => {
      actions.setBatAvailable(true);
      mockSpawnSync({
        result: { status: 1, stdout: "bat-rendered\n", stderr: "bat error" },
      });

      const getCaptured = mockStdout();

      await executeBat("test content\n");

      assert.strictEqual(
        stripAnsi(getCaptured()),
        `Falling back to plain text rendering, an error occurred when spawning \`bat\`: \`bat\` returned code 1
test content

`,
      );
    });

    it("prints bat stdout when status is null", async () => {
      actions.setBatAvailable(true);
      mockSpawnSync({
        result: { status: null, stdout: "bat-rendered\n", stderr: "" },
      });

      const getCaptured = mockStdout();

      await executeBat("test content\n");

      assert.strictEqual(stripAnsi(getCaptured()), "bat-rendered\n\n");
    });

    it("prints bat stdout when stderr is empty", async () => {
      actions.setBatAvailable(true);
      mockSpawnSync({
        result: { status: 0, stdout: "bat-rendered\n", stderr: "" },
      });

      const getCaptured = mockStdout();

      await executeBat("test content\n");

      assert.strictEqual(stripAnsi(getCaptured()), "bat-rendered\n\n");
    });

    it("falls back to plain text when bat writes stderr", async () => {
      actions.setBatAvailable(true);
      mockSpawnSync({
        result: { status: 0, stdout: "bat-rendered\n", stderr: "bat warning" },
      });

      const getCaptured = mockStdout();

      await executeBat("test content\n");

      assert.strictEqual(
        stripAnsi(getCaptured()),
        `Falling back to plain text rendering, an error occurred when spawning \`bat\`: bat warning
test content

`,
      );
    });
  });

  describe("warnOnMissingBat", () => {
    beforeEach(() => {
      mock.restoreAll();
      actions.resetState();
    });

    it("warns when bat is not available", async () => {
      mockExec({ stdout: "", error: new Error("not found") });

      const getCaptured = mockStdout();

      await warnOnMissingBat();

      assert.strictEqual(getState().app.batAvailable, false);
      assert.match(
        stripAnsi(getCaptured()),
        /`bat` is not available, consider installing it to properly render markdown responses in the terminal\. Suppress this warning with `suppressBatUnavailableWarning: true` in /,
      );
    });

    it("does not warn when bat is available", async () => {
      mockExec({ stdout: "bat 0.25.0" });

      const getCaptured = mockStdout();

      await warnOnMissingBat();

      assert.strictEqual(getState().app.batAvailable, true);
      assert.strictEqual(getCaptured(), "");
    });

    it("does not warn when bat is unavailable and the warning is suppressed", async () => {
      mockExec({ stdout: "", error: new Error("not found") });
      actions.setSuppressBatUnavailableWarning(true);

      const getCaptured = mockStdout();

      await warnOnMissingBat();

      assert.strictEqual(getState().app.batAvailable, false);
      assert.strictEqual(getCaptured(), "");
    });
  });
});
