import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import childProcess from "node:child_process";

import { actions } from "./state.ts";
import {
  executeBat,
  formatMarkdown,
  openWithPager,
  warnOnMissingBat,
} from "./terminal.ts";
import {
  batPagerCmd,
  mockBatAvailable,
  mockExec,
  mockSpawnSync,
  mockStdout,
  mockPagerSpawn,
  setupFakeDeps,
  setupTestContext,
  stripAnsi,
  testFs,
  testProcessEnv,
} from "./test-helpers.ts";

beforeEach(() => {
  setupFakeDeps();
});

describe("openWithPager", () => {
  beforeEach(() => {
    setupTestContext();
  });

  let spawned: string[];

  beforeEach(() => {
    spawned = mockPagerSpawn().spawned;
    mockBatAvailable(true);
  });

  it("uses pagerEnvKey env var with __FILE__ replacement", async () => {
    testProcessEnv._set("LASSO_PAGER_HISTORY", "nano __FILE__");
    await openWithPager({
      pagerEnvKey: "LASSO_PAGER_HISTORY",
      contentType: "markdown",
    });
    assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
  });

  it("falls back to LASSO_PAGER env var", async () => {
    testProcessEnv._set("LASSO_PAGER", "bat __FILE__");
    await openWithPager({
      pagerEnvKey: "LASSO_PAGER_HISTORY",
      contentType: "markdown",
    });
    assert.strictEqual(spawned[0], "bat /tmp/lasso-test-uuid.txt");
  });

  it("falls back to PAGER env var with quoted temp file", async () => {
    testProcessEnv._set("PAGER", "more");
    await openWithPager({
      pagerEnvKey: "LASSO_PAGER_HISTORY",
      contentType: "markdown",
    });
    assert.strictEqual(spawned[0], `more "/tmp/lasso-test-uuid.txt"`);
  });

  it("falls back to bat", async () => {
    await openWithPager({
      pagerEnvKey: "LASSO_PAGER_HISTORY",
      contentType: "markdown",
    });
    assert.strictEqual(spawned[0], batPagerCmd("/tmp/lasso-test-uuid.txt"));
  });

  it("uses base bat flags without markdown flags for diff contentType", async () => {
    await openWithPager({
      pagerEnvKey: "LASSO_PAGER_HISTORY",
      contentType: "diff",
    });
    assert.strictEqual(
      spawned[0],
      batPagerCmd("/tmp/lasso-test-uuid.txt", "diff"),
    );
  });

  it("copies initial content into the temp file", async () => {
    testFs._files.set("/source/file.txt", "initial content");
    await openWithPager({
      pagerEnvKey: "LASSO_PAGER_HISTORY",
      initialContentPath: "/source/file.txt",
      contentType: "markdown",
    });
    assert.strictEqual(
      testFs._files.get("/tmp/lasso-test-uuid.txt"),
      "initial content",
    );
  });

  it("spawns pager with shell and inherit stdio", async () => {
    let spawnArgs: unknown[] = [];
    mock.method(childProcess, "spawnSync", (...args: unknown[]) => {
      spawnArgs = args;
    });
    await openWithPager({
      pagerEnvKey: "LASSO_PAGER_HISTORY",
      contentType: "markdown",
    });
    assert.deepStrictEqual(spawnArgs, [
      batPagerCmd("/tmp/lasso-test-uuid.txt"),
      { shell: true, stdio: "inherit" },
    ]);
  });

  it("writes initialContentStr into the temp file", async () => {
    await openWithPager({
      pagerEnvKey: "LASSO_PAGER_HISTORY",
      initialContentStr: "string content",
      contentType: "markdown",
    });
    assert.strictEqual(
      testFs._files.get("/tmp/lasso-test-uuid.txt"),
      "string content",
    );
  });

  it("throws when both initialContentPath and initialContentStr are provided", async () => {
    await assert.rejects(
      openWithPager({
        pagerEnvKey: "LASSO_PAGER_HISTORY",
        initialContentPath: "/source/file.txt",
        initialContentStr: "string content",
        contentType: "markdown",
      }),
      /falsy value/,
    );
  });

  it("falls back to less when bat is unavailable", async () => {
    mockBatAvailable(false);
    await openWithPager({
      pagerEnvKey: "LASSO_PAGER_HISTORY",
      contentType: "markdown",
    });
    assert.strictEqual(spawned[0], `less "/tmp/lasso-test-uuid.txt"`);
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
    mockExec({ stdout: "bat 0.26.1\n" });
    mockSpawnSync({ echoInput: true });

    const getCaptured = mockStdout();

    await executeBat("# Hello\n");

    assert.strictEqual(stripAnsi(getCaptured()), "# Hello\n\n");
  });

  it("falls back to plain text when bat is not available", async () => {
    mockExec({ stdout: "", error: new Error("not found") });

    const getCaptured = mockStdout();

    await executeBat("test content\n");

    assert.strictEqual(stripAnsi(getCaptured()), "test content\n\n");
  });

  it("falls back to plain text when bat spawn fails", async () => {
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
    mockExec({ stdout: "bat 0.25.0" });
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
    mockExec({ stdout: "bat 0.25.0" });
    mockSpawnSync({
      result: { status: null, stdout: "bat-rendered\n", stderr: "" },
    });

    const getCaptured = mockStdout();

    await executeBat("test content\n");

    assert.strictEqual(stripAnsi(getCaptured()), "bat-rendered\n\n");
  });

  it("prints bat stdout when stderr is empty", async () => {
    mockExec({ stdout: "bat 0.25.0" });
    mockSpawnSync({
      result: { status: 0, stdout: "bat-rendered\n", stderr: "" },
    });

    const getCaptured = mockStdout();

    await executeBat("test content\n");

    assert.strictEqual(stripAnsi(getCaptured()), "bat-rendered\n\n");
  });

  it("falls back to plain text when bat writes stderr", async () => {
    mockExec({ stdout: "bat 0.25.0" });
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

    assert.match(
      stripAnsi(getCaptured()),
      /`bat` is not available, consider installing it to properly render markdown responses in the terminal\. Suppress this warning with `suppressBatUnavailableWarning: true` in /,
    );
  });

  it("does not warn when bat is available", async () => {
    mockExec({ stdout: "bat 0.25.0" });

    const getCaptured = mockStdout();

    await warnOnMissingBat();

    assert.strictEqual(getCaptured(), "");
  });

  it("does not warn when suppressBatUnavailableWarning is set", async () => {
    mockExec({ stdout: "", error: new Error("not found") });
    actions.setSuppressBatUnavailableWarning(true);

    const getCaptured = mockStdout();

    await warnOnMissingBat();

    assert.strictEqual(getCaptured(), "");
  });
});
