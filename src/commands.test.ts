import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { stdin } from "node:process";
import {
  getAvailableSlashCommands,
  getCustomSlashCommandsStr,
  openWithPager,
  shouldMuteStdout,
  mutedStdout,
  recordAndTranscribeInput,
  shouldResolveSlashCommand,
  clearCommand,
  printTokens,
  pageSkills,
  pageContext,
  pageCommands,
  pageEditStr,
  spawnAndReadEditorContent,
  resume,
  resumeWithNoArgs,
  initStdin,
  initSigInt,
  recordInput,
  transcribeInput,
  pageSummaries,
  pageTools,
  pageHistory,
  pageLastMessage,
  pageLastResponse,
  pageLastDiff,
  printKeymaps,
  getAvailableCommandsStr,
  steerCommand,
  getStrFromAssistantContent,
} from "./commands.ts";
import { actions, getState } from "./state.ts";
import {
  setupTestContext,
  testFs,
  mockStdoutWrites,
  BLUE,
  RESET,
  YELLOW,
  GREY,
  makeMcpTool,
  makeFakeRl,
  makeAbortError,
  testProcessEnv,
  makeFakeMcpClient,
  GREEN,
  PURPLE,
  RED,
  mockSetInterval,
  mockClearInterval,
  makeErrnoError,
  mockExecCalls,
  setMcpClients,
  batPagerCmd,
  mockSpawnSync,
  mockPagerSpawn,
  addSessionFile,
  setupKeypressTests,
  makeFakeRlWithWrites,
  mockClipboardPaste,
  mockClipboardPasteFailure,
  mockEditorSpawn,
  mockRecording,
  mockTranscription,
  stripAnsi,
  mockProcessExit,
} from "./test-helpers.ts";
import { fsDeps, aiDeps, processDeps } from "./deps.ts";
import {
  getSystemContent,
  getToolsContentStr,
  strToApproxTokens,
} from "./tokens.ts";
import { print } from "./printing.ts";
import { sleep } from "./utils.ts";
import { getGlobalContextDir, getGlobalConfigPath } from "./paths.ts";
import { defaultConfig, type Key } from "./schemas.ts";
import { resolveSlashCommand } from "./app.ts";

describe("getAvailableSlashCommands", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  describe("returns an empty array", () => {
    it("returns empty array when no commands found", async () => {
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, []);
    });

    it("returns empty array when glob throws", async () => {
      mock.method(fsDeps, "glob", () =>
        Promise.reject(new Error("permission denied")),
      );
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, []);
    });

    it("returns empty array when glob returns empty", async () => {
      testFs._globResults.set("/test-cwd/.lasso/commands/**/*.md", []);
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, []);
    });
  });

  describe("returns commands", () => {
    it("includes custom slash command dirs", async () => {
      actions.setCustomSlashCommandDirs(["/custom-commands"]);
      testFs._globResults.set("/custom-commands/**/*.md", [
        "/custom-commands/foo.md",
      ]);
      testFs._files.set("/custom-commands/foo.md", "custom content");
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, [
        {
          name: "foo",
          filePath: "/custom-commands/foo.md",
          content: "custom content",
        },
      ]);
    });

    it("returns commands from local and global dirs", async () => {
      testFs._globResults.set("/test-cwd/.lasso/commands/**/*.md", [
        "/test-cwd/.lasso/commands/help.md",
      ]);
      testFs._globResults.set("/fake-home/.config/lasso/commands/**/*.md", [
        "/fake-home/.config/lasso/commands/status.md",
      ]);
      testFs._files.set("/test-cwd/.lasso/commands/help.md", "help content");
      testFs._files.set(
        "/fake-home/.config/lasso/commands/status.md",
        "status content",
      );
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, [
        {
          name: "help",
          filePath: "/test-cwd/.lasso/commands/help.md",
          content: "help content",
        },
        {
          name: "status",
          filePath: "/fake-home/.config/lasso/commands/status.md",
          content: "status content",
        },
      ]);
    });

    it("deduplicates by name keeping first occurrence", async () => {
      testFs._globResults.set("/test-cwd/.lasso/commands/**/*.md", [
        "/test-cwd/.lasso/commands/help.md",
      ]);
      testFs._globResults.set("/fake-home/.config/lasso/commands/**/*.md", [
        "/fake-home/.config/lasso/commands/help.md",
      ]);
      testFs._files.set("/test-cwd/.lasso/commands/help.md", "local content");
      testFs._files.set(
        "/fake-home/.config/lasso/commands/help.md",
        "global content",
      );
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, [
        {
          name: "help",
          filePath: "/test-cwd/.lasso/commands/help.md",
          content: "local content",
        },
      ]);
    });
  });

  describe("handles errors", () => {
    it("skips files that fail to read", async () => {
      mock.method(fsDeps, "readFile", (path: string) =>
        path.includes("bad")
          ? Promise.reject(new Error("read failed"))
          : Promise.resolve(Buffer.from("content").toString()),
      );
      testFs._globResults.set("/test-cwd/.lasso/commands/**/*.md", [
        "/test-cwd/.lasso/commands/good.md",
        "/test-cwd/.lasso/commands/bad.md",
      ]);
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, [
        {
          name: "good",
          filePath: "/test-cwd/.lasso/commands/good.md",
          content: "content",
        },
      ]);
    });

    it("warns when glob fails", async () => {
      mock.method(fsDeps, "glob", () =>
        Promise.reject(new Error("permission denied")),
      );
      const getWrites = mockStdoutWrites();

      const result = await getAvailableSlashCommands();

      assert.deepStrictEqual(result, []);
      assert.deepStrictEqual(getWrites(), []);
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "Failed to list the slash command files in `/test-cwd/.lasso/commands`, ignoring. Error: permission denied",
        "Failed to list the slash command files in `/fake-home/.config/lasso/commands`, ignoring. Error: permission denied",
      ]);
    });

    it("warns when a slash command file cannot be read", async () => {
      mock.method(fsDeps, "readFile", (path: string) =>
        path.includes("bad")
          ? Promise.reject(new Error("read failed"))
          : Promise.resolve(Buffer.from("content").toString()),
      );
      testFs._globResults.set("/test-cwd/.lasso/commands/**/*.md", [
        "/test-cwd/.lasso/commands/bad.md",
      ]);
      const getWrites = mockStdoutWrites();

      const result = await getAvailableSlashCommands();

      assert.deepStrictEqual(result, []);
      assert.deepStrictEqual(getWrites(), []);
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "Failed to read the slash command file at `/test-cwd/.lasso/commands/bad.md`, ignoring. Error: read failed",
      ]);
    });
  });
});

describe("getCustomSlashCommandsStr", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  it("normalizes CRLF and strips trailing newlines from content", () => {
    actions.setSlashCommands([
      {
        name: "deploy",
        filePath: "/test-cwd/.lasso/commands/deploy.md",
        content: "line one\r\nline two\r\n\r\n",
      },
    ]);
    assert.strictEqual(
      getCustomSlashCommandsStr(),
      `# [lasso] Slash commands:

## /test-cwd/.lasso/commands/deploy.md

line one\r\nline two`,
    );
  });
});

describe("openWithPager", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe("openWithPager", () => {
    beforeEach(() => {
      setupTestContext();
    });

    let spawned: string[];
    let spawnOptions: unknown[];
    let unlinked: string[];

    beforeEach(() => {
      const pager = mockPagerSpawn();
      spawned = pager.spawned;
      spawnOptions = pager.spawnOptions;
      unlinked = pager.unlinked;
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
        assert.strictEqual(spawned[0], `more '/tmp/lasso-test-uuid.txt'`);
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
        assert.strictEqual(spawned[0], `less '/tmp/lasso-test-uuid.txt'`);
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
        await openWithPager({
          initialContentStr: "",
          contentType: "markdown",
        });
        assert.deepStrictEqual(
          { command: spawned[0], options: spawnOptions[0] },
          {
            command: batPagerCmd("/tmp/lasso-test-uuid.txt"),
            options: { shell: true, stdio: "inherit" },
          },
        );
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

      it("deletes the temp file after the pager exits", async () => {
        await openWithPager({
          initialContentStr: "content",
          contentType: "markdown",
        });
        assert.deepStrictEqual(unlinked, ["/tmp/lasso-test-uuid.txt"]);
      });

      it("prints an error and deletes the temp file when the pager fails to spawn", async () => {
        const pagerError = new Error("pager unavailable");
        const pager = mockPagerSpawn({ spawnError: pagerError });
        const getWrites = mockStdoutWrites();

        await openWithPager({
          initialContentStr: "content",
          contentType: "markdown",
        });

        assert.deepStrictEqual(getWrites(), [
          `${RED}Error while spawning the pager: pager unavailable${RESET}\n`,
        ]);
        assert.deepStrictEqual(pager.unlinked, ["/tmp/lasso-test-uuid.txt"]);
      });

      it("does not spawn a pager when the temp file cannot be created", async () => {
        mock.method(fsDeps, "writeFile", () =>
          Promise.reject(new Error("write failed")),
        );
        const writes = mockStdoutWrites();

        await openWithPager({
          initialContentStr: "content",
          contentType: "markdown",
        });

        assert.deepStrictEqual(spawned, []);
        assert.deepStrictEqual(writes(), [
          `${RED}Failed to write to a temp file. Error: write failed${RESET}\n`,
        ]);
      });
    });
  });
});

describe("input commands", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  let getWrites: () => string[];

  beforeEach(() => {
    setupTestContext();
    getWrites = mockStdoutWrites();
  });

  describe("initSigInt", () => {
    it("aborts interruption with editor content", () => {
      let sigint: (() => void) | undefined;
      const rl = makeFakeRl({
        on: (_event: string, listener: () => void) => {
          sigint = listener;
        },
      });
      actions.setRl(rl);
      const controller = new AbortController();
      actions.setInterruptWithEditorAbortController(controller);

      initSigInt(rl);
      assert(sigint !== undefined);
      sigint();

      assert.equal(controller.signal.aborted, true);
    });

    it("aborts the transcription", () => {
      let sigint: (() => void) | undefined;
      const rl = makeFakeRl({
        on: (_event: string, listener: () => void) => {
          sigint = listener;
        },
      });
      actions.setRl(rl);
      const controller = new AbortController();
      actions.setTranscriptionAbortController(controller);

      initSigInt(rl);
      assert(sigint !== undefined);
      sigint();

      assert.equal(controller.signal.aborted, true);
    });

    it("aborts the recording process and its stop question", () => {
      let sigint: (() => void) | undefined;
      const rl = makeFakeRl({
        on: (_event: string, listener: () => void) => {
          sigint = listener;
        },
      });
      actions.setRl(rl);
      const controller = new AbortController();
      actions.setRecordProcessAbortController(controller);

      initSigInt(rl);
      assert(sigint !== undefined);
      sigint();

      assert.equal(controller.signal.aborted, true);
    });

    it("aborts API stream", () => {
      let sigint: (() => void) | undefined;
      const rl = makeFakeRl({
        on: (_event: string, listener: () => void) => {
          sigint = listener;
        },
      });
      actions.setRl(rl);
      const controller = new AbortController();
      actions.setApiStreamAbortController(controller);

      initSigInt(rl);
      assert(sigint !== undefined);
      sigint();

      assert.equal(controller.signal.aborted, true);
    });

    it("aborts the recording process instead of the API stream when both are set", () => {
      let sigint: (() => void) | undefined;
      const rl = makeFakeRl({
        on: (_event: string, listener: () => void) => {
          sigint = listener;
        },
      });
      actions.setRl(rl);
      const streamController = new AbortController();
      actions.setApiStreamAbortController(streamController);
      const recordController = new AbortController();
      actions.setRecordProcessAbortController(recordController);

      initSigInt(rl);
      assert(sigint !== undefined);
      sigint();

      assert.equal(recordController.signal.aborted, true);
      assert.equal(streamController.signal.aborted, false);
    });

    it("clears readline input for an active question", () => {
      let sigint: (() => void) | undefined;
      let writeCount = 0;
      const rl = makeFakeRl({
        line: "input",
        on: (_event: string, listener: () => void) => {
          sigint = listener;
        },
        write: () => {
          writeCount += 1;
        },
      });
      actions.setRl(rl);
      const controller = new AbortController();
      actions.setQuestionAbortController(controller);

      initSigInt(rl);
      assert(sigint !== undefined);
      sigint();

      assert.equal(writeCount, 2);
      assert.equal(controller.signal.aborted, false);
    });

    it("aborts an active question when readline input is empty", () => {
      let sigint: (() => void) | undefined;
      const rl = makeFakeRl({
        on: (_event: string, listener: () => void) => {
          sigint = listener;
        },
      });
      actions.setRl(rl);
      const controller = new AbortController();
      actions.setQuestionAbortController(controller);

      initSigInt(rl);
      assert(sigint !== undefined);
      sigint();

      assert.equal(controller.signal.aborted, true);
    });

    it("does nothing when no controller is active", () => {
      let sigint: (() => void) | undefined;
      const rl = makeFakeRl({
        on: (_event: string, listener: () => void) => {
          sigint = listener;
        },
      });
      actions.setRl(rl);

      initSigInt(rl);
      assert(sigint !== undefined);
      assert.doesNotThrow(sigint);
    });

    it("rejects simultaneous API and editor interruption controllers", () => {
      let sigint: (() => void) | undefined;
      const rl = makeFakeRl({
        on: (_event: string, listener: () => void) => {
          sigint = listener;
        },
      });
      actions.setRl(rl);
      actions.setApiStreamAbortController(new AbortController());
      actions.setInterruptWithEditorAbortController(new AbortController());

      initSigInt(rl);
      assert(sigint !== undefined);
      assert.throws(sigint);
    });

    it("rejects simultaneous API and question controllers", () => {
      let sigint: (() => void) | undefined;
      const rl = makeFakeRl({
        on: (_event: string, listener: () => void) => {
          sigint = listener;
        },
      });
      actions.setRl(rl);
      actions.setApiStreamAbortController(new AbortController());
      actions.setQuestionAbortController(new AbortController());

      initSigInt(rl);
      assert(sigint !== undefined);
      assert.throws(sigint);
    });

    it("rejects simultaneous question and editor interruption controllers", () => {
      let sigint: (() => void) | undefined;
      const rl = makeFakeRl({
        on: (_event: string, listener: () => void) => {
          sigint = listener;
        },
      });
      actions.setRl(rl);
      actions.setQuestionAbortController(new AbortController());
      actions.setInterruptWithEditorAbortController(new AbortController());

      initSigInt(rl);
      assert(sigint !== undefined);
      assert.throws(sigint);
    });
  });

  describe("initStdin input buffering", () => {
    let emitKey: (char: string | undefined, key: Key) => void;

    beforeEach(() => {
      initStdin();
      emitKey = (char, key) => {
        stdin.emit("keypress", char, key);
      };
    });

    afterEach(() => {
      stdin.removeAllListeners();
      stdin.pause();
      stdin.destroy();
    });

    it("buffers typeable characters while initializing", () => {
      actions.setIsInitializing(true);
      emitKey("a", { name: "a" });
      emitKey(" ", { name: "space" });
      assert.equal(getState().terminal.bufferedInputWhileInitializing, "a ");
    });

    it("ignores keypresses when not initializing", () => {
      emitKey("a", { name: "a" });
      assert.equal(getState().terminal.bufferedInputWhileInitializing, "");
    });

    it("ignores return and enter keys", () => {
      actions.setIsInitializing(true);
      actions.appendBufferedInputWhileInitializing("ab");
      emitKey("\r", { name: "return" });
      emitKey("\n", { name: "enter" });
      assert.equal(getState().terminal.bufferedInputWhileInitializing, "ab");
    });

    it("ignores keys without characters like arrow keys", () => {
      actions.setIsInitializing(true);
      actions.appendBufferedInputWhileInitializing("ab");
      emitKey(undefined, { name: "left" });
      assert.equal(getState().terminal.bufferedInputWhileInitializing, "ab");
    });

    it("ignores ctrl and meta keys", () => {
      actions.setIsInitializing(true);
      actions.appendBufferedInputWhileInitializing("ab");
      emitKey("h", { name: "h", ctrl: true });
      emitKey("f", { name: "f", meta: true });
      assert.equal(getState().terminal.bufferedInputWhileInitializing, "ab");
    });

    it("exits with code 130 on ctrl c while initializing", () => {
      const exit = mockProcessExit();
      actions.setIsInitializing(true);
      assert.throws(() => {
        emitKey("c", { name: "c", ctrl: true });
      }, /process.exit called/);
      assert.equal(exit.mock.calls.length, 1);
      assert.equal(exit.mock.calls[0]?.arguments[0], 130);
    });
  });

  describe("spawnAndReadEditorContent", () => {
    let spawned: string[];

    beforeEach(() => {
      spawned = [];
      actions.setRl(makeFakeRl({ line: "" }));
      mockEditorSpawn((cmd) => {
        spawned.push(cmd);
      });
    });

    it("returns null and prints an error when the editor process errors", async () => {
      mockEditorSpawn((_cmd, child) => {
        child.emit("error", new Error("spawn failed"));
      });
      const getWrites = mockStdoutWrites();

      const result = await spawnAndReadEditorContent();

      assert.strictEqual(result, null);
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
      assert.equal(
        getWrites()[0],
        `${RED}Error while spawning the editor: spawn failed${RESET}\n`,
      );
    });

    describe("returns null on file failures", () => {
      it("returns null when writeFile fails", async () => {
        mock.method(fsDeps, "writeFile", () =>
          Promise.reject(new Error("write failed")),
        );
        const result = await spawnAndReadEditorContent();
        assert.strictEqual(result, null);
      });

      it("warns when creating the temp file fails", async () => {
        mock.method(fsDeps, "writeFile", () =>
          Promise.reject(new Error("write failed")),
        );
        const getWrites = mockStdoutWrites();

        const result = await spawnAndReadEditorContent();

        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), [
          `${RED}Failed to create an empty temp file. Error: write failed${RESET}\n`,
        ]);
      });

      it("returns null and cleans up when readFile fails", async () => {
        mockEditorSpawn(() => {
          testFs.writeFile("/tmp/lasso-test-uuid.txt", "modified");
        });
        mock.method(fsDeps, "readFile", () =>
          Promise.reject(new Error("read failed")),
        );
        const result = await spawnAndReadEditorContent();
        assert.strictEqual(result, null);
        assert.strictEqual(
          testFs._files.has("/tmp/lasso-test-uuid.txt"),
          false,
        );
      });
    });

    describe("processes the editor result", () => {
      it("returns null when editor returns empty content", async () => {
        mockEditorSpawn(() => {
          testFs.writeFile("/tmp/lasso-test-uuid.txt", "");
        });
        const result = await spawnAndReadEditorContent();
        assert.strictEqual(result, null);
      });

      it("clears the editor input value and returns null when the editor result is whitespace only", async () => {
        actions.setEditorInputValue("prefill");
        mockEditorSpawn(() => {
          testFs.writeFile("/tmp/lasso-test-uuid.txt", "   \n\t");
        });
        const result = await spawnAndReadEditorContent();
        assert.strictEqual(result, null);
        assert.strictEqual(getState().terminal.editorInputValue, null);
      });

      it("returns null without state changes when the editor result is whitespace only and there was no prefill", async () => {
        mockEditorSpawn(() => {
          testFs.writeFile("/tmp/lasso-test-uuid.txt", "   ");
        });
        const result = await spawnAndReadEditorContent();
        assert.strictEqual(result, null);
        assert.strictEqual(getState().terminal.editorInputValue, null);
      });

      it("returns normalized content", async () => {
        mockEditorSpawn(() => {
          testFs.writeFile("/tmp/lasso-test-uuid.txt", "  hello  ");
        });
        const result = await spawnAndReadEditorContent();
        assert.strictEqual(result, "  hello\n");
        assert.strictEqual(getState().terminal.editorInputValue, "  hello  ");
      });

      it("returns normalized content when editor saves unchanged content", async () => {
        actions.setRl(makeFakeRl({ line: "hello" }));
        mockEditorSpawn(() => {
          testFs.writeFile("/tmp/lasso-test-uuid.txt", "hello");
        });
        const result = await spawnAndReadEditorContent();
        assert.strictEqual(result, "hello\n");
      });
    });

    describe("selects the editor", () => {
      it("uses LASSO_EDIT env var with __FILE__ when available", async () => {
        testProcessEnv._set("LASSO_EDIT", "nano __FILE__");
        await spawnAndReadEditorContent();
        assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      });

      it("falls back to EDITOR env var when LASSO_EDIT is not set", async () => {
        testProcessEnv._set("EDITOR", "vim");
        await spawnAndReadEditorContent();
        assert.strictEqual(spawned[0], "vim '/tmp/lasso-test-uuid.txt'");
      });

      it("uses EDITOR env var with __FILE__ when LASSO_EDIT is not set", async () => {
        testProcessEnv._set("EDITOR", "nano __FILE__");
        await spawnAndReadEditorContent();
        assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      });

      it("falls back to vi when no editor env vars are set", async () => {
        await spawnAndReadEditorContent();
        assert.strictEqual(spawned[0], "vi '/tmp/lasso-test-uuid.txt'");
      });

      it("falls back to vi when EDITOR is whitespace-only", async () => {
        testProcessEnv._set("EDITOR", "   ");
        await spawnAndReadEditorContent();
        assert.strictEqual(spawned[0], "vi '/tmp/lasso-test-uuid.txt'");
      });
    });

    describe("appends clipboard content", () => {
      it("includes clipboard content when includeClipboardSuffix is true", async () => {
        actions.setRl(makeFakeRl({ line: "hello " }));
        mockClipboardPaste("world");
        mockEditorSpawn(() => {
          testFs.writeFile(
            "/tmp/lasso-test-uuid.txt",
            "  hello world modified  \n",
          );
        });
        const result = await spawnAndReadEditorContent({
          includeClipboardSuffix: true,
        });
        assert.strictEqual(result, "  hello world modified\n");
      });

      it("returns content when includeClipboardSuffix is true and editor saves unchanged content", async () => {
        actions.setRl(makeFakeRl({ line: "query" }));
        mockClipboardPaste("clip");
        mockEditorSpawn(() => {
          testFs.writeFile("/tmp/lasso-test-uuid.txt", "queryclip");
        });
        const result = await spawnAndReadEditorContent({
          includeClipboardSuffix: true,
        });
        assert.strictEqual(result, "queryclip\n");
      });

      it("returns null when includeClipboardSuffix is true and editor is closed without saving", async () => {
        actions.setRl(makeFakeRl({ line: "query" }));
        mockClipboardPaste("clip");
        const result = await spawnAndReadEditorContent({
          includeClipboardSuffix: true,
        });
        assert.strictEqual(result, null);
      });

      it("uses pbpaste on darwin when LASSO_CLIPBOARD_PASTE is not set", async () => {
        actions.setRl(makeFakeRl({ line: "query" }));
        mock.method(os, "platform", () => "darwin");
        const commands: string[] = [];
        mockExecCalls([{ stdout: "clip" }], commands);
        const result = await spawnAndReadEditorContent({
          includeClipboardSuffix: true,
        });
        assert.strictEqual(result, null);
        assert.strictEqual(commands[0], "pbpaste");
      });

      it("includes a clipboard error marker in the editor content when the paste command fails", async () => {
        actions.setRl(makeFakeRl({ line: "hello " }));
        mockClipboardPasteFailure(new Error("boom"));
        let initialEditorContent = "";
        mockEditorSpawn(() => {
          initialEditorContent =
            testFs._files.get("/tmp/lasso-test-uuid.txt") ?? "";
          testFs.writeFile("/tmp/lasso-test-uuid.txt", "final");
        });
        const result = await spawnAndReadEditorContent({
          includeClipboardSuffix: true,
        });
        assert.strictEqual(result, "final\n");
        assert.strictEqual(
          initialEditorContent,
          "hello [Error executing xclip -selection clipboard -o: boom]",
        );
      });
    });
  });

  describe("shouldResolveSlashCommand", () => {
    describe("returns false", () => {
      it("returns false for null", () => {
        assert.strictEqual(
          shouldResolveSlashCommand(null, { forceKnownCommand: false }),
          false,
        );
      });

      it("returns false for an empty string", () => {
        assert.strictEqual(
          shouldResolveSlashCommand("", { forceKnownCommand: false }),
          false,
        );
      });

      it("returns false for plain text", () => {
        assert.strictEqual(
          shouldResolveSlashCommand("hello there", {
            forceKnownCommand: false,
          }),
          false,
        );
      });

      it("returns false for multi-line input", () => {
        assert.strictEqual(
          shouldResolveSlashCommand("/cwd\n/pwd", { forceKnownCommand: false }),
          false,
        );
      });
    });

    describe("returns true", () => {
      it("returns true for a bare slash command", () => {
        assert.strictEqual(
          shouldResolveSlashCommand("/cwd", { forceKnownCommand: false }),
          true,
        );
      });

      it("returns true for a slash command with args", () => {
        assert.strictEqual(
          shouldResolveSlashCommand("/cwd /some/path", {
            forceKnownCommand: false,
          }),
          true,
        );
      });

      it("returns true for a slash command with surrounding whitespace", () => {
        assert.strictEqual(
          shouldResolveSlashCommand("  /cwd  ", { forceKnownCommand: false }),
          true,
        );
      });
    });

    describe("forceKnownCommand", () => {
      it("returns false for /model because it is not a builtin slash command", () => {
        assert.strictEqual(
          shouldResolveSlashCommand("/model", { forceKnownCommand: true }),
          false,
        );
      });

      it("returns true for a builtin slash command when forceKnownCommand is set", () => {
        assert.strictEqual(
          shouldResolveSlashCommand("/clear", { forceKnownCommand: true }),
          true,
        );
      });

      it("returns true for a builtin slash command with args when forceKnownCommand is set", () => {
        assert.strictEqual(
          shouldResolveSlashCommand("/clear arg", {
            forceKnownCommand: true,
          }),
          true,
        );
      });

      it("returns true for a registered custom slash command when forceKnownCommand is set", () => {
        actions.setSlashCommands([
          {
            name: "cwd",
            filePath: "/test/.lasso/commands/cwd.md",
            content: "cwd",
          },
        ]);
        assert.strictEqual(
          shouldResolveSlashCommand("/cwd", { forceKnownCommand: true }),
          true,
        );
      });

      it("returns true for a registered custom slash command with args when forceKnownCommand is set", () => {
        actions.setSlashCommands([
          {
            name: "cwd",
            filePath: "/test/.lasso/commands/cwd.md",
            content: "cwd",
          },
        ]);
        assert.strictEqual(
          shouldResolveSlashCommand("/cwd /some/path", {
            forceKnownCommand: true,
          }),
          true,
        );
      });

      it("returns false for an unknown slash command when forceKnownCommand is set", () => {
        assert.strictEqual(
          shouldResolveSlashCommand("/unknowncmd", { forceKnownCommand: true }),
          false,
        );
      });

      it("returns false for a non-command path when forceKnownCommand is set", () => {
        assert.strictEqual(
          shouldResolveSlashCommand("/tmp/foo", { forceKnownCommand: true }),
          false,
        );
      });
    });
  });

  describe("clearCommand", () => {
    beforeEach(() => {
      actions.resetStdout();
    });

    it("resets params", async () => {
      actions.setConversationMessages([{ role: "user", content: "hello" }]);
      actions.setConversationSummaries([
        { compacted: "summary", compactedAt: 3, tokens: 5 },
      ]);
      actions.setContextStr("abc");
      const expectedPromptTokens =
        strToApproxTokens(getSystemContent()) +
        strToApproxTokens(getToolsContentStr());
      await clearCommand();
      assert.deepStrictEqual(getState().conversation.summaries, []);
      assert.deepStrictEqual(getState().conversation.messages, []);
      assert.deepStrictEqual(getState().usage.promptTokens, {
        value: expectedPromptTokens,
        stale: true,
      });
      assert.deepStrictEqual(getWrites(), [
        `${GREY}Context cleared (0 tokens in session)${RESET}\n`,
      ]);
    });
  });

  describe("printTokens", () => {
    beforeEach(() => {
      actions.resetStdout();
      actions.setContextStr("");
      actions.setContextStr("123456789");
      actions.setSkillsStr("1234");
      actions.setConversationMessages([{ role: "user", content: "hello" }]);
    });

    it("prints the total and each area with its approx count when the cache is stale", () => {
      actions.setPromptTokensStale(true);
      printTokens();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${BLUE}Token count: 1,974 (1.543% of context window)${RESET}\n`,
        `- Chat messages: 11
- Context files: 3
- Harness and MCP tools: 1,106
- Base system prompt: 853
- Skill descriptions: 1
`,
        "\n",
      ]);
    });

    it("prints the total scaled to the cached token count when clean", () => {
      actions.setPromptTokens(1500);
      actions.setPromptTokensStale(false);
      printTokens();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${BLUE}Token count: 1,499.241 (1.172% of context window)${RESET}\n`,
        `- Chat messages: 8
- Context files: 2
- Harness and MCP tools: 840
- Base system prompt: 648
- Skill descriptions: 1
`,
        "\n",
      ]);
    });

    it("includes the context window usage when configured", () => {
      actions.setModel("test-model");
      actions.setContextWindowPerModel({ "test-model": 10_000 });
      printTokens();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${BLUE}Token count: 1,974 (19.75% of context window)${RESET}\n`,
        `- Chat messages: 11
- Context files: 3
- Harness and MCP tools: 1,106
- Base system prompt: 853
- Skill descriptions: 1
`,
        "\n",
      ]);
    });
  });

  describe("resume", () => {
    beforeEach(() => {
      actions.resetStdout();
    });

    it("prints usage error when no session start date is provided", async () => {
      const result = await resume("/resume");
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}Usage: /resume [session start date]${RESET}\n`,
      ]);
    });

    it("prints usage error when too many parts are provided", async () => {
      const result = await resume("/resume 123 456");
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}Usage: /resume [session start date]${RESET}\n`,
      ]);
    });

    it("prints usage error when session start date is not a number", async () => {
      const result = await resume("/resume abc");
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}Usage: /resume [session start date]${RESET}\n`,
      ]);
    });

    it("prints error when sessions directory does not exist", async () => {
      const result = await resume("/resume 1234567890000");
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}No conversation found with session start date: 1234567890000${RESET}\n`,
        "\n",
      ]);
    });

    it("loads the session and returns continue when the date matches", async () => {
      actions.setConversationMessages([{ role: "user", content: "old" }]);
      addSessionFile(1234567890000, {
        messages: [{ role: "user", content: "hello" }],
        summaries: [],
        transcript: [
          { timestamp: 0, role: "user", message: "transcript content" },
        ],
      });

      const result = await resume("/resume 1234567890000");

      assert.strictEqual(result, "Continue");
      assert.deepStrictEqual(getState().conversation.summaries, []);
      assert.deepStrictEqual(getState().conversation.messages, [
        { role: "user", content: "hello" },
      ]);
      assert.deepStrictEqual(getState().conversation.transcript, [
        { timestamp: 0, role: "user", message: "transcript content" },
      ]);
      assert.deepStrictEqual(getState().usage.promptTokens, {
        value: 0,
        stale: true,
      });
    });

    it("prints error when no conversation is found", async () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
      testFs._files.set(
        "/fake-home/.local/state/lasso/sessions/session-9999999999999.json",
        "transcript content",
      );
      const result = await resume("/resume 1234567890000");
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}No conversation found with session start date: 1234567890000${RESET}\n`,
        "\n",
      ]);
    });

    it("prints an error and returns null when the session file cannot be parsed", async () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
      testFs._files.set(
        "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
        "not json",
      );
      const result = await resume("/resume 1234567890000");
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}Failed to parse the session file at /fake-home/.local/state/lasso/sessions/session-1234567890000.json${RESET}\n`,
        "\n",
      ]);
    });

    it("skips files that do not match the session format", async () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
      testFs._files.set(
        "/fake-home/.local/state/lasso/sessions/other-1234567890000.md",
        "other",
      );
      const result = await resume("/resume 1234567890000");
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}No conversation found with session start date: 1234567890000${RESET}\n`,
        "\n",
      ]);
    });
  });

  describe("resumeWithNoArgs", () => {
    beforeEach(() => {
      actions.resetStdout();
    });

    it("prints an error when there are no sessions to resume", async () => {
      const result = await resumeWithNoArgs();
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}No sessions to resume${RESET}\n`,
        "\n",
      ]);
    });

    it("resumes the most recent session", async () => {
      actions.setConversationMessages([{ role: "user", content: "hello" }]);
      addSessionFile(1234567890000, {
        messages: [{ role: "user", content: "older" }],
        summaries: [],
        transcript: [],
      });
      addSessionFile(1234567899999, {
        messages: [{ role: "assistant", content: "newer" }],
        summaries: [{ compacted: "summary", compactedAt: 123, tokens: 456 }],
        transcript: [
          { timestamp: 0, role: "user", message: "newer transcript" },
        ],
      });

      const result = await resumeWithNoArgs();

      assert.strictEqual(result, "Continue");
      assert.deepStrictEqual(getState().conversation.summaries, [
        { compacted: "summary", compactedAt: 123, tokens: 456 },
      ]);
      assert.deepStrictEqual(getState().conversation.messages, [
        { role: "assistant", content: "newer" },
      ]);
      assert.deepStrictEqual(getState().conversation.transcript, [
        { timestamp: 0, role: "user", message: "newer transcript" },
      ]);
    });

    it("excludes the current session file when resuming the most recent session", async () => {
      addSessionFile(1234567899999, {
        messages: [{ role: "assistant", content: "newer" }],
        summaries: [{ compacted: "summary", compactedAt: 123, tokens: 456 }],
        transcript: [
          { timestamp: 0, role: "user", message: "newer transcript" },
        ],
      });
      actions.setSessionFilePath(
        "/fake-home/.local/state/lasso/sessions/session-1234567899999.json",
      );
      addSessionFile(1234567890000, {
        messages: [{ role: "user", content: "older" }],
        summaries: [],
        transcript: [],
      });

      const result = await resumeWithNoArgs();

      assert.strictEqual(result, "Continue");
      assert.deepStrictEqual(getState().conversation.summaries, []);
      assert.deepStrictEqual(getState().conversation.messages, [
        { role: "user", content: "older" },
      ]);
      assert.deepStrictEqual(getState().conversation.transcript, []);
    });

    it("prints an error when the current session is the only session", async () => {
      actions.setSessionFilePath(
        "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
      );
      addSessionFile(1234567890000, {
        messages: [{ role: "user", content: "hello" }],
        summaries: [],
        transcript: [],
      });

      const result = await resumeWithNoArgs();

      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}No sessions to resume${RESET}\n`,
        "\n",
      ]);
    });
  });

  describe("pageHistory", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("prints that history is empty when the transcript is empty", () => {
      pageHistory({ isTyped: true });
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No chat history${RESET}\n`,
        "\n",
      ]);
    });

    it("surrounds the message with blank lines when isTyped is false", async () => {
      await pageHistory();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${YELLOW}No chat history${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", async () => {
      actions.setApiStreamAbortController(new AbortController());
      await pageHistory();
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No chat history${RESET}\n`,
      ]);
    });

    it("opens the chat history newest first in a pager with a heading prepended", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.setTranscript([
        {
          timestamp: 1000,
          role: "user",
          message: "older content",
        },
        {
          timestamp: 60000,
          role: "assistant",
          message: "newer content",
        },
      ]);
      await pageHistory();
      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Chat history

Jan 1, 1970, 12:01:00 AM  *assistant*
newer content

---

Jan 1, 1970, 12:00:01 AM  *user*
older content

`,
      );
    });
  });

  describe("pageLastResponse", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("prints no messages when there is no assistant response", async () => {
      await pageLastResponse({ isTyped: true });
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No llm messages${RESET}\n`,
        "\n",
      ]);
    });

    it("surrounds the message with blank lines when isTyped is false", async () => {
      await pageLastResponse();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${YELLOW}No llm messages${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", async () => {
      actions.setApiStreamAbortController(new AbortController());
      await pageLastResponse();
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No llm messages${RESET}\n`,
      ]);
    });

    it("opens the latest assistant response in a pager", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.setConversationMessages([
        {
          role: "user",
          content: "question",
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      ]);

      await pageLastResponse();

      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Last response

first
second

`,
      );
    });
  });

  describe("pageLastMessage", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("prints no messages when there is no user message", () => {
      pageLastMessage({ isTyped: true });
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No user messages${RESET}\n`,
        "\n",
      ]);
    });

    it("surrounds the message with blank lines when isTyped is false", async () => {
      await pageLastMessage();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${YELLOW}No user messages${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", async () => {
      actions.setApiStreamAbortController(new AbortController());
      await pageLastMessage();
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No user messages${RESET}\n`,
      ]);
    });

    it("opens the latest user message in a pager", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.setConversationMessages([
        { role: "user", content: "older" },
        {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
        },
        {
          role: "user",
          content: "latest question",
        },
      ]);

      await pageLastMessage();

      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Last message

latest question

`,
      );
    });

    it("skips an interrupted message when opening the latest user message", async () => {
      mockPagerSpawn();
      actions.setConversationMessages([
        { role: "user", content: "latest question" },
        {
          role: "user",
          content: "[Interrupted before a response was generated]",
        },
      ]);

      await pageLastMessage();

      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Last message\n\nlatest question\n\n`,
      );
    });
  });

  describe("pageLastDiff", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("prints no diffs when there are no diffs", () => {
      pageLastDiff({ isTyped: true });
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No diffs from the last turn${RESET}\n`,
        "\n",
      ]);
    });

    it("surrounds the message with blank lines when isTyped is false", async () => {
      await pageLastDiff();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${YELLOW}No diffs from the last turn${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", async () => {
      actions.setApiStreamAbortController(new AbortController());
      await pageLastDiff();
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No diffs from the last turn${RESET}\n`,
      ]);
    });

    it("opens the diffs in a pager with a fence per file", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.appendToolEditDiff({ fileName: "/a.ts", diffStdout: "+a\n" });
      actions.appendToolEditDiff({ fileName: "/b.ts", diffStdout: "+b\n" });

      await pageLastDiff();

      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `━━ /a.ts ━━\n+a\n\n\n━━ /b.ts ━━\n+b\n\n`,
      );
    });

    it("opens the diffs with collapsed extra trailing newlines", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.appendToolEditDiff({ fileName: "/a.ts", diffStdout: "+a\n\n\n" });

      await pageLastDiff();

      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `━━ /a.ts ━━\n+a\n\n`,
      );
    });
  });

  describe("pageSummaries", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("opens the summaries list newest first in a pager", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.setConversationSummaries([
        { compacted: "older summary", compactedAt: 100, tokens: 10 },
        { compacted: "latest summary", compactedAt: 200, tokens: 20 },
      ]);

      await pageSummaries();

      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.deepStrictEqual(
        stripAnsi(testFs._files.get("/tmp/lasso-test-uuid.txt") ?? ""),
        `# [lasso] Conversation summaries

## Summary 2 (20 tokens, compacted at Jan 1, 1970, 12:00:00 AM)

latest summary

---

## Summary 1 (10 tokens, compacted at Jan 1, 1970, 12:00:00 AM)

older summary

`,
      );
    });

    it("prints a message when there are no conversation summaries", () => {
      pageSummaries({ isTyped: true });

      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No conversation summaries${RESET}\n`,
        "\n",
      ]);
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
    });

    it("surrounds the message with blank lines when isTyped is false", async () => {
      await pageSummaries();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${YELLOW}No conversation summaries${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", async () => {
      actions.setApiStreamAbortController(new AbortController());
      await pageSummaries();
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No conversation summaries${RESET}\n`,
      ]);
    });
  });

  describe("resumeWithNoArgs", () => {
    beforeEach(() => {
      actions.resetStdout();
    });

    it("prints an error when there are no sessions to resume", async () => {
      const result = await resumeWithNoArgs();
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}No sessions to resume${RESET}\n`,
        "\n",
      ]);
    });

    it("resumes the most recent session", async () => {
      actions.setConversationMessages([{ role: "user", content: "hello" }]);
      addSessionFile(1234567890000, {
        messages: [{ role: "user", content: "older" }],
        summaries: [],
        transcript: [],
      });
      addSessionFile(1234567899999, {
        messages: [{ role: "assistant", content: "newer" }],
        summaries: [{ compacted: "summary", compactedAt: 123, tokens: 456 }],
        transcript: [
          { timestamp: 0, role: "user", message: "newer transcript" },
        ],
      });

      const result = await resumeWithNoArgs();

      assert.strictEqual(result, "Continue");
      assert.deepStrictEqual(getState().conversation.summaries, [
        { compacted: "summary", compactedAt: 123, tokens: 456 },
      ]);
      assert.deepStrictEqual(getState().conversation.messages, [
        { role: "assistant", content: "newer" },
      ]);
      assert.deepStrictEqual(getState().conversation.transcript, [
        { timestamp: 0, role: "user", message: "newer transcript" },
      ]);
    });

    it("excludes the current session file when resuming the most recent session", async () => {
      addSessionFile(1234567899999, {
        messages: [{ role: "assistant", content: "newer" }],
        summaries: [{ compacted: "summary", compactedAt: 123, tokens: 456 }],
        transcript: [
          { timestamp: 0, role: "user", message: "newer transcript" },
        ],
      });
      actions.setSessionFilePath(
        "/fake-home/.local/state/lasso/sessions/session-1234567899999.json",
      );
      addSessionFile(1234567890000, {
        messages: [{ role: "user", content: "older" }],
        summaries: [],
        transcript: [],
      });

      const result = await resumeWithNoArgs();

      assert.strictEqual(result, "Continue");
      assert.deepStrictEqual(getState().conversation.summaries, []);
      assert.deepStrictEqual(getState().conversation.messages, [
        { role: "user", content: "older" },
      ]);
      assert.deepStrictEqual(getState().conversation.transcript, []);
    });

    it("prints an error when the current session is the only session", async () => {
      actions.setSessionFilePath(
        "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
      );
      addSessionFile(1234567890000, {
        messages: [{ role: "user", content: "hello" }],
        summaries: [],
        transcript: [],
      });

      const result = await resumeWithNoArgs();

      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}No sessions to resume${RESET}\n`,
        "\n",
      ]);
    });
  });

  describe("pageHistory", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("prints that history is empty when the transcript is empty", () => {
      pageHistory({ isTyped: true });
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No chat history${RESET}\n`,
        "\n",
      ]);
    });

    it("surrounds the message with blank lines when isTyped is false", async () => {
      await pageHistory();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${YELLOW}No chat history${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", async () => {
      actions.setApiStreamAbortController(new AbortController());
      await pageHistory();
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No chat history${RESET}\n`,
      ]);
    });

    it("opens the chat history newest first in a pager with a heading prepended", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.setTranscript([
        {
          timestamp: 1000,
          role: "user",
          message: "older content",
        },
        {
          timestamp: 60000,
          role: "assistant",
          message: "newer content",
        },
      ]);
      await pageHistory();
      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Chat history

Jan 1, 1970, 12:01:00 AM  *assistant*
newer content

---

Jan 1, 1970, 12:00:01 AM  *user*
older content

`,
      );
    });
  });

  describe("pageLastResponse", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("prints no messages when there is no assistant response", async () => {
      await pageLastResponse({ isTyped: true });
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No llm messages${RESET}\n`,
        "\n",
      ]);
    });

    it("surrounds the message with blank lines when isTyped is false", async () => {
      await pageLastResponse();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${YELLOW}No llm messages${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", async () => {
      actions.setApiStreamAbortController(new AbortController());
      await pageLastResponse();
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No llm messages${RESET}\n`,
      ]);
    });

    it("opens the latest assistant response in a pager", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.setConversationMessages([
        {
          role: "user",
          content: "question",
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      ]);

      await pageLastResponse();

      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Last response

first
second

`,
      );
    });
  });

  describe("pageLastMessage", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("prints no messages when there is no user message", () => {
      pageLastMessage({ isTyped: true });
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No user messages${RESET}\n`,
        "\n",
      ]);
    });

    it("surrounds the message with blank lines when isTyped is false", async () => {
      await pageLastMessage();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${YELLOW}No user messages${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", async () => {
      actions.setApiStreamAbortController(new AbortController());
      await pageLastMessage();
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No user messages${RESET}\n`,
      ]);
    });

    it("opens the latest user message in a pager", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.setConversationMessages([
        { role: "user", content: "older" },
        {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
        },
        {
          role: "user",
          content: "latest question",
        },
      ]);

      await pageLastMessage();

      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Last message

latest question

`,
      );
    });
  });

  describe("pageLastDiff", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("prints no diffs when there are no diffs", () => {
      pageLastDiff({ isTyped: true });
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No diffs from the last turn${RESET}\n`,
        "\n",
      ]);
    });

    it("surrounds the message with blank lines when isTyped is false", async () => {
      await pageLastDiff();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${YELLOW}No diffs from the last turn${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", async () => {
      actions.setApiStreamAbortController(new AbortController());
      await pageLastDiff();
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No diffs from the last turn${RESET}\n`,
      ]);
    });

    it("opens the diffs in a pager with a fence per file", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.appendToolEditDiff({ fileName: "/a.ts", diffStdout: "+a\n" });
      actions.appendToolEditDiff({ fileName: "/b.ts", diffStdout: "+b\n" });

      await pageLastDiff();

      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `━━ /a.ts ━━\n+a\n\n\n━━ /b.ts ━━\n+b\n\n`,
      );
    });

    it("opens the diffs with collapsed extra trailing newlines", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.appendToolEditDiff({ fileName: "/a.ts", diffStdout: "+a\n\n\n" });

      await pageLastDiff();

      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `━━ /a.ts ━━\n+a\n\n`,
      );
    });
  });

  describe("pageSummaries", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("opens the summaries list newest first in a pager", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.setConversationSummaries([
        { compacted: "older summary", compactedAt: 100, tokens: 10 },
        { compacted: "latest summary", compactedAt: 200, tokens: 20 },
      ]);

      await pageSummaries();

      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.deepStrictEqual(
        stripAnsi(testFs._files.get("/tmp/lasso-test-uuid.txt") ?? ""),
        `# [lasso] Conversation summaries

## Summary 2 (20 tokens, compacted at Jan 1, 1970, 12:00:00 AM)

latest summary

---

## Summary 1 (10 tokens, compacted at Jan 1, 1970, 12:00:00 AM)

older summary

`,
      );
    });

    it("prints a message when there are no conversation summaries", () => {
      pageSummaries({ isTyped: true });

      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No conversation summaries${RESET}\n`,
        "\n",
      ]);
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
    });

    it("surrounds the message with blank lines when isTyped is false", async () => {
      await pageSummaries();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${YELLOW}No conversation summaries${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", async () => {
      actions.setApiStreamAbortController(new AbortController());
      await pageSummaries();
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No conversation summaries${RESET}\n`,
      ]);
    });
  });

  describe("pageEditStr", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("prints that the editor is empty when editor input is null", () => {
      pageEditStr({ isTyped: true });
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}Editor is empty${RESET}\n`,
        "\n",
      ]);
    });

    it("surrounds the message with blank lines when isTyped is false", async () => {
      await pageEditStr();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${YELLOW}Editor is empty${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", async () => {
      actions.setApiStreamAbortController(new AbortController());
      await pageEditStr();
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}Editor is empty${RESET}\n`,
      ]);
    });

    it("opens the editor input in a pager with a header", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.setEditorInputValue("editor input");

      await pageEditStr();

      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Editor content _(4 tokens)_

editor input

`,
      );
    });
  });

  describe("pageSkills", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("opens available skills in a pager", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.setSkills([
        {
          name: "test-skill",
          description: "A test skill",
          dir: "/skills/test-skill",
          content: "skill content",
        },
      ]);

      await pageSkills();

      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Available skills:

- **test-skill** _(4-4 tokens)_: A test skill
  /skills/test-skill

`,
      );
      assert.deepStrictEqual(getWrites(), []);
    });

    it("filters out context file skills", async () => {
      mockPagerSpawn();
      actions.setSkills([
        {
          name: "__lasso-context-for-/ctx",
          description: "Context for /ctx",
          dir: "/ctx",
          content: "context content",
        },
        {
          name: "real-skill",
          description: "A real skill",
          dir: "/skills/real",
          content: "skill content",
        },
      ]);

      await pageSkills();

      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Available skills:

- **real-skill** _(4-4 tokens)_: A real skill
  /skills/real

`,
      );
    });

    it("prints that there are no available skills when skills list is empty", () => {
      pageSkills({ isTyped: true });
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No available skills${RESET}\n`,
        "\n",
      ]);
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
    });

    it("surrounds the message with blank lines when isTyped is false", async () => {
      await pageSkills();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${YELLOW}No available skills${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", async () => {
      actions.setApiStreamAbortController(new AbortController());
      await pageSkills();
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No available skills${RESET}\n`,
      ]);
    });
  });

  describe("pageTools", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("opens the harness tools in a pager", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");

      await pageTools();

      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Available tools:

- **[lasso] web_fetch_html** _(75 tokens)_: Fetch a web page by URL and return its readable content, parsed to extract the main article.
- **[lasso] web_fetch_json** _(67 tokens)_: Fetch a JSON API endpoint by URL and return the parsed JSON response.
- **[lasso] load_skill** _(59 tokens)_: Load a skill to get specialized instructions
- **[lasso] bash** _(241 tokens)_: Execute a bash command and return its output.
- **[lasso] read_image** _(62 tokens)_: Read an image file from disk so you can look at it
- **[lasso] mcp_list_resources** _(93 tokens)_: List the resources of an mcp server
- **[lasso] mcp_read_resource** _(72 tokens)_: Read a resource from an mcp server
- **[lasso] create_subagent** _(391 tokens)_: Launch parallel subagents for independent investigation or implementation. Prefer read-only subagents for parallel work to avoid conflicts. Read-only subagents can fetch web content, inspect files, and load skills; read-write subagents can modify files or execute commands.

`,
      );
    });

    it("opens harness and mcp tools in a pager", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.setMcp(
        {
          first: makeFakeMcpClient({
            tools: () =>
              Promise.resolve({
                mcp_tool: makeMcpTool(),
                described_tool: {
                  ...makeMcpTool(),
                  description: "A described MCP tool",
                },
              }),
          }),
        },
        {},
      );

      await pageTools();

      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Available tools:

- **[lasso] web_fetch_html** _(75 tokens)_: Fetch a web page by URL and return its readable content, parsed to extract the main article.
- **[lasso] web_fetch_json** _(67 tokens)_: Fetch a JSON API endpoint by URL and return the parsed JSON response.
- **[lasso] load_skill** _(59 tokens)_: Load a skill to get specialized instructions
- **[lasso] bash** _(241 tokens)_: Execute a bash command and return its output.
- **[lasso] read_image** _(62 tokens)_: Read an image file from disk so you can look at it
- **[lasso] mcp_list_resources** _(93 tokens)_: List the resources of an mcp server
- **[lasso] mcp_read_resource** _(72 tokens)_: Read a resource from an mcp server
- **[lasso] create_subagent** _(391 tokens)_: Launch parallel subagents for independent investigation or implementation. Prefer read-only subagents for parallel work to avoid conflicts. Read-only subagents can fetch web content, inspect files, and load skills; read-write subagents can modify files or execute commands.
- **[first mcp] mcp_tool** _(22 tokens)_: [no description available]
- **[first mcp] described_tool** _(35 tokens)_: A described MCP tool

`,
      );
    });
  });

  describe("pageContext", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("opens available context files in a pager", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.setContextEntries([
        { filePath: "/project/AGENTS.md", content: "context" },
      ]);

      await pageContext();

      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Available context files:

- /project/AGENTS.md _(2 tokens)_

`,
      );
      assert.deepStrictEqual(getWrites(), []);
    });

    it("includes context file skills", async () => {
      mockPagerSpawn();
      actions.setContextEntries([
        { filePath: "/project/AGENTS.md", content: "context" },
      ]);
      actions.setSkills([
        {
          name: "__lasso-context-for-/other",
          description: "Context for /other",
          dir: "/other",
          content: "other context",
        },
        {
          name: "regular-skill",
          description: "A regular skill",
          dir: "/skills/regular",
          content: "skill content",
        },
      ]);

      await pageContext();

      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Available context files:

- /project/AGENTS.md _(2 tokens)_
- /other/AGENTS.md _(6-4 tokens)_

`,
      );
    });

    it("prints that there are no available context files when entries list is empty", () => {
      pageContext({ isTyped: true });
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No available context files${RESET}\n`,
        "\n",
      ]);
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
    });

    it("surrounds the message with blank lines when isTyped is false", async () => {
      await pageContext();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${YELLOW}No available context files${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", async () => {
      actions.setApiStreamAbortController(new AbortController());
      await pageContext();
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No available context files${RESET}\n`,
      ]);
    });
  });

  describe("printKeymaps", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("prints the keymap list", () => {
      printKeymaps();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${BLUE}Keymaps:${RESET}\n`,
        '- edit: {"name":"g","ctrl":true}\n',
        "\n",
      ]);
    });
  });

  describe("getAvailableCommandsStr", () => {
    beforeEach(() => {
      actions.resetState();
    });

    it("formats builtin and custom commands without token counts by default", () => {
      actions.setSlashCommands([
        {
          name: "custom.md",
          filePath: "/test/.lasso/commands/custom.md",
          content: "custom",
        },
      ]);
      assert.strictEqual(
        getAvailableCommandsStr(),
        `- /edit
- /editpage
- /history
- /clear
- /paste
- /skills
- /context
- /commands
- /keymaps
- /usage
- /tokens
- /resume
- /config
- /reload
- /initlocal
- /initglobal
- /lastresponse
- /lastmessage
- /lastdiff
- /summaries
- /tools
- /record
- /mcps
- /steer
- /test/.lasso/commands/custom.md`,
      );
    });

    it("includes token counts when includeTokenCount is true", () => {
      actions.setSlashCommands([
        {
          name: "custom.md",
          filePath: "/test/.lasso/commands/custom.md",
          content: "custom",
        },
      ]);
      assert.strictEqual(
        getAvailableCommandsStr({ includeTokenCount: true }),
        `- /edit
- /editpage
- /history
- /clear
- /paste
- /skills
- /context
- /commands
- /keymaps
- /usage
- /tokens
- /resume
- /config
- /reload
- /initlocal
- /initglobal
- /lastresponse
- /lastmessage
- /lastdiff
- /summaries
- /tools
- /record
- /mcps
- /steer
- /test/.lasso/commands/custom.md _(2 tokens)_`,
      );
    });
  });

  describe("pageCommands", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("writes builtin and custom commands into the temp file", async () => {
      mockPagerSpawn();
      actions.setSlashCommands([
        {
          name: "custom.md",
          filePath: "/test/.lasso/commands/custom.md",
          content: "custom",
        },
      ]);
      await pageCommands();
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Available commands:

- /edit
- /editpage
- /history
- /clear
- /paste
- /skills
- /context
- /commands
- /keymaps
- /usage
- /tokens
- /resume
- /config
- /reload
- /initlocal
- /initglobal
- /lastresponse
- /lastmessage
- /lastdiff
- /summaries
- /tools
- /record
- /mcps
- /steer
- /test/.lasso/commands/custom.md _(2 tokens)_

`,
      );
      assert.deepStrictEqual(getWrites(), []);
    });

    it("opens commands in a pager via LASSO_PAGER", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      await pageCommands();
      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
    });
  });

  describe("initKeypress", () => {
    let harness: ReturnType<typeof setupKeypressTests>;

    beforeEach(() => {
      actions.setSlashCommands([
        {
          name: "custom",
          filePath: "/test/.lasso/commands/custom.md",
          content: "custom command content",
        },
      ]);
      actions.setKeymaps({
        ...defaultConfig.keymaps,
        custom: { name: "c", ctrl: true },
      });
      harness = setupKeypressTests();
    });

    afterEach(() => {
      harness.cleanup();
    });

    describe("types commands into the prompt", () => {
      it("runs the steer keymap against an active stream and editor input", async () => {
        const apiStream = new AbortController();
        actions.setApiStreamAbortController(apiStream);
        actions.setEditorInputValue("steering input");
        actions.setQuestionAbortController(null);
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          steer: { name: "s", ctrl: true },
        });

        harness.emitKey({ name: "s", ctrl: true });
        await harness.flush();

        assert.strictEqual(apiStream.signal.aborted, true);
        assert.strictEqual(getState().terminal.isSteering, true);
        assert.deepStrictEqual(harness.writes, []);
      });

      it("types custom slash command into the prompt when its keymap matches", () => {
        harness.emitKey({ name: "c", ctrl: true });
        assert.deepStrictEqual(harness.writes, [
          { chunk: "/custom\n", key: undefined },
        ]);
      });

      it("does not type custom slash command when no question is pending", () => {
        actions.setQuestionAbortController(null);
        harness.emitKey({ name: "c", ctrl: true });
        assert.deepStrictEqual(harness.writes, []);
      });

      for (const [command, keyName] of [
        ["clear", "k"],
        ["keymaps", "p"],
        ["usage", "u"],
        ["tokens", "t"],
        ["resume", "r"],
      ] as const) {
        it(`types /${command} into the prompt when its keymap matches`, () => {
          actions.setKeymaps({
            ...defaultConfig.keymaps,
            [command]: { name: keyName, ctrl: true },
          });
          harness.emitKey({ name: keyName, ctrl: true });
          assert.deepStrictEqual(harness.writes, [
            { chunk: `/${command}\n`, key: undefined },
          ]);
        });
      }
      for (const [command, keyName] of [
        ["skills", "l"],
        ["context", "n"],
      ] as const) {
        it(`opens the /${command} pager when its keymap matches`, async () => {
          const { spawned } = mockPagerSpawn();
          testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
          actions.setQuestionAbortController(null);
          actions.setContextEntries([
            { filePath: "/project/AGENTS.md", content: "context" },
          ]);
          actions.setSkills([
            {
              name: "test-skill",
              description: "A test skill",
              dir: "/skills/test-skill",
              content: "skill content",
            },
          ]);
          setMcpClients({ clients: { first: makeFakeMcpClient() } });
          actions.setKeymaps({
            ...defaultConfig.keymaps,
            [command]: { name: keyName, ctrl: true },
          });
          harness.emitKey({ name: keyName, ctrl: true });
          await harness.flush();
          assert.deepStrictEqual(harness.writes, []);
          assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
        });
      }

      it("prints MCP servers when the mcps keymap matches", async () => {
        actions.setQuestionAbortController(null);
        setMcpClients({ clients: { first: makeFakeMcpClient() } });
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          mcps: { name: "o", ctrl: true },
        });

        harness.emitKey({ name: "o", ctrl: true });
        await harness.flush();

        assert.deepStrictEqual(harness.writes, []);
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${BLUE}Available MCP servers:${RESET}\n`,
          "- first (fake-server v0.0.0)\n",
          "\n",
        ]);
      });
      it("does not type builtin command when no question is pending", () => {
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          clear: { name: "k", ctrl: true },
        });
        actions.setQuestionAbortController(null);
        harness.emitKey({ name: "k", ctrl: true });
        assert.deepStrictEqual(harness.writes, []);
      });

      it("uses the first matching builtin keymap when commands share a key", () => {
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          clear: { name: "x", ctrl: true },
          skills: { name: "x", ctrl: true },
        });
        harness.emitKey({ name: "x", ctrl: true });
        assert.deepStrictEqual(harness.writes, [
          { chunk: "/clear\n", key: undefined },
        ]);
      });

      it("prefers builtin commands over custom commands on the same key", () => {
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          clear: { name: "c", ctrl: true },
        });
        harness.emitKey({ name: "c", ctrl: true });
        assert.deepStrictEqual(harness.writes, [
          { chunk: "/clear\n", key: undefined },
        ]);
      });
    });

    describe("runs edit and paste", () => {
      it("ignores keymaps while the stop-recording question is pending", async () => {
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          clear: { name: "k", ctrl: true },
        });
        actions.setIsNonBlockingProcessOngoing(true);
        harness.emitKey({ name: "k", ctrl: true });
        await harness.flush();
        assert.deepStrictEqual(harness.writes, []);
        assert.strictEqual(getState().terminal.editorInputValue, null);
      });

      it("ignores keymaps while recording", async () => {
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          clear: { name: "k", ctrl: true },
        });
        actions.setIsRecording(true);
        harness.emitKey({ name: "k", ctrl: true });
        await harness.flush();
        assert.deepStrictEqual(harness.writes, []);
      });

      it("runs the record keymap and toggles isRecording around it", async () => {
        let recordingDuringQuestion: boolean | undefined;
        actions.setQuestionAbortController(null);
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          record: { name: "r", ctrl: true },
        });
        testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "key");
        actions.setTranscriptionSdkProvider("openai");
        actions.setTranscriptionModel("gpt-4o-transcribe");
        actions.setRl(
          makeFakeRl({
            question: () => {
              recordingDuringQuestion = getState().terminal.isRecording;
              return Promise.resolve("");
            },
          }),
        );
        actions.resetStdout();
        mockRecording();
        mockTranscription("hello from the mic");
        harness.emitKey({ name: "r", ctrl: true });
        assert.strictEqual(getState().terminal.isRecording, true);
        await harness.flush();
        assert.strictEqual(recordingDuringQuestion, true);
        assert.strictEqual(getState().terminal.isRecording, false);
        assert.strictEqual(
          getState().terminal.editorInputValue,
          "[Message transcribed; may contain errors] hello from the mic",
        );
      });

      it("appends transcription after the delimiter when the editor has content", async () => {
        actions.setQuestionAbortController(null);
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          record: { name: "r", ctrl: true },
        });
        testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "key");
        actions.setTranscriptionSdkProvider("openai");
        actions.setTranscriptionModel("gpt-4o-transcribe");
        actions.setRl(makeFakeRl({ question: () => Promise.resolve("") }));
        actions.appendEditorInputValue("draft");
        actions.resetStdout();
        mockRecording();
        mockTranscription("hello from the mic");
        harness.emitKey({ name: "r", ctrl: true });
        await harness.flush();
        assert.strictEqual(
          getState().terminal.editorInputValue,
          `draft\n${defaultConfig.messageQueueDelimiter}[Message transcribed; may contain errors] hello from the mic`,
        );
      });

      it("does not append an empty transcription to the editor", async () => {
        actions.setQuestionAbortController(null);
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          record: { name: "r", ctrl: true },
        });
        testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "key");
        actions.setTranscriptionSdkProvider("openai");
        actions.setTranscriptionModel("gpt-4o-transcribe");
        actions.setRl(makeFakeRl({ question: () => Promise.resolve("") }));
        actions.resetStdout();
        mockRecording();
        mockTranscription("");
        harness.emitKey({ name: "r", ctrl: true });
        await harness.flush();
        assert.strictEqual(getState().terminal.editorInputValue, null);
      });

      it("runs edit command when its keymap matches", async () => {
        const prompts: boolean[] = [];
        mock.method(harness.rl, "prompt", (arg: boolean) => {
          prompts.push(arg);
        });
        mockEditorSpawn(() => {
          testFs.writeFile("/tmp/lasso-test-uuid.txt", "  edited  ");
        });
        harness.emitKey({ name: "g", ctrl: true });
        assert.strictEqual(
          getState().terminal.isNonBlockingProcessOngoing,
          true,
        );
        await harness.flush();
        assert.deepStrictEqual(prompts, []);
        assert.strictEqual(getState().terminal.editorInputValue, "  edited  ");
        assert.strictEqual(
          getState().terminal.isNonBlockingProcessOngoing,
          false,
        );
      });

      it("runs paste command with clipboard when its keymap matches", async () => {
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          paste: { name: "v", ctrl: true },
        });
        mockClipboardPaste("world");
        mockEditorSpawn(() => {
          testFs.writeFile(
            "/tmp/lasso-test-uuid.txt",
            "  hello world modified  \n",
          );
        });
        harness.emitKey({ name: "v", ctrl: true });
        await harness.flush();
        assert.strictEqual(
          getState().terminal.editorInputValue,
          "  hello world modified  \n",
        );
      });

      it("replays stdout printed while the editor was open and clears the buffer", async () => {
        const getWrites = mockStdoutWrites();
        mockEditorSpawn(() => {
          print.info("during editor");
          testFs.writeFile("/tmp/lasso-test-uuid.txt", "");
        });
        harness.emitKey({ name: "g", ctrl: true });
        await harness.flush();

        assert.strictEqual(
          getState().terminal.bufferedStdoutWhileEditorOpen,
          "",
        );
        assert.deepStrictEqual(getWrites(), [
          `${PURPLE}during editor${RESET}\n`,
        ]);
      });

      it("does not replay buffered stdout from a previous editor session", async () => {
        const getWrites = mockStdoutWrites();
        mockEditorSpawn(() => {
          print.info("first");
          testFs.writeFile("/tmp/lasso-test-uuid.txt", "");
        });
        harness.emitKey({ name: "g", ctrl: true });
        await harness.flush();

        mockEditorSpawn(() => {
          print.info("second");
          testFs.writeFile("/tmp/lasso-test-uuid.txt", "");
        });
        harness.emitKey({ name: "g", ctrl: true });
        await harness.flush();

        assert.deepStrictEqual(getWrites(), [
          `${PURPLE}first${RESET}\n`,
          `${PURPLE}second${RESET}\n`,
        ]);
      });

      it("flushes buffered stdout before restarting the loading state spinner", async () => {
        const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });
        const spinnerFrames = mockSetInterval();
        mockClearInterval(spinnerFrames);
        actions.setApiStreamAbortController(new AbortController());
        mockEditorSpawn(() => {
          print.info("during editor");
          testFs.writeFile("/tmp/lasso-test-uuid.txt", "");
        });
        harness.emitKey({ name: "g", ctrl: true });
        await harness.flush();

        assert.deepStrictEqual(getWrites(), [
          `${PURPLE}during editor${RESET}\n`,
          "\r|",
        ]);
      });

      it("redraws the pending question prompt after a cancelled edit", async () => {
        const prompts: boolean[] = [];
        mock.method(harness.rl, "prompt", (arg: boolean) => {
          prompts.push(arg);
        });
        mockEditorSpawn(() => {
          testFs.writeFile("/tmp/lasso-test-uuid.txt", "");
        });
        harness.emitKey({ name: "g", ctrl: true });
        await harness.flush();
        assert.deepStrictEqual(prompts, [true]);
        assert.strictEqual(getState().terminal.editorInputValue, null);
      });

      it("reserves prompt-prefix columns when truncating editor text", async () => {
        mock.method(processDeps.stdout, "getColumns", () => 10);
        actions.setPromptPrefix(">>>>>>");
        mockEditorSpawn(() => {
          testFs.writeFile("/tmp/lasso-test-uuid.txt", "abcdefghij");
        });
        harness.emitKey({ name: "g", ctrl: true });
        await harness.flush();

        assert.deepStrictEqual(harness.writes, [
          { chunk: null, key: { ctrl: true, name: "e" } },
          { chunk: null, key: { ctrl: true, name: "u" } },
          { chunk: "abc…", key: undefined },
        ]);
      });
    });

    describe("pages history and the last turn", () => {
      it("opens chat history in a pager when history keymap matches", async () => {
        const prompts: boolean[] = [];
        mock.method(harness.rl, "prompt", (arg: boolean) => {
          prompts.push(arg);
        });
        const { spawned } = mockPagerSpawn();
        actions.setBatAvailable(true);
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          history: { name: "h", ctrl: true },
        });
        actions.setTranscript([
          {
            timestamp: 0,
            role: "user",
            message: "log content",
          },
        ]);
        harness.emitKey({ name: "h", ctrl: true });
        await harness.flush();
        assert.strictEqual(spawned[0], batPagerCmd("/tmp/lasso-test-uuid.txt"));
        assert.strictEqual(
          testFs._files.get("/tmp/lasso-test-uuid.txt"),
          `# [lasso] Chat history

Jan 1, 1970, 12:00:00 AM  *user*
log content

`,
        );
        assert.deepStrictEqual(getWrites(), []);
        assert.deepStrictEqual(prompts, [true]);
      });

      it("does not redraw the prompt after paging chat history without a pending question", async () => {
        const prompts: boolean[] = [];
        mock.method(harness.rl, "prompt", (arg: boolean) => {
          prompts.push(arg);
        });
        const { spawned } = mockPagerSpawn();
        actions.setBatAvailable(true);
        actions.setQuestionAbortController(null);
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          history: { name: "h", ctrl: true },
        });
        actions.setTranscript([
          {
            timestamp: 0,
            role: "user",
            message: "log content",
          },
        ]);
        harness.emitKey({ name: "h", ctrl: true });
        await harness.flush();
        assert.strictEqual(spawned[0], batPagerCmd("/tmp/lasso-test-uuid.txt"));
        assert.deepStrictEqual(prompts, []);
      });

      it("opens the last response in a pager when lastresponse keymap matches and redraws the pending question prompt", async () => {
        const prompts: boolean[] = [];
        mock.method(harness.rl, "prompt", (arg: boolean) => {
          prompts.push(arg);
        });
        const { spawned } = mockPagerSpawn();
        testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          lastresponse: { name: "u", ctrl: true },
        });
        actions.setConversationMessages([
          {
            role: "user",
            content: "question",
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "first" }],
          },
        ]);
        harness.emitKey({ name: "u", ctrl: true });
        await harness.flush();
        assert.deepStrictEqual(spawned, ["nano /tmp/lasso-test-uuid.txt"]);
        assert.deepStrictEqual(prompts, [true]);
      });

      it("opens diffs from the last turn in a pager when lastdiff keymap matches and redraws the pending question prompt", async () => {
        const prompts: boolean[] = [];
        mock.method(harness.rl, "prompt", (arg: boolean) => {
          prompts.push(arg);
        });
        const { spawned } = mockPagerSpawn();
        testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          lastdiff: { name: "d", ctrl: true },
        });
        actions.appendToolEditDiff({ fileName: "/a.ts", diffStdout: "+a\n" });
        harness.emitKey({ name: "d", ctrl: true });
        await harness.flush();
        assert.deepStrictEqual(spawned, ["nano /tmp/lasso-test-uuid.txt"]);
        assert.deepStrictEqual(prompts, [true]);
      });

      it("opens config diffs in a pager when reload keymap matches and redraws the pending question prompt", async () => {
        const prompts: boolean[] = [];
        mock.method(harness.rl, "prompt", (arg: boolean) => {
          prompts.push(arg);
        });
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            model: "gpt-4",
            baseURL: "https://api.example.com",
          }),
        );
        testProcessEnv._set("LASSO_PAGER", "cat __FILE__");
        const { spawned } = mockPagerSpawn();
        mockExecCalls([
          { stdout: "delta 0.18.2" },
          { stdout: "global diff\n" },
          { stdout: "delta 0.18.2" },
          { stdout: "local diff\n" },
          { stdout: "delta 0.18.2" },
          { stdout: "applied diff\n" },
          { stdout: "delta 0.18.2" },
          { stdout: "context diff\n" },
          { stdout: "delta 0.18.2" },
          { stdout: "skills diff\n" },
          { stdout: "delta 0.18.2" },
          { stdout: "commands diff\n" },
        ]);
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          reload: { name: "w", ctrl: true },
        });
        harness.emitKey({ name: "w", ctrl: true });
        await harness.flush();
        assert.deepStrictEqual(prompts, [true]);
        assert.notStrictEqual(spawned.length, 0);
      });
    });

    describe("opens pages", () => {
      it("opens editor input in a pager when editpage keymap matches", async () => {
        const prompts: boolean[] = [];
        mock.method(harness.rl, "prompt", (arg: boolean) => {
          prompts.push(arg);
        });
        const { spawned } = mockPagerSpawn();
        testProcessEnv._set("LASSO_PAGER", "cat __FILE__");
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          editpage: { name: "e", ctrl: true },
        });
        actions.setEditorInputValue("editor input");
        harness.emitKey({ name: "e", ctrl: true });
        await harness.flush();
        assert.strictEqual(
          testFs._files.get("/tmp/lasso-test-uuid.txt"),
          `# [lasso] Editor content _(4 tokens)_

editor input

`,
        );
        assert.deepStrictEqual(getWrites(), []);
        assert.deepStrictEqual(prompts, [true]);
        assert.deepStrictEqual(spawned, ["cat /tmp/lasso-test-uuid.txt"]);
      });

      it("opens config in a pager when config keymap matches", async () => {
        const prompts: boolean[] = [];
        mock.method(harness.rl, "prompt", (arg: boolean) => {
          prompts.push(arg);
        });
        const { spawned } = mockPagerSpawn();
        testProcessEnv._set("LASSO_PAGER", "cat __FILE__");
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          config: { name: "q", ctrl: true },
        });
        harness.emitKey({ name: "q", ctrl: true });
        await harness.flush();
        assert.match(
          testFs._files.get("/tmp/lasso-test-uuid.txt") ?? "",
          /# Applied config/,
        );
        assert.deepStrictEqual(getWrites(), []);
        assert.deepStrictEqual(prompts, [true]);
        assert.deepStrictEqual(spawned, ["cat /tmp/lasso-test-uuid.txt"]);
      });

      it("opens available commands in a pager when commands keymap matches", async () => {
        const prompts: boolean[] = [];
        mock.method(harness.rl, "prompt", (arg: boolean) => {
          prompts.push(arg);
        });
        const { spawned } = mockPagerSpawn();
        testProcessEnv._set("LASSO_PAGER", "cat __FILE__");
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          commands: { name: "o", ctrl: true },
        });
        harness.emitKey({ name: "o", ctrl: true });
        await harness.flush();
        assert.strictEqual(
          testFs._files.get("/tmp/lasso-test-uuid.txt"),
          `# [lasso] Available commands:

- /edit
- /editpage
- /history
- /clear
- /paste
- /skills
- /context
- /commands
- /keymaps
- /usage
- /tokens
- /resume
- /config
- /reload
- /initlocal
- /initglobal
- /lastresponse
- /lastmessage
- /lastdiff
- /summaries
- /tools
- /record
- /mcps
- /steer
- /test/.lasso/commands/custom.md _(2 tokens)_

`,
        );
        assert.deepStrictEqual(getWrites(), []);
        assert.deepStrictEqual(prompts, [true]);
        assert.deepStrictEqual(spawned, ["cat /tmp/lasso-test-uuid.txt"]);
      });

      it("opens available tools in a pager when tools keymap matches", async () => {
        const prompts: boolean[] = [];
        mock.method(harness.rl, "prompt", (arg: boolean) => {
          prompts.push(arg);
        });
        const { spawned } = mockPagerSpawn();
        testProcessEnv._set("LASSO_PAGER", "cat __FILE__");
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          tools: { name: ".", ctrl: true },
        });
        harness.emitKey({ name: ".", ctrl: true });
        await harness.flush();
        assert.strictEqual(
          testFs._files.get("/tmp/lasso-test-uuid.txt"),
          `# [lasso] Available tools:

- **[lasso] web_fetch_html** _(75 tokens)_: Fetch a web page by URL and return its readable content, parsed to extract the main article.
- **[lasso] web_fetch_json** _(67 tokens)_: Fetch a JSON API endpoint by URL and return the parsed JSON response.
- **[lasso] load_skill** _(59 tokens)_: Load a skill to get specialized instructions
- **[lasso] bash** _(241 tokens)_: Execute a bash command and return its output.
- **[lasso] read_image** _(62 tokens)_: Read an image file from disk so you can look at it
- **[lasso] mcp_list_resources** _(93 tokens)_: List the resources of an mcp server
- **[lasso] mcp_read_resource** _(72 tokens)_: Read a resource from an mcp server
- **[lasso] create_subagent** _(391 tokens)_: Launch parallel subagents for independent investigation or implementation. Prefer read-only subagents for parallel work to avoid conflicts. Read-only subagents can fetch web content, inspect files, and load skills; read-write subagents can modify files or execute commands.

`,
        );
        assert.deepStrictEqual(getWrites(), []);
        assert.deepStrictEqual(prompts, [true]);
        assert.deepStrictEqual(spawned, ["cat /tmp/lasso-test-uuid.txt"]);
      });
    });

    describe("key matching and loading", () => {
      it("does nothing on unmatched keys", () => {
        harness.emitKey({ name: "x", ctrl: true });
        assert.deepStrictEqual(harness.writes, []);
      });

      it("clears the line on unmatched keys during loading", () => {
        actions.setLoadingStateTimeout({} as NodeJS.Timeout);
        harness.emitKey({ name: "z", ctrl: true });
        assert.deepStrictEqual(harness.writes, [
          { chunk: null, key: { ctrl: true, name: "u" } },
        ]);
        assert.deepStrictEqual(getWrites(), []);
      });

      it("types keymap command while loading when a question is pending", () => {
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          clear: { name: "k", ctrl: true },
        });
        actions.setLoadingStateTimeout({} as NodeJS.Timeout);
        harness.emitKey({ name: "k", ctrl: true });
        assert.deepStrictEqual(harness.writes, [
          { chunk: "/clear\n", key: undefined },
        ]);
      });

      it("does not clear the line for matched keys during loading", () => {
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          clear: { name: "k", ctrl: true },
        });
        actions.setQuestionAbortController(null);
        actions.setLoadingStateTimeout({} as NodeJS.Timeout);
        harness.emitKey({ name: "k", ctrl: true });
        assert.deepStrictEqual(getWrites(), []);
        assert.deepStrictEqual(harness.writes, []);
      });
    });
  });

  describe("steerCommand", () => {
    afterEach(() => {
      mock.restoreAll();
    });

    beforeEach(() => {
      setupTestContext();
    });

    it("warns when no agent turn is active", () => {
      const getWrites = mockStdoutWrites();

      steerCommand();

      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${YELLOW}/steer can only be triggered during an ongoing agent turn${RESET}\n`,
        "\n",
      ]);
      assert.strictEqual(getState().terminal.isSteering, false);
    });

    it("warns when editor input is empty during an agent turn", () => {
      const apiStream = new AbortController();
      actions.setApiStreamAbortController(apiStream);
      const getWrites = mockStdoutWrites();

      steerCommand();

      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}The editor is empty, unable to steer${RESET}\n`,
      ]);
      assert.strictEqual(apiStream.signal.aborted, false);
      assert.strictEqual(getState().terminal.isSteering, false);
    });
  });

  describe("resolveSlashCommand", () => {
    beforeEach(() => {
      actions.setRl(makeFakeRl({ line: "" }));
      mockSpawnSync();
    });

    describe("editing commands", () => {
      it("handles /edit command", async () => {
        const result = await resolveSlashCommand("/edit");
        assert.strictEqual(result, null);
      });

      it("handles /editpage command by opening the current editor input in a pager", async () => {
        testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
        actions.setEditorInputValue("editor input");
        const result = await resolveSlashCommand("/editpage");
        assert.strictEqual(result, null);
        assert.strictEqual(
          testFs._files.get("/tmp/lasso-test-uuid.txt"),
          `# [lasso] Editor content _(4 tokens)_

editor input

`,
        );
      });

      it("handles /edit command and logs editor content to the transcript", async () => {
        mockEditorSpawn(() => {
          testFs.writeFile("/tmp/lasso-test-uuid.txt", "from editor");
        });
        const result = await resolveSlashCommand("/edit");
        assert.strictEqual(result, "from editor\n");
        assert.deepStrictEqual(getState().conversation.transcript, [
          { timestamp: 0, role: "user", message: "from editor\n" },
        ]);
      });

      it("handles /paste command and logs editor content to the transcript", async () => {
        mockClipboardPaste("clip");
        mockEditorSpawn(() => {
          testFs.writeFile("/tmp/lasso-test-uuid.txt", "pasted content");
        });
        const result = await resolveSlashCommand("/paste");
        assert.strictEqual(result, "pasted content\n");
        assert.deepStrictEqual(getState().conversation.transcript, [
          { timestamp: 0, role: "user", message: "pasted content\n" },
        ]);
      });
    });

    describe("state commands", () => {
      it("handles /clear command", async () => {
        const result = await resolveSlashCommand("/clear");
        assert.strictEqual(result, null);
      });

      it("warns that /steer must be triggered by a keymap", async () => {
        const getWrites = mockStdoutWrites();

        const result = await resolveSlashCommand("/steer");

        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), [
          `${YELLOW}/steer can only be triggered via a keymap during an ongoing agent turn${RESET}\n`,
          "\n",
        ]);
      });

      it("rejects /model with args", async () => {
        const { spawned } = mockPagerSpawn();
        testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
        actions.setModel("old");
        actions.setSlashCommands([
          {
            name: "known",
            filePath: "/test-cwd/.lasso/commands/known.md",
            content: "known content",
          },
        ]);
        actions.resetStdout();
        const result = await resolveSlashCommand("/model new-model");
        assert.strictEqual(result, null);
        assert.strictEqual(getState().config.model, "old");
        assert.deepStrictEqual(getWrites(), []);
        assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      });

      it("rejects /model without args", async () => {
        const { spawned } = mockPagerSpawn();
        testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
        actions.setModel("gpt-4");
        actions.resetStdout();
        const result = await resolveSlashCommand("/model");
        assert.strictEqual(result, null);
        assert.strictEqual(getState().config.model, "gpt-4");
        assert.deepStrictEqual(getWrites(), []);
        assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      });

      it("handles /skills command", async () => {
        actions.resetStdout();
        const result = await resolveSlashCommand("/skills");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${YELLOW}No available skills${RESET}\n`,
          "\n",
        ]);
      });

      it("handles /context command", async () => {
        actions.resetStdout();
        const result = await resolveSlashCommand("/context");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${YELLOW}No available context files${RESET}\n`,
          "\n",
        ]);
      });
      it("handles /mcps command", async () => {
        actions.resetStdout();
        const result = await resolveSlashCommand("/mcps");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${YELLOW}No available MCP servers${RESET}\n`,
          "\n",
        ]);
      });
    });

    describe("record commands", () => {
      it("handles /record command and logs the recording to the transcript", async () => {
        testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "key");
        actions.setTranscriptionSdkProvider("openai");
        actions.setTranscriptionModel("gpt-4o-transcribe");
        actions.resetStdout();
        let recordingDuringQuestion: boolean | undefined;
        actions.setRl(
          makeFakeRlWithWrites({
            question: () => {
              recordingDuringQuestion = getState().terminal.isRecording;
              return Promise.resolve("");
            },
          }).rl,
        );
        assert.strictEqual(getState().terminal.isRecording, false);
        mockRecording();
        mockTranscription("hello from the mic");
        testFs._files.set("/tmp/lasso-test-uuid.wav", "wav recording bytes");
        const result = await resolveSlashCommand("/record");
        assert.strictEqual(
          result,
          "[Message transcribed; may contain errors] hello from the mic",
        );
        assert.strictEqual(recordingDuringQuestion, true);
        assert.strictEqual(getState().terminal.isRecording, false);
        assert.deepStrictEqual(getState().conversation.transcript, [
          {
            timestamp: 0,
            role: "user",
            message:
              "[Message transcribed; may contain errors] hello from the mic",
          },
        ]);
      });

      it("handles /record command without transcription config by printing a warning", async () => {
        actions.resetStdout();
        const result = await resolveSlashCommand("/record");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), [
          `${YELLOW}Warning! You're missing required configuration options for /record.
- Set the \`LASSO_TRANSCRIPTION_API_KEY\` environment variable, e.g. \`export LASSO_TRANSCRIPTION_API_KEY=...\`
- Set \`transcriptionSdkProvider\` in your config file (\`openai\` or \`google\`)
- Set \`transcriptionModel\` in your config file${RESET}
`,
        ]);
      });
    });

    describe("paging commands", () => {
      it("handles /history command by opening chat history in a pager", async () => {
        testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
        actions.setTranscript([
          {
            timestamp: 0,
            role: "user",
            message: "log content",
          },
        ]);
        const result = await resolveSlashCommand("/history");
        assert.strictEqual(result, null);
        assert.strictEqual(
          testFs._files.get("/tmp/lasso-test-uuid.txt"),
          `# [lasso] Chat history

Jan 1, 1970, 12:00:00 AM  *user*
log content

`,
        );
      });

      it("handles /lastmessage command by opening the last user message in a pager", async () => {
        const { spawned } = mockPagerSpawn();
        testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
        actions.setConversationMessages([
          {
            role: "user",
            content: "question",
          },
        ]);
        const result = await resolveSlashCommand("/lastmessage");
        assert.strictEqual(result, null);
        assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      });

      it("handles /lastdiff command by opening the last turn diffs in a pager", async () => {
        const { spawned } = mockPagerSpawn();
        testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
        actions.appendToolEditDiff({ fileName: "/a.ts", diffStdout: "+a\n" });
        actions.appendToolEditDiff({ fileName: "/b.ts", diffStdout: "+b\n" });
        const result = await resolveSlashCommand("/lastdiff");
        assert.strictEqual(result, null);
        assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
        assert.strictEqual(
          testFs._files.get("/tmp/lasso-test-uuid.txt"),
          `━━ /a.ts ━━
+a


━━ /b.ts ━━
+b

`,
        );
      });

      it("prints no diffs message when a /lastdiff command has no diffs", async () => {
        actions.resetStdout();
        const { spawned } = mockPagerSpawn();
        const result = await resolveSlashCommand("/lastdiff");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), [
          `${YELLOW}No diffs from the last turn${RESET}\n`,
          "\n",
        ]);
        assert.deepStrictEqual(spawned, []);
      });

      it("handles /tools command by opening the tools list in a pager", async () => {
        const { spawned } = mockPagerSpawn();
        testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
        const result = await resolveSlashCommand("/tools");
        assert.strictEqual(result, null);
        assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      });

      it("handles /commands command by opening commands in a pager", async () => {
        actions.resetStdout();
        const result = await resolveSlashCommand("/commands");
        assert.strictEqual(result, null);
        assert.strictEqual(
          testFs._files.get("/tmp/lasso-test-uuid.txt"),
          `# [lasso] Available commands:

- /edit
- /editpage
- /history
- /clear
- /paste
- /skills
- /context
- /commands
- /keymaps
- /usage
- /tokens
- /resume
- /config
- /reload
- /initlocal
- /initglobal
- /lastresponse
- /lastmessage
- /lastdiff
- /summaries
- /tools
- /record
- /mcps

`,
        );
      });

      it("handles /config command by opening combined config in a pager", async () => {
        testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
        actions.resetStdout();
        const result = await resolveSlashCommand("/config");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), []);
        const tempContent = testFs._files.get("/tmp/lasso-test-uuid.txt");
        assert.ok(tempContent !== undefined);
        assert.match(tempContent, /^# Applied config\n/);
        assert.match(tempContent, /\n# Global config from path: /);
        assert.match(tempContent, /\n# Local config from path: /);
      });

      it("handles /keymaps command", async () => {
        actions.resetStdout();
        const result = await resolveSlashCommand("/keymaps");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${BLUE}Keymaps:${RESET}\n`,
          '- edit: {"name":"g","ctrl":true}\n',
          "\n",
        ]);
      });

      it("prints usage when /keymaps receives arguments", async () => {
        actions.resetStdout();
        const result = await resolveSlashCommand("/keymaps unexpected");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), [
          `${RED}Usage: /keymaps${RESET}\n`,
        ]);
      });
    });

    describe("usage and resume commands", () => {
      it("handles /usage command", async () => {
        actions.resetStdout();
        actions.setModel("unknown-model");
        const result = await resolveSlashCommand("/usage");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${BLUE}Usage:${RESET}\n`,
          "- Session: 0 tokens\n",
          "\n",
        ]);
      });

      it("handles /usage command with a usage limit", async () => {
        actions.resetStdout();
        actions.setModel("claude-haiku-4-5");
        actions.setPricingPerModel({
          "claude-haiku-4-5": {
            inputPerMillion: 1,
            outputPerMillion: 5,
            cacheReadPerMillion: 0.25,
            cacheWritePerMillion: 1.25,
          },
        });
        actions.setUsageLimit({ duration: "60m", dollarAmount: 10 });
        const result = await resolveSlashCommand("/usage");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${BLUE}Usage:${RESET}\n`,
          "- Session: 0 tokens, $0.000\n",
          "- 60m window: $0.000 of $10.000 limit\n",
          "\n",
        ]);
      });

      it("handles /usage command with usage and a usage limit", async () => {
        actions.resetStdout();
        actions.setModel("claude-haiku-4-5");
        actions.setPricingPerModel({
          "claude-haiku-4-5": {
            inputPerMillion: 1,
            outputPerMillion: 5,
            cacheReadPerMillion: 0.25,
            cacheWritePerMillion: 1.25,
          },
        });
        actions.setModelUsageForSession({
          "claude-haiku-4-5": [
            {
              inputTokens: 3_000_000,
              outputTokens: 100_000,
              cacheReadTokens: 1_000_000,
              cacheWriteTokens: 0,
              date: 42,
            },
          ],
        });
        actions.setModelUsageForLimitWindow({
          "claude-haiku-4-5": [
            {
              inputTokens: 1_500_000,
              outputTokens: 40_000,
              cacheReadTokens: 500_000,
              cacheWriteTokens: 100_000,
              date: 42,
            },
          ],
        });
        actions.setUsageLimit({ duration: "60m", dollarAmount: 1234.5 });
        const result = await resolveSlashCommand("/usage");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${BLUE}Usage:${RESET}\n`,
          "- Session: 3,100,000 tokens, $2.750\n",
          "- 60m window: $1.350 of $1,234.500 limit\n",
          "\n",
        ]);
      });

      it("handles /tokens command", async () => {
        actions.resetStdout();
        actions.setModel("test-model");
        actions.setContextWindowPerModel({ "test-model": 10_000 });
        const result = await resolveSlashCommand("/tokens");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${BLUE}Token count: 845 (0% of context window)${RESET}\n`,
          `- Chat messages: 0
- Context files: 0
- Harness and MCP tools: 0
- Base system prompt: 853
- Skill descriptions: 0
`,
          "\n",
        ]);
      });

      it("handles /resume without args", async () => {
        actions.resetStdout();
        testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
        testFs._files.set(
          "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
          JSON.stringify({
            messages: [{ role: "user", content: "hello" }],
            summaries: [],
            transcript: [],
          }),
        );
        const result = await resolveSlashCommand("/resume");
        assert.strictEqual(result, "Continue");
        assert.deepStrictEqual(getState().conversation.transcript, [
          { timestamp: 0, role: "user", message: "Continue" },
        ]);
      });

      it("handles /resume with a session start date", async () => {
        testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
        testFs._files.set(
          "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
          JSON.stringify({
            messages: [{ role: "user", content: "hello" }],
            summaries: [],
            transcript: [],
          }),
        );
        const result = await resolveSlashCommand("/resume 1234567890000");
        assert.strictEqual(result, "Continue");
        assert.deepStrictEqual(getState().conversation.transcript, [
          { timestamp: 0, role: "user", message: "Continue" },
        ]);
      });
    });

    describe("reloads config", () => {
      it("skips the before-and-after diff when a before temp file cannot be created", async () => {
        testProcessEnv._set("LASSO_PAGER", "cat __FILE__");
        mockPagerSpawn();
        mock.method(fsDeps, "writeFile", (path: string, content: string) => {
          if (path === "/tmp/lasso-global-before-test-uuid.txt") {
            return Promise.reject(new Error("write failed"));
          }
          return testFs.writeFile(path, content);
        });
        mockExecCalls([
          { stdout: "delta 0.18.2" },
          { stdout: "local diff\n" },
          { stdout: "delta 0.18.2" },
          { stdout: "applied diff\n" },
          { stdout: "delta 0.18.2" },
          { stdout: "context diff\n" },
          { stdout: "delta 0.18.2" },
          { stdout: "skills diff\n" },
          { stdout: "delta 0.18.2" },
          { stdout: "commands diff\n" },
        ]);
        const writes = mockStdoutWrites();

        const result = await resolveSlashCommand("/reload");
        assert.strictEqual(result, null);
        assert.strictEqual(
          testFs._files.get("/tmp/lasso-test-uuid.txt"),
          `Local config from path: /test-cwd/.lasso/settings.yaml
local diff

Applied config:
applied diff

Agent context:
context diff

Agent skills:
skills diff

Custom slash commands:
commands diff

`,
        );
        assert.strictEqual(
          testFs._files.has("/tmp/lasso-global-after-test-uuid.txt"),
          false,
        );
        assert.deepStrictEqual(writes(), [
          `${YELLOW}- Warning: using a default context window of 128,000 tokens because there is no \`contextWindowPerModel\` entry for the current model \`__MISSING__\`${RESET}\n`,
          `${BLUE}Reading context files: ${RESET}\n`,
          `${BLUE}Reading skills: ${RESET}\n`,
          `${BLUE}Reading slash commands: ${RESET}\n`,
          `${BLUE}Reading context files: ${RESET}`,
          `${GREEN}0.0ms${RESET}`,
          `${BLUE}Reading skills: ${RESET}`,
          `${GREEN}0.0ms${RESET}`,
          `${BLUE}Reading slash commands: ${RESET}`,
          `${GREEN}0.0ms${RESET}`,
          `${RED}Failed to write to a temp file. Error: write failed${RESET}\n`,
        ]);
      });

      it("unlinks the before temp file when the after temp file cannot be created", async () => {
        testProcessEnv._set("LASSO_PAGER", "cat __FILE__");
        mockPagerSpawn();
        mock.method(fsDeps, "writeFile", (path: string, content: string) => {
          if (path === "/tmp/lasso-global-after-test-uuid.txt") {
            return Promise.reject(new Error("write failed"));
          }
          return testFs.writeFile(path, content);
        });
        mockExecCalls([
          { stdout: "delta 0.18.2" },
          { stdout: "local diff\n" },
          { stdout: "delta 0.18.2" },
          { stdout: "applied diff\n" },
          { stdout: "delta 0.18.2" },
          { stdout: "context diff\n" },
          { stdout: "delta 0.18.2" },
          { stdout: "skills diff\n" },
          { stdout: "delta 0.18.2" },
          { stdout: "commands diff\n" },
        ]);
        const writes = mockStdoutWrites();

        const result = await resolveSlashCommand("/reload");
        assert.strictEqual(result, null);
        assert.strictEqual(
          testFs._files.has("/tmp/lasso-global-before-test-uuid.txt"),
          false,
        );
        assert.strictEqual(
          testFs._files.get("/tmp/lasso-test-uuid.txt"),
          `Local config from path: /test-cwd/.lasso/settings.yaml
local diff

Applied config:
applied diff

Agent context:
context diff

Agent skills:
skills diff

Custom slash commands:
commands diff

`,
        );
        assert.deepStrictEqual(writes(), [
          `${YELLOW}- Warning: using a default context window of 128,000 tokens because there is no \`contextWindowPerModel\` entry for the current model \`__MISSING__\`${RESET}\n`,
          `${BLUE}Reading context files: ${RESET}\n`,
          `${BLUE}Reading skills: ${RESET}\n`,
          `${BLUE}Reading slash commands: ${RESET}\n`,
          `${BLUE}Reading context files: ${RESET}`,
          `${GREEN}0.0ms${RESET}`,
          `${BLUE}Reading skills: ${RESET}`,
          `${GREEN}0.0ms${RESET}`,
          `${BLUE}Reading slash commands: ${RESET}`,
          `${GREEN}0.0ms${RESET}`,
          `${RED}Failed to write to a temp file. Error: write failed${RESET}\n`,
        ]);
      });

      it("warns on large prompt overhead when reload produces no diff", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            model: "gpt-4",
            baseURL: "https://api.example.com",
            contextWindowPerModel: { "gpt-4": 100_000 },
          }),
        );
        actions.setContextStr("s".repeat(210_000));
        mockExecCalls([
          { stdout: "delta 0.18.2" },
          { stdout: "" },
          { stdout: "delta 0.18.2" },
          { stdout: "" },
          { stdout: "delta 0.18.2" },
          { stdout: "" },
          { stdout: "delta 0.18.2" },
          { stdout: "" },
          { stdout: "delta 0.18.2" },
          { stdout: "" },
          { stdout: "delta 0.18.2" },
          { stdout: "" },
        ]);

        const result = await resolveSlashCommand("/reload");

        assert.strictEqual(result, null);
        const writes = getWrites();
        const noDiffIndex = writes.indexOf(
          `${PURPLE}No diff from reload${RESET}\n`,
        );
        assert(noDiffIndex !== -1);
        const warningWrite = writes[noDiffIndex + 1];
        assert(warningWrite !== undefined);
        assert.ok(
          warningWrite.startsWith(
            `${YELLOW}The current set of context, skills, and tools is 71.42% of the 100,000 token context window!`,
          ),
        );
      });

      it("warns when a reloaded config leaves little room for prompt overhead", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            model: "gpt-4",
            baseURL: "https://api.example.com",
            contextWindowPerModel: { "gpt-4": 100_000 },
          }),
        );
        actions.setContextStr("s".repeat(210_000));
        testProcessEnv._set("LASSO_PAGER", "cat __FILE__");
        mockPagerSpawn();
        mockExecCalls([
          { stdout: "delta 0.18.2" },
          { stdout: "global diff\n" },
          { stdout: "delta 0.18.2" },
          { stdout: "local diff\n" },
          { stdout: "delta 0.18.2" },
          { stdout: "applied diff\n" },
          { stdout: "delta 0.18.2" },
          { stdout: "context diff\n" },
          { stdout: "delta 0.18.2" },
          { stdout: "skills diff\n" },
          { stdout: "delta 0.18.2" },
          { stdout: "commands diff\n" },
        ]);
        const result = await resolveSlashCommand("/reload");
        assert.strictEqual(result, null);
        assert.strictEqual(
          testFs._files.get("/tmp/lasso-test-uuid.txt"),
          `Applied config:
applied diff

Global config from path: /fake-home/.config/lasso/settings.yaml
global diff

Local config from path: /test-cwd/.lasso/settings.yaml
local diff

Agent context:
context diff

Agent skills:
skills diff

Custom slash commands:
commands diff

`,
        );
        assert.ok(
          getWrites().some((w) =>
            w.includes(
              "The current set of context, skills, and tools is 71.42% of the 100,000 token context window!",
            ),
          ),
        );
      });

      it("cleans up reload temp files when a diff fails and temp files are missing", async () => {
        const err = new Error("fatal") as Error & { code: number };
        err.code = 128;
        mockExecCalls([{ stdout: "delta 0.18.2" }, { stdout: "", error: err }]);
        const result = await resolveSlashCommand("/reload");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), [
          `${YELLOW}- Warning: using a default context window of 128,000 tokens because there is no \`contextWindowPerModel\` entry for the current model \`__MISSING__\`${RESET}\n`,
          `${BLUE}Reading context files: ${RESET}\n`,
          `${BLUE}Reading skills: ${RESET}\n`,
          `${BLUE}Reading slash commands: ${RESET}\n`,
          `${BLUE}Reading context files: ${RESET}`,
          `${GREEN}0.0ms${RESET}`,
          `${BLUE}Reading skills: ${RESET}`,
          `${GREEN}0.0ms${RESET}`,
          `${BLUE}Reading slash commands: ${RESET}`,
          `${GREEN}0.0ms${RESET}`,
          `${RED}An error occurred when getting the diff: fatal${RESET}\n`,
        ]);
        assert.strictEqual(
          testFs._files.has("/tmp/lasso-global-before-test-uuid.txt"),
          false,
        );
      });

      it("only includes nonempty config diffs", async () => {
        testProcessEnv._set("LASSO_PAGER", "cat __FILE__");
        mockPagerSpawn();
        mockExecCalls([
          { stdout: "delta 0.18.2" },
          { stdout: "" },
          { stdout: "delta 0.18.2" },
          { stdout: "local diff\n" },
          { stdout: "delta 0.18.2" },
          { stdout: "" },
          { stdout: "delta 0.18.2" },
          { stdout: "" },
          { stdout: "delta 0.18.2" },
          { stdout: "" },
          { stdout: "delta 0.18.2" },
          { stdout: "" },
        ]);
        const result = await resolveSlashCommand("/reload");
        assert.strictEqual(result, null);
        assert.strictEqual(
          testFs._files.get("/tmp/lasso-test-uuid.txt"),
          `Local config from path: /test-cwd/.lasso/settings.yaml
local diff

`,
        );
      });

      it("snapshots config, context, and skills around reload", async () => {
        testFs._files.set(
          getGlobalConfigPath(),
          JSON.stringify({
            model: "gpt-4",
            baseURL: "https://api.example.com",
            customSlashCommandDirs: [],
            customSkillDirs: [],
          }),
        );
        testFs._dirs.add(getGlobalContextDir());
        testFs._files.set(`${getGlobalContextDir()}/AGENTS.md`, "hello");
        testFs._globResults.set("/fake-home/.config/lasso/skills/**/SKILL.md", [
          "/fake-home/.config/lasso/skills/my-skill/SKILL.md",
        ]);
        testFs._files.set(
          "/fake-home/.config/lasso/skills/my-skill/SKILL.md",
          `---
name: my-skill
description: A test skill
---
# Body`,
        );
        testFs._globResults.set("/test-cwd/.lasso/commands/**/*.md", [
          "/test-cwd/.lasso/commands/custom.md",
        ]);
        testFs._files.set(
          "/test-cwd/.lasso/commands/custom.md",
          "custom command content",
        );

        const snapshots = new Map<string, string>();
        mockExecCalls(
          [
            { stdout: "diff" },
            { stdout: "diff" },
            { stdout: "diff" },
            { stdout: "diff" },
            { stdout: "diff" },
            { stdout: "diff" },
          ],
          undefined,
          (cmd) => {
            for (const prefix of [
              "global",
              "local",
              "applied",
              "context",
              "skills",
              "commands",
            ]) {
              if (cmd.includes(`lasso-${prefix}-after`)) {
                snapshots.set(
                  prefix,
                  testFs._files.get(
                    `/tmp/lasso-${prefix}-after-test-uuid.txt`,
                  ) ?? "",
                );
              }
            }
          },
        );

        testProcessEnv._set("LASSO_PAGER", "cat __FILE__");

        const getSnapshot = (name: string) => {
          const snapshot = snapshots.get(name);
          assert(snapshot !== undefined);
          return snapshot;
        };

        const result = await resolveSlashCommand("/reload");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(
          [...snapshots.keys()],
          ["global", "local", "applied", "context"],
        );
        assert.strictEqual(
          getSnapshot("applied"),
          `\`\`\`json
${JSON.stringify(getState().config, null, 2)}
\`\`\``,
        );
        assert.strictEqual(
          getSnapshot("context"),
          `# [lasso] AGENTS.md context files

## Path: /fake-home/.config/lasso/context/AGENTS.md

hello
`,
        );
        assert.strictEqual(
          getSnapshot("global"),
          `\`\`\`yaml
{"model":"gpt-4","baseURL":"https://api.example.com","customSlashCommandDirs":[],"customSkillDirs":[]}
\`\`\``,
        );
        assert.strictEqual(getSnapshot("local"), "```yaml\n{}\n```");
      });
    });

    describe("custom and unknown commands", () => {
      it("handles custom slash command successfully", async () => {
        actions.setSlashCommands([
          {
            name: "custom",
            filePath: "/test-cwd/.lasso/commands/custom.md",
            content: "custom command content",
          },
        ]);
        const result = await resolveSlashCommand("/custom");
        assert.strictEqual(result, "custom command content");
        assert.deepStrictEqual(getWrites(), [
          `${GREY}Executing custom slash command: custom${RESET}\n`,
        ]);
      });

      it("appends context after custom slash command content", async () => {
        actions.setSlashCommands([
          {
            name: "custom",
            filePath: "/test-cwd/.lasso/commands/custom.md",
            content: "custom command content",
          },
        ]);
        const result = await resolveSlashCommand("/custom some task");
        assert.strictEqual(
          result,
          `# [lasso] Follow the instructions below along with the provided context:

## [lasso] Context
some task

## [lasso] Instructions
custom command content`,
        );
      });

      it("trims leading whitespace and preserves internal spacing in custom slash command context", async () => {
        actions.setSlashCommands([
          {
            name: "custom",
            filePath: "/test-cwd/.lasso/commands/custom.md",
            content: "custom command content",
          },
        ]);
        const result = await resolveSlashCommand("/custom   some   task");
        assert.strictEqual(
          result,
          `# [lasso] Follow the instructions below along with the provided context:

## [lasso] Context
some   task

## [lasso] Instructions
custom command content`,
        );
      });

      it("matches custom command with only trailing whitespace", async () => {
        actions.setSlashCommands([
          {
            name: "custom",
            filePath: "/test-cwd/.lasso/commands/custom.md",
            content: "custom command content",
          },
        ]);
        const result = await resolveSlashCommand("/custom   ");
        assert.strictEqual(result, "custom command content");
      });

      it("handles unknown slash command", async () => {
        const { spawned } = mockPagerSpawn();
        testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
        actions.setSlashCommands([
          {
            name: "known",
            filePath: "/test-cwd/.lasso/commands/known.md",
            content: "known content",
          },
        ]);
        actions.resetStdout();
        const result = await resolveSlashCommand("/unknown");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), []);
        assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
        assert.strictEqual(
          testFs._files.get("/tmp/lasso-test-uuid.txt"),
          `# Invalid command: \`/unknown\`

## Available commands

- /edit
- /editpage
- /history
- /clear
- /paste
- /skills
- /context
- /commands
- /keymaps
- /usage
- /tokens
- /resume
- /config
- /reload
- /initlocal
- /initglobal
- /lastresponse
- /lastmessage
- /lastdiff
- /summaries
- /tools
- /record
- /mcps
- /steer
- /test-cwd/.lasso/commands/known.md _(4 tokens)_

`,
        );
      });
    });
  });

  describe("recordAndTranscribeInput", () => {
    beforeEach(() => {
      actions.setRl(makeFakeRl({ line: "" }));
    });

    it("returns the result and sets the record process abort controller", async () => {
      actions.setTranscriptionSdkProvider("openai");
      actions.setTranscriptionModel("gpt-4o-transcribe");
      testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "key");
      mockRecording({ chunk: "wav pcm bytes" });
      const { transcribeCalls } = mockTranscription("hello from the mic");
      let questionSawController = false;
      actions.setRl(
        makeFakeRl({
          question: () => {
            questionSawController =
              getState().abortControllers.recordProcess !== null;
            return Promise.resolve("");
          },
        }),
      );
      actions.resetStdout();
      const result = await recordAndTranscribeInput();
      assert.strictEqual(
        result,
        "[Message transcribed; may contain errors] hello from the mic",
      );
      assert.strictEqual(questionSawController, true);
      assert.strictEqual(getState().abortControllers.recordProcess, null);
      assert.ok(transcribeCalls[0] !== undefined);
      assert.deepStrictEqual(
        transcribeCalls[0].audio,
        Buffer.from("wav pcm bytes"),
      );
      assert.deepStrictEqual(getWrites(), [
        `${RED}⏺${RESET} Press enter to stop recording \n`,
        `${BLUE}Transcribed: ${RESET}`,
        "hello from the mic\n",
      ]);
    });

    it("removes the wav temp file after a successful transcription", async () => {
      actions.setTranscriptionSdkProvider("openai");
      actions.setTranscriptionModel("gpt-4o-transcribe");
      testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "key");
      mockRecording();
      mockTranscription("hello from the mic");
      testFs._files.set("/tmp/lasso-test-uuid.wav", "wav recording bytes");
      const result = await recordAndTranscribeInput();
      assert.strictEqual(
        result,
        "[Message transcribed; may contain errors] hello from the mic",
      );
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.wav"), false);
    });

    it("returns null and prints a warning without transcription configuration", async () => {
      actions.resetStdout();
      const result = await recordAndTranscribeInput();
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}Warning! You're missing required configuration options for /record.
- Set the \`LASSO_TRANSCRIPTION_API_KEY\` environment variable, e.g. \`export LASSO_TRANSCRIPTION_API_KEY=...\`
- Set \`transcriptionSdkProvider\` in your config file (\`openai\` or \`google\`)
- Set \`transcriptionModel\` in your config file${RESET}
`,
      ]);
      assert.strictEqual(getState().abortControllers.recordProcess, null);
    });

    it("prints the configuration warning while stdout is muted", async () => {
      actions.resetStdout();
      actions.setIsNonBlockingProcessOngoing(true);
      const result = await recordAndTranscribeInput();
      actions.setIsNonBlockingProcessOngoing(false);
      assert.strictEqual(result, null);
      assert.deepStrictEqual(
        getState().terminal.bufferedStdoutWhileEditorOpen,
        "",
      );
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.wav"), false);
    });

    it("returns null and prints an error when the recording process emits an error", async () => {
      actions.setTranscriptionSdkProvider("openai");
      actions.setTranscriptionModel("gpt-4o-transcribe");
      testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "key");
      const { child } = mockRecording();
      const { transcribeCalls } = mockTranscription("hello from the mic");
      actions.setRl(
        makeFakeRl({
          question: () => {
            child.emit("error", new Error("spawn sox ENOENT"));
            return Promise.resolve("");
          },
        }),
      );
      actions.resetStdout();
      const result = await recordAndTranscribeInput();
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}⏺${RESET} Press enter to stop recording \n`,
        `${RED}Recording failed: spawn sox ENOENT${RESET}\n`,
      ]);
      assert.strictEqual(transcribeCalls.length, 0);
      assert.strictEqual(getState().abortControllers.recordProcess, null);
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.wav"), false);
    });

    it("returns null without prompting when the recording process fails to spawn", async () => {
      actions.setTranscriptionSdkProvider("openai");
      actions.setTranscriptionModel("gpt-4o-transcribe");
      testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "key");
      mockRecording({ spawnError: new Error("spawn sox ENOENT") });
      const { transcribeCalls } = mockTranscription("hello from the mic");
      let questionCalls = 0;
      actions.setRl(
        makeFakeRl({
          question: () => {
            questionCalls += 1;
            return Promise.resolve("");
          },
        }),
      );
      actions.resetStdout();
      const result = await recordAndTranscribeInput();
      assert.strictEqual(result, null);
      assert.strictEqual(questionCalls, 0);
      assert.deepStrictEqual(getWrites(), [
        `${RED}Recording failed: spawn sox ENOENT${RESET}\n`,
      ]);
      assert.strictEqual(transcribeCalls.length, 0);
      assert.strictEqual(getState().abortControllers.recordProcess, null);
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.wav"), false);
    });

    it("returns null and prints an error when the stop-recording question rejects", async () => {
      actions.setTranscriptionSdkProvider("openai");
      actions.setTranscriptionModel("gpt-4o-transcribe");
      testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "key");
      mockRecording();
      mockTranscription("hello from the mic");
      actions.setRl(
        makeFakeRl({
          question: () => Promise.reject(new Error("boom")),
        }),
      );
      actions.resetStdout();
      const result = await recordAndTranscribeInput();
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}⏺${RESET} Press enter to stop recording \n`,
        `${RED}Error while prompting the user to stop recording: boom${RESET}\n`,
      ]);
      assert.strictEqual(getState().abortControllers.recordProcess, null);
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.wav"), false);
    });

    it("returns null without an error when the stop-recording question is aborted", async () => {
      actions.setTranscriptionSdkProvider("openai");
      actions.setTranscriptionModel("gpt-4o-transcribe");
      testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "key");
      mockRecording();
      mockTranscription("hello from the mic");
      actions.setRl(
        makeFakeRl({
          question: () => Promise.reject(makeAbortError("aborted")),
        }),
      );
      actions.resetStdout();
      const result = await recordAndTranscribeInput();
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}⏺${RESET} Press enter to stop recording \n`,
        `${YELLOW}Cancelled${RESET}\n`,
      ]);
      assert.strictEqual(getState().abortControllers.recordProcess, null);
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.wav"), false);
    });

    it("returns null and prints an error when reading the recorded temp file fails", async () => {
      actions.setTranscriptionSdkProvider("openai");
      actions.setTranscriptionModel("gpt-4o-transcribe");
      testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "key");
      mockRecording();
      const { transcribeCalls } = mockTranscription("hello from the mic");
      mock.method(fsDeps, "readFile", () =>
        Promise.reject(makeErrnoError("ENOENT", "ENOENT: no such file")),
      );
      actions.resetStdout();
      const result = await recordAndTranscribeInput();
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}⏺${RESET} Press enter to stop recording \n`,
        `${RED}Error while reading the temp file that was recorded to: ENOENT: no such file${RESET}\n`,
      ]);
      assert.strictEqual(getState().abortControllers.recordProcess, null);
      assert.strictEqual(transcribeCalls.length, 0);
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.wav"), false);
    });

    it("writes the banner directly when stdout is muted", async () => {
      actions.setTranscriptionSdkProvider("openai");
      actions.setTranscriptionModel("gpt-4o-transcribe");
      testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "key");
      mockRecording();
      actions.setIsNonBlockingProcessOngoing(true);
      actions.setRl(
        makeFakeRl({
          question: () => Promise.reject(makeAbortError("aborted")),
        }),
      );
      actions.resetStdout();
      const result = await recordAndTranscribeInput();
      actions.setIsNonBlockingProcessOngoing(false);
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}⏺${RESET} Press enter to stop recording \n`,
      ]);
      assert.strictEqual(
        getState().terminal.bufferedStdoutWhileEditorOpen,
        `${YELLOW}Cancelled${RESET}\n`,
      );
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.wav"), false);
    });

    it("returns null and prints an error when transcription fails", async () => {
      actions.setTranscriptionSdkProvider("openai");
      actions.setTranscriptionModel("gpt-4o-transcribe");
      testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "key");
      mockRecording();
      testFs._files.set("/tmp/lasso-test-uuid.wav", "wav recording bytes");
      mock.method(aiDeps, "transcribe", () =>
        Promise.reject(new Error("bad audio")),
      );
      actions.resetStdout();
      const result = await recordAndTranscribeInput();
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}⏺${RESET} Press enter to stop recording \n`,
        `${RED}Error while transcribing: bad audio${RESET}\n`,
      ]);
      assert.strictEqual(getState().abortControllers.recordProcess, null);
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.wav"), false);
    });

    it("returns null and prints an error when the transcription is empty", async () => {
      actions.setTranscriptionSdkProvider("openai");
      actions.setTranscriptionModel("gpt-4o-transcribe");
      testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "key");
      mockRecording();
      mockTranscription("");
      actions.resetStdout();
      const result = await recordAndTranscribeInput();
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}⏺${RESET} Press enter to stop recording \n`,
        `${RED}Empty transcription result${RESET}\n`,
      ]);
    });

    it("aborts the transcription when the transcription is aborted", async () => {
      actions.setTranscriptionSdkProvider("openai");
      actions.setTranscriptionModel("gpt-4o-transcribe");
      testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "key");
      mockRecording();
      testFs._files.set("/tmp/lasso-test-uuid.wav", "wav recording bytes");
      let transcribeSignal: AbortSignal | undefined;
      mock.method(
        aiDeps,
        "transcribe",
        (args: { abortSignal?: AbortSignal }) => {
          transcribeSignal = args.abortSignal;
          return new Promise((_, reject) => {
            args.abortSignal?.addEventListener("abort", () =>
              reject(makeAbortError("aborted")),
            );
          });
        },
      );
      actions.resetStdout();
      const resultPromise = recordAndTranscribeInput();
      while (getState().abortControllers.transcription === null) {
        await sleep(10);
      }
      const controller = getState().abortControllers.transcription;
      assert(controller !== null);
      controller.abort();
      const result = await resultPromise;
      assert.strictEqual(result, null);
      assert.strictEqual(transcribeSignal?.aborted, true);
      assert.strictEqual(getState().abortControllers.transcription, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}⏺${RESET} Press enter to stop recording \n`,
      ]);
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.wav"), false);
    });

    it("shows the transcription error directly when stdout is muted and not typed", async () => {
      actions.setTranscriptionSdkProvider("openai");
      actions.setTranscriptionModel("gpt-4o-transcribe");
      testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "key");
      mockRecording();
      testFs._files.set("/tmp/lasso-test-uuid.wav", "wav recording bytes");
      mock.method(aiDeps, "transcribe", () =>
        Promise.reject(new Error("bad audio")),
      );
      actions.setIsNonBlockingProcessOngoing(true);
      actions.resetStdout();
      const result = await recordAndTranscribeInput();
      actions.setIsNonBlockingProcessOngoing(false);
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}⏺${RESET} Press enter to stop recording \n`,
        `${RED}Error while transcribing: bad audio${RESET}\n`,
      ]);
      assert.deepStrictEqual(
        getState().terminal.bufferedStdoutWhileEditorOpen,
        "",
      );
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.wav"), false);
    });

    it("buffers the transcription error when stdout is muted and typed", async () => {
      actions.setTranscriptionSdkProvider("openai");
      actions.setTranscriptionModel("gpt-4o-transcribe");
      testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "key");
      mockRecording();
      testFs._files.set("/tmp/lasso-test-uuid.wav", "wav recording bytes");
      mock.method(aiDeps, "transcribe", () =>
        Promise.reject(new Error("bad audio")),
      );
      actions.setIsNonBlockingProcessOngoing(true);
      actions.resetStdout();
      const result = await recordAndTranscribeInput({ isTyped: true });
      actions.setIsNonBlockingProcessOngoing(false);
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), []);
      assert.deepStrictEqual(
        getState().terminal.bufferedStdoutWhileEditorOpen,
        `${RED}Error while transcribing: bad audio${RESET}\n`,
      );
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.wav"), false);
    });
  });

  describe("mutedStdout", () => {
    it("passes output through normally", () => {
      mutedStdout.write("echo chars");
      assert.deepStrictEqual(getWrites(), [Buffer.from("echo chars")]);
    });

    it("drops output while a non-blocking process is ongoing", () => {
      actions.setIsNonBlockingProcessOngoing(true);
      actions.resetStdout();
      mutedStdout.write("echo chars");
      assert.deepStrictEqual(getWrites(), []);
    });
  });

  describe("shouldMuteStdout", () => {
    it("is false initially", () => {
      assert.strictEqual(shouldMuteStdout(), false);
    });

    it("is true while the loading state spinner is active", () => {
      actions.setLoadingStateTimeout({} as NodeJS.Timeout);
      assert.strictEqual(shouldMuteStdout(), true);
    });
    it("is true while the loading state spinner is active", () => {
      actions.setLoadingStateTimeout({} as NodeJS.Timeout);
      assert.strictEqual(shouldMuteStdout(), true);
    });
    it("is true while the loading state spinner is active", () => {
      actions.setLoadingStateTimeout({} as NodeJS.Timeout);
      assert.strictEqual(shouldMuteStdout(), true);
    });
    it("is true while the loading state spinner is active", () => {
      actions.setLoadingStateTimeout({} as NodeJS.Timeout);
      assert.strictEqual(shouldMuteStdout(), true);
    });
    it("is true while the loading state spinner is active", () => {
      actions.setLoadingStateTimeout({} as NodeJS.Timeout);
      assert.strictEqual(shouldMuteStdout(), true);
    });
    it("is true while the loading state spinner is active", () => {
      actions.setLoadingStateTimeout({} as NodeJS.Timeout);
      assert.strictEqual(shouldMuteStdout(), true);
    });
    it("is true while the loading state spinner is active", () => {
      actions.setLoadingStateTimeout({} as NodeJS.Timeout);
      assert.strictEqual(shouldMuteStdout(), true);
    });
    it("is true while a non-blocking process is ongoing", () => {
      actions.setIsNonBlockingProcessOngoing(true);
      assert.strictEqual(shouldMuteStdout(), true);
    });
  });

  describe("recordInput", () => {
    it("spawns sox with the wav mono 16-bit output config writing to the temp file", () => {
      actions.setRecordProcessAbortController(new AbortController());
      const { spawnCalls } = mockRecording();
      recordInput("/tmp/lasso-test-uuid.wav");
      assert.strictEqual(spawnCalls.length, 1);
      assert.ok(spawnCalls[0] !== undefined);
      assert.strictEqual(spawnCalls[0].file, "sox");
      assert.deepStrictEqual(spawnCalls[0].args, [
        "-d",
        "-t",
        "wav",
        "-r",
        "16000",
        "-c",
        "1",
        "-b",
        "16",
        "/tmp/lasso-test-uuid.wav",
      ]);
      assert.deepStrictEqual(spawnCalls[0].options, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    });

    it("resolves recordingFinished with the close args on stop", async () => {
      actions.setRecordProcessAbortController(new AbortController());
      const { killSignals } = mockRecording();
      const { stop, recordingFinished } = recordInput(
        "/tmp/lasso-test-uuid.wav",
      );
      stop();
      assert.deepStrictEqual(killSignals, ["SIGINT"]);
      const closeArgs = await recordingFinished;
      assert.deepStrictEqual(closeArgs, [0, "SIGINT"]);
    });

    it("kills the recording process when the record process is aborted", () => {
      const controller = new AbortController();
      actions.setRecordProcessAbortController(controller);
      const { killSignals } = mockRecording();
      recordInput("/tmp/lasso-test-uuid.wav");
      controller.abort();
      assert.deepStrictEqual(killSignals, ["SIGINT"]);
    });

    it("resolves recordingReady when the recording process spawns", async () => {
      actions.setRecordProcessAbortController(new AbortController());
      mockRecording();
      const { recordingReady } = recordInput("/tmp/lasso-test-uuid.wav");
      assert.deepStrictEqual(await recordingReady, []);
    });

    it("rejects recordingReady when the recording process fails to spawn", async () => {
      actions.setRecordProcessAbortController(new AbortController());
      mockRecording({ spawnError: new Error("spawn sox ENOENT") });
      const { recordingReady } = recordInput("/tmp/lasso-test-uuid.wav");
      await assert.rejects(recordingReady, { message: "spawn sox ENOENT" });
    });
  });

  describe("transcribeInput", () => {
    it("sends the audio to the transcription model and returns the text", async () => {
      actions.setTranscriptionSdkProvider("openai");
      actions.setTranscriptionModel("gpt-4o-transcribe");
      testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "key");
      const controller = new AbortController();
      actions.setTranscriptionAbortController(controller);
      const audio = Buffer.from("recording");
      const { transcribeCalls } = mockTranscription("hi");
      const result = await transcribeInput(audio);
      assert.strictEqual(result, "hi");
      assert.ok(transcribeCalls[0] !== undefined);
      assert.strictEqual(transcribeCalls[0].audio, audio);
      assert.strictEqual(transcribeCalls[0].abortSignal, controller.signal);
      assert.ok(transcribeCalls[0].model !== undefined);
      actions.setTranscriptionAbortController(null);
    });
  });
});

describe("getStrFromAssistantContent", () => {
  it("returns string content unchanged", () => {
    assert.equal(getStrFromAssistantContent("response"), "response");
  });

  it("joins text content and excludes non-text content", () => {
    assert.equal(
      getStrFromAssistantContent([
        { type: "text", text: "first" },
        { type: "reasoning", text: "hidden reasoning" },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "tool",
          input: {},
        },
        { type: "text", text: "second" },
      ]),
      "first\n\n\nsecond",
    );
  });

  it("retuns empty strings for unrecognised content types at runtime", () => {
    assert.equal(getStrFromAssistantContent([{ type: "wat" } as never]), "");
  });

  it("excludes tool-result and tool-approval-request content", () => {
    assert.equal(
      getStrFromAssistantContent([
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "tool",
          output: { type: "text", value: "result" },
        },
        {
          type: "tool-approval-request",
          toolCallId: "call-2",
          approvalId: "approval-1",
        },
        { type: "text", text: "after tools" },
      ]),
      "\n\nafter tools",
    );
  });
});
