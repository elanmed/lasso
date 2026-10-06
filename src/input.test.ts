import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import os from "node:os";
import { stdin } from "node:process";
import { actions, getState, promptDeps } from "./state.ts";
import { print } from "./print.ts";

import { sleep, strToApproxTokens } from "./utils.ts";
import {
  parseInputFromEditor,
  shouldMuteStdout,
  mutedStdout,
  recordAndTranscribeInput,
  resolveSlashCommand,
  resolveUserInput,
  shouldResolveSlashCommand,
  getModel,
  setModelCommand,
  clearCommand,
  printTokens,
  pageSkills,
  pageAvailableContextFiles,
  pageCommands,
  pageEditStr,
  spawnAndReadEditorContent,
  resume,
  resumeWithNoArgs,
  initStdin,
  initSigInt,
  recordInput,
  transcribeInput,
  initLocalConfig,
  initGlobalConfig,
  pageSummaries,
  pageTools,
  pageHistory,
  pageLastMessage,
  pageLastResponse,
  resolveInterruptWithEditor,
  pageLastDiff,
  printKeymaps,
} from "./input.ts";
import {
  addSessionFile,
  testFs,
  testProcessEnv,
  setupTestContext,
  setupKeypressTests,
  makeFakeRl,
  makeFakeRlWithWrites,
  mockClipboardPaste,
  mockClipboardPasteFailure,
  mockExecCalls,
  mockEditorSpawn,
  mockSetInterval,
  mockClearInterval,
  mockSpawnSync,
  mockPagerSpawn,
  mockRecording,
  mockTranscription,
  makeFakeMcpClient,
  makeMcpTool,
  batPagerCmd,
  stripAnsi,
  mockStdoutWrites,
  BLUE,
  BOLD,
  BOLD_RESET,
  GREEN,
  GREY,
  PURPLE,
  RED,
  RESET,
  YELLOW,
  makeAbortError,
  makeErrnoError,
  mockProcessExit,
} from "./test-helpers.ts";
import { aiDeps, fsDeps } from "./deps.ts";
import { getGlobalConfigPath, getGlobalContextDir } from "./paths.ts";
import { defaultConfig, type Key } from "./config-types.ts";

function getTestRl() {
  const rl = getState().app.rl;
  assert(rl !== null);
  return rl;
}

async function resolveInterruptWithAnswer(answer: string) {
  actions.setEditorInputValue("queued input");
  actions.setRl(makeFakeRl({ question: () => Promise.resolve(answer) }));
  await resolveInterruptWithEditor();
}

describe("input", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  let getWrites: () => string[];

  beforeEach(() => {
    setupTestContext();
    getWrites = mockStdoutWrites();
  });

  describe("resolveInterruptWithEditor", () => {
    it("waits for enter and clears the interrupt controller", async () => {
      const prompts: string[] = [];
      let questionOptions: { signal: AbortSignal } | undefined;
      actions.setKeymaps({
        ...defaultConfig.keymaps,
        edit: { name: "e", ctrl: true },
      });
      actions.setRl(
        makeFakeRl({
          question: (prompt: string, options: { signal: AbortSignal }) => {
            prompts.push(prompt);
            questionOptions = options;
            return Promise.resolve("");
          },
        }),
      );

      await resolveInterruptWithEditor();

      assert(questionOptions !== undefined);
      assert.equal(questionOptions.signal.aborted, false);
      assert.equal(
        getState().abortControllers.interruptWithEditorContent,
        null,
      );
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}You have queued messages!${RESET}\n`,
      ]);
      assert.deepStrictEqual(prompts, [
        'Edit ({"name":"e","ctrl":true}), c(lear), or <CR> to continue: ',
      ]);
    });

    it("clears queued editor input when c is entered", async () => {
      await resolveInterruptWithAnswer("c");
      assert.strictEqual(getState().app.editorInputValue, null);
    });

    it("clears queued editor input when clear is entered", async () => {
      await resolveInterruptWithAnswer("clear");
      assert.strictEqual(getState().app.editorInputValue, null);
    });

    it("keeps queued editor input when the answer is not c or clear", async () => {
      await resolveInterruptWithAnswer("e");
      assert.strictEqual(getState().app.editorInputValue, "queued input");
    });

    it("returns normally when interrupted", async () => {
      actions.setRl(
        makeFakeRl({
          question: () => {
            const error = makeAbortError("interrupted");
            return Promise.reject(error);
          },
        }),
      );

      await resolveInterruptWithEditor();

      assert.equal(
        getState().abortControllers.interruptWithEditorContent,
        null,
      );
    });
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
      assert.equal(getState().app.bufferedInputWhileInitializing, "a ");
    });

    it("ignores keypresses when not initializing", () => {
      emitKey("a", { name: "a" });
      assert.equal(getState().app.bufferedInputWhileInitializing, "");
    });

    it("ignores return and enter keys", () => {
      actions.setIsInitializing(true);
      actions.appendBufferedInputWhileInitializing("ab");
      emitKey("\r", { name: "return" });
      emitKey("\n", { name: "enter" });
      assert.equal(getState().app.bufferedInputWhileInitializing, "ab");
    });

    it("ignores keys without characters like arrow keys", () => {
      actions.setIsInitializing(true);
      actions.appendBufferedInputWhileInitializing("ab");
      emitKey(undefined, { name: "left" });
      assert.equal(getState().app.bufferedInputWhileInitializing, "ab");
    });

    it("ignores ctrl and meta keys", () => {
      actions.setIsInitializing(true);
      actions.appendBufferedInputWhileInitializing("ab");
      emitKey("h", { name: "h", ctrl: true });
      emitKey("f", { name: "f", meta: true });
      assert.equal(getState().app.bufferedInputWhileInitializing, "ab");
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

  describe("restores buffered initialization input", () => {
    it("writes buffered input into rl right after the question starts", () => {
      mockStdoutWrites();
      const { rl, writes } = makeFakeRlWithWrites({
        question: () => new Promise(() => undefined),
      });
      actions.setRl(rl);
      actions.appendBufferedInputWhileInitializing("ab");
      void resolveUserInput({ isFirstInput: true });
      assert.deepStrictEqual(
        writes.map((write) => write.chunk),
        ["ab"],
      );
      assert.equal(getState().app.bufferedInputWhileInitializing, "");
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
          `${RED}Failed to create a temp file${RESET}\n`,
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
        assert.strictEqual(getState().app.editorInputValue, null);
      });

      it("returns null without state changes when the editor result is whitespace only and there was no prefill", async () => {
        mockEditorSpawn(() => {
          testFs.writeFile("/tmp/lasso-test-uuid.txt", "   ");
        });
        const result = await spawnAndReadEditorContent();
        assert.strictEqual(result, null);
        assert.strictEqual(getState().app.editorInputValue, null);
      });

      it("returns normalized content", async () => {
        mockEditorSpawn(() => {
          testFs.writeFile("/tmp/lasso-test-uuid.txt", "  hello  ");
        });
        const result = await spawnAndReadEditorContent();
        assert.strictEqual(result, "  hello\n");
        assert.strictEqual(getState().app.editorInputValue, "  hello  ");
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
        assert.strictEqual(spawned[0], "vim /tmp/lasso-test-uuid.txt");
      });

      it("uses EDITOR env var with __FILE__ when LASSO_EDIT is not set", async () => {
        testProcessEnv._set("EDITOR", "nano __FILE__");
        await spawnAndReadEditorContent();
        assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      });

      it("falls back to vi when no editor env vars are set", async () => {
        await spawnAndReadEditorContent();
        assert.strictEqual(spawned[0], "vi /tmp/lasso-test-uuid.txt");
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

  describe("resolveUserInput", () => {
    beforeEach(() => {
      actions.resetStdout();
      actions.setRl(makeFakeRl());
    });

    describe("editor input", () => {
      it("returns editor input value when set and clears it", async () => {
        actions.setEditorInputValue("editor content");
        const result = await resolveUserInput({ isFirstInput: false });
        assert.strictEqual(result, "editor content");
        assert.strictEqual(getState().app.editorInputValue, null);
        assert.deepStrictEqual(getState().app.transcript, [
          { timestamp: 0, role: "user", message: "editor content" },
        ]);
      });

      it("resolves slash commands from editor input", async () => {
        actions.setModel("old");
        actions.setEditorInputValue("/model new-model");
        const result = await resolveUserInput({ isFirstInput: false });
        assert.strictEqual(result, null);
        assert.strictEqual(getState().config.model, "new-model");
        assert.strictEqual(getState().app.editorInputValue, null);
        assert.deepStrictEqual(getState().app.transcript, [
          { timestamp: 0, role: "user", message: "/model new-model" },
        ]);
      });

      it("returns the first queued editor message and keeps the rest for the next iteration", async () => {
        actions.setEditorInputValue("first\nl---\nsecond\n");
        const result = await resolveUserInput({ isFirstInput: false });
        assert.strictEqual(result, "first\n");
        assert.strictEqual(getState().app.editorInputValue, "second\n");
        assert.deepStrictEqual(getState().app.transcript, [
          { timestamp: 0, role: "user", message: "first\n" },
        ]);
      });

      it("drains queued editor messages across iterations", async () => {
        actions.setEditorInputValue(`first
l---
second
`);
        assert.strictEqual(
          await resolveUserInput({ isFirstInput: false }),
          "first\n",
        );
        assert.strictEqual(
          await resolveUserInput({ isFirstInput: false }),
          "second\n",
        );
        assert.strictEqual(getState().app.editorInputValue, null);
      });
    });

    describe("resolves user input", () => {
      it("returns trimmed user input", async () => {
        mock.method(getTestRl(), "question", () =>
          Promise.resolve("  hello  "),
        );
        const result = await resolveUserInput({ isFirstInput: false });
        assert.strictEqual(result, "hello");
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${YELLOW}━━ ${BOLD}Input${BOLD_RESET} ━━${RESET}\n`,
        ]);
        assert.deepStrictEqual(getState().app.transcript, [
          { timestamp: 0, role: "user", message: "  hello  " },
        ]);
      });

      it("resolves slash commands when input starts with /", async () => {
        actions.setModel("old");
        actions.resetStdout();
        mock.method(getTestRl(), "question", () =>
          Promise.resolve("/model new-model"),
        );
        const result = await resolveUserInput({ isFirstInput: false });
        assert.strictEqual(result, null);
        assert.strictEqual(getState().config.model, "new-model");
        assert.deepStrictEqual(getState().app.transcript, [
          { timestamp: 0, role: "user", message: "/model new-model" },
        ]);
      });
    });

    describe("handles errors and aborts", () => {
      it("returns null and prints error on non-abort error", async () => {
        mock.method(getTestRl(), "question", () =>
          Promise.reject(new Error("read failed")),
        );
        const result = await resolveUserInput({ isFirstInput: false });
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${YELLOW}━━ ${BOLD}Input${BOLD_RESET} ━━${RESET}\n`,
          `${RED}read failed${RESET}\n`,
        ]);
      });

      it("returns editor value when aborted by editor", async () => {
        mock.method(getTestRl(), "question", () => {
          actions.setEditorInputValue("from editor");
          const err = makeAbortError("This operation was aborted");
          return Promise.reject(err);
        });
        const result = await resolveUserInput({ isFirstInput: false });
        assert.strictEqual(result, "from editor");
        assert.strictEqual(getState().app.editorInputValue, null);
        assert.deepStrictEqual(getState().app.transcript, [
          { timestamp: 0, role: "user", message: "from editor" },
        ]);
      });
    });

    describe("exiting", () => {
      it("exits on abort during exit confirmation", async () => {
        mockProcessExit();
        const questionMock = mock.method(getTestRl(), "question", () => {
          const err = makeAbortError("This operation was aborted");
          return Promise.reject(err);
        });
        await assert.rejects(
          resolveUserInput({ isFirstInput: false }),
          /process.exit called/,
        );
        assert.strictEqual(questionMock.mock.callCount(), 2);
      });

      it("returns null when user declines exit confirmation", async () => {
        const err = makeAbortError("This operation was aborted");
        const questionMock = mock.method(getTestRl(), "question", () =>
          Promise.resolve("n"),
        );
        questionMock.mock.mockImplementationOnce(() => Promise.reject(err));
        const result = await resolveUserInput({ isFirstInput: false });
        assert.strictEqual(result, null);
        assert.strictEqual(questionMock.mock.callCount(), 2);
      });

      it("exits when user confirms exit confirmation", async () => {
        mockProcessExit();
        const err = makeAbortError("This operation was aborted");
        const questionMock = mock.method(getTestRl(), "question", () =>
          Promise.resolve("yes"),
        );
        questionMock.mock.mockImplementationOnce(() => Promise.reject(err));
        await assert.rejects(
          resolveUserInput({ isFirstInput: false }),
          /process.exit called/,
        );
        assert.strictEqual(questionMock.mock.callCount(), 2);
      });

      it("prints session start date when exiting", async () => {
        mock.restoreAll();
        setupTestContext({ now: 42_000 });
        getWrites = mockStdoutWrites();
        mockProcessExit();
        actions.setRl(makeFakeRl());
        actions.resetStdout();
        const err = makeAbortError("This operation was aborted");
        const questionMock = mock.method(getTestRl(), "question", () =>
          Promise.resolve("yes"),
        );
        questionMock.mock.mockImplementationOnce(() => Promise.reject(err));
        await assert.rejects(
          resolveUserInput({ isFirstInput: false }),
          /process.exit called/,
        );
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${YELLOW}━━ ${BOLD}Input${BOLD_RESET} ━━${RESET}\n`,
          `${PURPLE}Resume this session with /resume 42000${RESET}\n`,
        ]);
      });

      it("exits on ctrl-d when readline closes", async () => {
        mock.restoreAll();
        setupTestContext({ now: 42_000 });
        getWrites = mockStdoutWrites();
        mockProcessExit();
        actions.setRl(makeFakeRl());
        actions.resetStdout();
        const questionMock = mock.method(getTestRl(), "question", () =>
          Promise.reject(
            makeErrnoError("ERR_USE_AFTER_CLOSE", "readline was closed"),
          ),
        );
        questionMock.mock.mockImplementationOnce(() =>
          Promise.reject(makeAbortError("Aborted with Ctrl+D")),
        );

        await assert.rejects(
          resolveUserInput({ isFirstInput: false }),
          /process.exit called/,
        );

        assert.strictEqual(questionMock.mock.callCount(), 2);
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${YELLOW}━━ ${BOLD}Input${BOLD_RESET} ━━${RESET}\n`,
          `${PURPLE}Resume this session with /resume 42000${RESET}\n`,
        ]);
      });

      it("exits when the prompt fails after readline closed", async () => {
        mock.restoreAll();
        setupTestContext({ now: 42_000 });
        getWrites = mockStdoutWrites();
        mockProcessExit();
        actions.setRl(makeFakeRl());
        actions.resetStdout();
        const questionMock = mock.method(getTestRl(), "question", () =>
          Promise.reject(
            makeErrnoError("ERR_USE_AFTER_CLOSE", "readline was closed"),
          ),
        );

        await assert.rejects(
          resolveUserInput({ isFirstInput: false }),
          /process.exit called/,
        );

        assert.strictEqual(questionMock.mock.callCount(), 1);
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${YELLOW}━━ ${BOLD}Input${BOLD_RESET} ━━${RESET}\n`,
          `${PURPLE}Resume this session with /resume 42000${RESET}\n`,
        ]);
      });
    });
  });

  describe("parseInputFromEditor", () => {
    describe("splits on the delimiter", () => {
      it("returns the whole editor value and clears it when no delimiter is present", async () => {
        actions.setEditorInputValue("editor content");
        const result = await parseInputFromEditor();
        assert.strictEqual(result, "editor content");
        assert.strictEqual(getState().app.editorInputValue, null);
        assert.deepStrictEqual(getState().app.transcript, [
          { timestamp: 0, role: "user", message: "editor content" },
        ]);
      });

      it("splits on the delimiter, returns the first message, and keeps the rest", async () => {
        actions.setEditorInputValue(`first
l---
second
l---
third
`);
        const result = await parseInputFromEditor();
        assert.strictEqual(result, "first\n");
        assert.strictEqual(
          getState().app.editorInputValue,
          `second
l---
third
`,
        );
        assert.deepStrictEqual(getState().app.transcript, [
          { timestamp: 0, role: "user", message: "first\n" },
        ]);
      });

      it("returns queued messages one per call until the queue is drained", async () => {
        actions.setEditorInputValue(`first
l---
second
l---
third
`);
        assert.strictEqual(await parseInputFromEditor(), "first\n");
        assert.strictEqual(await parseInputFromEditor(), "second\n");
        assert.strictEqual(await parseInputFromEditor(), "third\n");
        assert.strictEqual(getState().app.editorInputValue, null);
      });

      it("filters empty parts around the delimiter", async () => {
        actions.setEditorInputValue(`l---
msg
l---
`);
        const result = await parseInputFromEditor();
        assert.strictEqual(result, "msg\n");
        assert.strictEqual(getState().app.editorInputValue, null);
      });

      it("returns null when the editor value is nothing but delimiters", async () => {
        actions.setEditorInputValue(`l---
l---
`);
        assert.strictEqual(await parseInputFromEditor(), null);
        assert.strictEqual(getState().app.editorInputValue, null);
      });
    });

    describe("splits slash commands", () => {
      it("splits slash command lines into their own messages", async () => {
        actions.setSlashCommands([
          {
            name: "cwd",
            filePath: "/test/.lasso/commands/cwd.md",
            content: "cwd",
          },
        ]);
        actions.setEditorInputValue(`message 2
/cwd
`);
        assert.strictEqual(await parseInputFromEditor(), "message 2\n");
        assert.strictEqual(getState().app.editorInputValue, "/cwd\n");
        assert.deepStrictEqual(getState().app.transcript, [
          { timestamp: 0, role: "user", message: "message 2\n" },
        ]);
      });

      it("keeps the user's internal newlines when a command splits multi-line text", async () => {
        actions.setSlashCommands([
          {
            name: "cwd",
            filePath: "/test/.lasso/commands/cwd.md",
            content: "cwd",
          },
        ]);
        actions.setEditorInputValue(`line one
line two
/cwd
line three
`);
        assert.strictEqual(
          await parseInputFromEditor(),
          "line one\nline two\n",
        );
        assert.strictEqual(
          getState().app.editorInputValue,
          `/cwd
l---
line three
`,
        );
      });

      it("keeps arguments on the slash command line intact", async () => {
        actions.setEditorInputValue(`context
/model new-model
`);
        assert.strictEqual(await parseInputFromEditor(), "context\n");
        assert.strictEqual(
          getState().app.editorInputValue,
          "/model new-model\n",
        );
      });

      it("returns the slash command when it is the first message", async () => {
        actions.setSlashCommands([
          {
            name: "cwd",
            filePath: "/test/.lasso/commands/cwd.md",
            content: "cwd",
          },
        ]);
        actions.setEditorInputValue(`/cwd
rest`);
        assert.strictEqual(await parseInputFromEditor(), "/cwd\n");
        assert.strictEqual(getState().app.editorInputValue, "rest");
      });

      it("splits multiple slash commands within a single chunk", async () => {
        actions.setSlashCommands([
          {
            name: "cwd",
            filePath: "/test/.lasso/commands/cwd.md",
            content: "cwd",
          },
          {
            name: "pwd",
            filePath: "/test/.lasso/commands/pwd.md",
            content: "pwd",
          },
        ]);
        actions.setEditorInputValue(`first
/cwd
second
/pwd
`);
        assert.strictEqual(await parseInputFromEditor(), "first\n");
        assert.strictEqual(
          getState().app.editorInputValue,
          `/cwd
l---
second
l---
/pwd
`,
        );
      });

      it("returns queued slash commands one per call until the queue is drained", async () => {
        actions.setSlashCommands([
          {
            name: "cwd",
            filePath: "/test/.lasso/commands/cwd.md",
            content: "cwd",
          },
          {
            name: "pwd",
            filePath: "/test/.lasso/commands/pwd.md",
            content: "pwd",
          },
        ]);
        actions.setEditorInputValue(`first
l---
/cwd
l---
/pwd
`);
        assert.strictEqual(await parseInputFromEditor(), "first\n");
        assert.strictEqual(await parseInputFromEditor(), "/cwd\n");
        assert.strictEqual(await parseInputFromEditor(), "/pwd\n");
        assert.strictEqual(getState().app.editorInputValue, null);
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
          shouldResolveSlashCommand("/model new-model", {
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
      it("returns true for a builtin slash command when forceKnownCommand is set", () => {
        assert.strictEqual(
          shouldResolveSlashCommand("/model", { forceKnownCommand: true }),
          true,
        );
      });

      it("returns true for a builtin slash command with args when forceKnownCommand is set", () => {
        assert.strictEqual(
          shouldResolveSlashCommand("/model new-model", {
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

  describe("setModelCommand", () => {
    beforeEach(() => {
      actions.resetStdout();
    });

    it("sets model and prints blue confirmation when input is valid", () => {
      actions.setModel("old-model");
      setModelCommand("/model new-model");
      assert.strictEqual(getState().config.model, "new-model");
      assert.strictEqual(getState().app.promptTokens.dirty, true);
      assert.deepStrictEqual(getWrites(), [
        `${BLUE}Model updated from \`old-model\` to \`new-model\`${RESET}\n`,
      ]);
    });

    it("prints red error when input has too many parts", () => {
      actions.setModel("old-model");
      setModelCommand("/model new-model extra");
      assert.strictEqual(getState().config.model, "old-model");
      assert.deepStrictEqual(getWrites(), [
        `${RED}Usage: /model [model]?${RESET}\n`,
      ]);
    });

    it("prints red error when input has only the command", () => {
      actions.setModel("old-model");
      setModelCommand("/model");
      assert.strictEqual(getState().config.model, "old-model");
      assert.deepStrictEqual(getWrites(), [
        `${RED}Usage: /model [model]?${RESET}\n`,
      ]);
    });

    it("handles model name with slashes", () => {
      actions.setModel("old");
      setModelCommand("/model provider/new-model");
      assert.strictEqual(getState().config.model, "provider/new-model");
      assert.deepStrictEqual(getWrites(), [
        `${BLUE}Model updated from \`old\` to \`provider/new-model\`${RESET}\n`,
      ]);
    });

    it("handles input with multiple spaces", () => {
      actions.setModel("old");
      setModelCommand("/model   new-model");
      assert.strictEqual(getState().config.model, "new-model");
    });

    it("handles input with tabs", () => {
      actions.setModel("old");
      setModelCommand("/model\tnew-model");
      assert.strictEqual(getState().config.model, "new-model");
    });

    it("warns when the new model has large prompt overhead", () => {
      actions.setContextWindowPerModel({ "new-model": 100_000 });
      mock.method(promptDeps, "getSystemContent", () => "s".repeat(210_000));

      setModelCommand("/model new-model");

      assert.ok(
        getWrites().some((w) =>
          w.includes(
            "The current set of context, skills, and tools is 70% of the 100,000 token context window!",
          ),
        ),
      );
    });
  });

  describe("getModel", () => {
    beforeEach(() => {
      actions.resetStdout();
    });

    it("prints current model", () => {
      actions.setModel("gpt-4");
      getModel();
      assert.deepStrictEqual(getWrites(), [`${BLUE}gpt-4${RESET}\n`]);
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
      mock.method(promptDeps, "getSystemContent", () => "abc");
      await clearCommand();
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [],
        messages: [],
      });
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: strToApproxTokens("abc"),
        dirty: true,
      });
      assert.deepStrictEqual(getWrites(), [
        `${GREY}Context cleared (0 tokens in session)${RESET}\n`,
      ]);
    });
  });

  describe("printTokens", () => {
    beforeEach(() => {
      actions.resetStdout();
      mock.method(promptDeps, "getSystemContent", () => "");
      mock.method(promptDeps, "getToolsContentStr", () => "123456789012");
      actions.setContextStr("123456789");
      actions.setSkillsStr("1234");
      actions.setConversationMessages([{ role: "user", content: "hello" }]);
    });

    it("prints the total and each area with its approx count when the cache is dirty", () => {
      actions.setPromptTokensDirty(true);
      printTokens();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${BLUE}Token count: 621 (0.012% of context window)${RESET}\n`,
        "- Chat messages: 11\n- Context files: 3\n- Harness and MCP tools: 4\n- Base system prompt: 602\n- Skill descriptions: 1\n",
        "\n",
      ]);
    });

    it("prints the total scaled to the cached token count when clean", () => {
      actions.setPromptTokens(1500);
      actions.setPromptTokensDirty(false);
      printTokens();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${BLUE}Token count: 62,100 (1.172% of context window)${RESET}\n`,
        "- Chat messages: 1,100\n- Context files: 300\n- Harness and MCP tools: 400\n- Base system prompt: 60,200\n- Skill descriptions: 100\n",
        "\n",
      ]);
    });

    it("includes the context window usage when configured", () => {
      actions.setModel("test-model");
      actions.setContextWindowPerModel({ "test-model": 10_000 });
      printTokens();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${BLUE}Token count: 621 (0.15% of context window)${RESET}\n`,
        "- Chat messages: 11\n- Context files: 3\n- Harness and MCP tools: 4\n- Base system prompt: 602\n- Skill descriptions: 1\n",
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
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [],
        messages: [{ role: "user", content: "hello" }],
      });
      assert.deepStrictEqual(getState().app.transcript, [
        { timestamp: 0, role: "user", message: "transcript content" },
      ]);
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: 0,
        dirty: true,
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
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [{ compacted: "summary", compactedAt: 123, tokens: 456 }],
        messages: [{ role: "assistant", content: "newer" }],
      });
      assert.deepStrictEqual(getState().app.transcript, [
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
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [],
        messages: [{ role: "user", content: "older" }],
      });
      assert.deepStrictEqual(getState().app.transcript, []);
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
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [{ compacted: "summary", compactedAt: 123, tokens: 456 }],
        messages: [{ role: "assistant", content: "newer" }],
      });
      assert.deepStrictEqual(getState().app.transcript, [
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
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [],
        messages: [{ role: "user", content: "older" }],
      });
      assert.deepStrictEqual(getState().app.transcript, []);
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
        `# [lasso] Editor content

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
        `# Available skills:

- **test-skill**: A test skill
  /skills/test-skill

`,
      );
      assert.deepStrictEqual(getWrites(), []);
    });

    it("filters out context file skills", async () => {
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
        `# Available skills:

- **real-skill**: A real skill
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
        `# Available tools:

- **[lasso] web_fetch_html**: Fetch a web page by URL and return its readable content, parsed to extract the main article.
- **[lasso] web_fetch_json**: Fetch a JSON API endpoint by URL and return the parsed JSON response.
- **[lasso] load_skill**: Load a skill to get specialized instructions
- **[lasso] bash**: Execute a bash command and return its output.
- **[lasso] create_subagent**: Launch parallel subagents for independent investigation or implementation. Prefer read-only subagents for parallel work to avoid conflicts. Read-only subagents can fetch web content, inspect files, and load skills; read-write subagents can modify files or execute commands.

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
        `# Available tools:

- **[lasso] web_fetch_html**: Fetch a web page by URL and return its readable content, parsed to extract the main article.
- **[lasso] web_fetch_json**: Fetch a JSON API endpoint by URL and return the parsed JSON response.
- **[lasso] load_skill**: Load a skill to get specialized instructions
- **[lasso] bash**: Execute a bash command and return its output.
- **[lasso] create_subagent**: Launch parallel subagents for independent investigation or implementation. Prefer read-only subagents for parallel work to avoid conflicts. Read-only subagents can fetch web content, inspect files, and load skills; read-write subagents can modify files or execute commands.
- **[first mcp] mcp_tool**: [no description available]
- **[first mcp] described_tool**: A described MCP tool

`,
      );
    });
  });

  describe("pageAvailableContextFiles", () => {
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

      await pageAvailableContextFiles();

      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# Available context files:

- /project/AGENTS.md

`,
      );
      assert.deepStrictEqual(getWrites(), []);
    });

    it("includes context file skills", async () => {
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

      await pageAvailableContextFiles();

      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# Available context files:

- /project/AGENTS.md
- /other/AGENTS.md (as a skill)

`,
      );
    });

    it("prints that there are no available context files when entries list is empty", () => {
      pageAvailableContextFiles({ isTyped: true });
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}No available context files${RESET}\n`,
        "\n",
      ]);
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
    });

    it("surrounds the message with blank lines when isTyped is false", async () => {
      await pageAvailableContextFiles();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${YELLOW}No available context files${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", async () => {
      actions.setApiStreamAbortController(new AbortController());
      await pageAvailableContextFiles();
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

  describe("pageCommands", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("writes builtin and custom commands into the temp file", async () => {
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
        `# Available commands:

- /edit
- /editpage
- /history
- /clear
- /paste
- /model
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
- /test/.lasso/commands/custom.md

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
        ["model", "m"],
        ["skills", "l"],
        ["context", "n"],
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
        assert.strictEqual(getState().app.editorInputValue, null);
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
        assert.strictEqual(getState().app.isNonBlockingProcessOngoing, true);
        await harness.flush();
        assert.deepStrictEqual(prompts, []);
        assert.strictEqual(getState().app.editorInputValue, "  edited  ");
        assert.strictEqual(getState().app.isNonBlockingProcessOngoing, false);
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
          getState().app.editorInputValue,
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

        assert.strictEqual(getState().app.bufferedStdoutWhileEditorOpen, "");
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
        assert.strictEqual(getState().app.editorInputValue, null);
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
          `# [lasso] Editor content

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
          `# Available commands:

- /edit
- /editpage
- /history
- /clear
- /paste
- /model
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
- /test/.lasso/commands/custom.md

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
          `# Available tools:

- **[lasso] web_fetch_html**: Fetch a web page by URL and return its readable content, parsed to extract the main article.
- **[lasso] web_fetch_json**: Fetch a JSON API endpoint by URL and return the parsed JSON response.
- **[lasso] load_skill**: Load a skill to get specialized instructions
- **[lasso] bash**: Execute a bash command and return its output.
- **[lasso] create_subagent**: Launch parallel subagents for independent investigation or implementation. Prefer read-only subagents for parallel work to avoid conflicts. Read-only subagents can fetch web content, inspect files, and load skills; read-write subagents can modify files or execute commands.

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
          `# [lasso] Editor content

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
        assert.deepStrictEqual(getState().app.transcript, [
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
        assert.deepStrictEqual(getState().app.transcript, [
          { timestamp: 0, role: "user", message: "pasted content\n" },
        ]);
      });
    });

    describe("model and state commands", () => {
      it("handles /clear command", async () => {
        const result = await resolveSlashCommand("/clear");
        assert.strictEqual(result, null);
      });

      it("handles /model command", async () => {
        actions.setModel("old");
        actions.resetStdout();
        const result = await resolveSlashCommand("/model new-model");
        assert.strictEqual(result, null);
        assert.strictEqual(getState().config.model, "new-model");
        assert.deepStrictEqual(getWrites(), [
          `${BLUE}Model updated from \`old\` to \`new-model\`${RESET}\n`,
        ]);
      });

      it("handles /model without args", async () => {
        actions.setModel("gpt-4");
        actions.resetStdout();
        const result = await resolveSlashCommand("/model");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), [`${BLUE}gpt-4${RESET}\n`]);
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
    });

    describe("record commands", () => {
      it("handles /record command and logs the recording to the transcript", async () => {
        testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "key");
        actions.setTranscriptionSdkProvider("openai");
        actions.setTranscriptionModel("gpt-4o-transcribe");
        actions.resetStdout();
        actions.setRl(makeFakeRlWithWrites().rl);
        mockRecording();
        mockTranscription("hello from the mic");
        testFs._files.set("/tmp/lasso-test-uuid.wav", "wav recording bytes");
        const result = await resolveSlashCommand("/record");
        assert.strictEqual(result, "hello from the mic");
        assert.deepStrictEqual(getState().app.transcript, [
          {
            timestamp: 0,
            role: "user",
            message: "hello from the mic",
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
          `# Available commands:

- /edit
- /editpage
- /history
- /clear
- /paste
- /model
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
        assert.match(tempContent, /^# Global config from path: /);
        assert.match(tempContent, /\n# Local config from path: /);
        assert.match(tempContent, /# Applied config\n/);
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
          `${BLUE}Token count: 602 (0% of context window)${RESET}\n`,
          "- Chat messages: 0\n- Context files: 0\n- Harness and MCP tools: 0\n- Base system prompt: 602\n- Skill descriptions: 0\n",
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
        assert.deepStrictEqual(getState().app.transcript, [
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
        assert.deepStrictEqual(getState().app.transcript, [
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
        mock.method(promptDeps, "getSystemContent", () => "s".repeat(210_000));
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
            `${YELLOW}The current set of context, skills, and tools is 71.09% of the 100,000 token context window!`,
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
        mock.method(promptDeps, "getSystemContent", () => "s".repeat(210_000));
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
          `Global config from path: /fake-home/.config/lasso/settings.yaml
global diff

Local config from path: /test-cwd/.lasso/settings.yaml
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
        assert.ok(
          getWrites().some((w) =>
            w.includes(
              "The current set of context, skills, and tools is 71.09% of the 100,000 token context window!",
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
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${RED}Invalid command: /unknown, valid commands:${RESET}\n`,
          "- /edit\n- /editpage\n- /history\n- /clear\n- /paste\n- /model\n- /skills\n- /context\n- /commands\n- /keymaps\n- /usage\n- /tokens\n- /resume\n- /config\n- /reload\n- /initlocal\n- /initglobal\n- /lastresponse\n- /lastmessage\n- /lastdiff\n- /summaries\n- /tools\n- /record\n- /test-cwd/.lasso/commands/known.md\n",
        ]);
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
      assert.strictEqual(result, "hello from the mic");
      assert.strictEqual(questionSawController, true);
      assert.strictEqual(getState().abortControllers.recordProcess, null);
      assert.ok(transcribeCalls[0] !== undefined);
      assert.deepStrictEqual(
        transcribeCalls[0].audio,
        Buffer.from("wav pcm bytes"),
      );
      assert.deepStrictEqual(getWrites(), [
        "Press enter to stop recording:\n",
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
      assert.strictEqual(result, "hello from the mic");
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
      assert.deepStrictEqual(getState().app.bufferedStdoutWhileEditorOpen, "");
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
        "Press enter to stop recording:\n",
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
      assert.deepStrictEqual(getWrites(), ["Press enter to stop recording:\n"]);
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
        "Press enter to stop recording:\n",
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
      assert.deepStrictEqual(getWrites(), ["Press enter to stop recording:\n"]);
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
        "Press enter to stop recording:\n",
        `${RED}Error while transcribing: bad audio${RESET}\n`,
      ]);
      assert.strictEqual(getState().abortControllers.recordProcess, null);
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.wav"), false);
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
      assert.deepStrictEqual(getWrites(), ["Press enter to stop recording:\n"]);
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

    it("resolves recordingReady when sox first writes to stderr", async () => {
      actions.setRecordProcessAbortController(new AbortController());
      const { stderr } = mockRecording();
      const { recordingReady } = recordInput("/tmp/lasso-test-uuid.wav");
      stderr.emit("data", Buffer.from("ready"));
      await recordingReady;
    });

    it("collects stderr chunks and exposes them via getErrorOutput", async () => {
      actions.setRecordProcessAbortController(new AbortController());
      const { stderr } = mockRecording();
      const { stop, getErrorOutput, recordingFinished } = recordInput(
        "/tmp/lasso-test-uuid.wav",
      );
      stderr.emit("data", Buffer.from("in:"));
      stderr.emit("data", Buffer.from(" 16kHz"));
      stop();
      await recordingFinished;
      assert.strictEqual(getErrorOutput(), "in: 16kHz");
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

  describe("initLocalConfig and initGlobalConfig", () => {
    it("creates the local config in .lasso/settings.yaml", async () => {
      actions.resetStdout();
      await initLocalConfig();
      assert.deepStrictEqual(getWrites(), [
        `${PURPLE}Created the local config at /test-cwd/.lasso/settings.yaml${RESET}\n`,
      ]);
      assert.strictEqual(
        testFs._files.get("/test-cwd/.lasso/settings.yaml"),
        `# This config was auto-generated by the /initlocal command
model: deepseek-v4-pro
baseURL: https://opencode.ai/zen/v1
`,
      );
      assert.ok(testFs._dirs.has("/test-cwd/.lasso"));
    });

    it("warns and does not overwrite when the local config already exists", async () => {
      testFs._files.set("/test-cwd/.lasso/settings.yaml", "existing config");
      actions.resetStdout();
      await initLocalConfig();
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}The local config already exists at /test-cwd/.lasso/settings.yaml${RESET}\n`,
      ]);
      assert.strictEqual(
        testFs._files.get("/test-cwd/.lasso/settings.yaml"),
        "existing config",
      );
    });

    it("warns when writing the local config fails", async () => {
      mock.method(fsDeps, "writeFile", () =>
        Promise.reject(new Error("write failed")),
      );
      actions.resetStdout();
      await initLocalConfig();
      assert.deepStrictEqual(getWrites(), [
        `${RED}Failed to write the config to /test-cwd/.lasso/settings.yaml${RESET}\n`,
      ]);
    });

    it("creates the global config in ~/.config/lasso/settings.yaml", async () => {
      actions.resetStdout();
      await initGlobalConfig();
      assert.deepStrictEqual(getWrites(), [
        `${PURPLE}Created the global config at /fake-home/.config/lasso/settings.yaml${RESET}\n`,
      ]);
      assert.strictEqual(
        testFs._files.get("/fake-home/.config/lasso/settings.yaml"),
        `# This config was auto-generated by the /initglobal command
model: deepseek-v4-pro
baseURL: https://opencode.ai/zen/v1
`,
      );
      assert.ok(testFs._dirs.has("/fake-home/.config/lasso"));
    });

    it("warns and does not overwrite when the global config already exists", async () => {
      testFs._files.set(
        "/fake-home/.config/lasso/settings.yaml",
        "existing config",
      );
      actions.resetStdout();
      await initGlobalConfig();
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}The global config already exists at /fake-home/.config/lasso/settings.yaml${RESET}\n`,
      ]);
      assert.strictEqual(
        testFs._files.get("/fake-home/.config/lasso/settings.yaml"),
        "existing config",
      );
    });

    it("warns when writing the global config fails", async () => {
      mock.method(fsDeps, "writeFile", () =>
        Promise.reject(new Error("write failed")),
      );
      actions.resetStdout();
      await initGlobalConfig();
      assert.deepStrictEqual(getWrites(), [
        `${RED}Failed to write the config to /fake-home/.config/lasso/settings.yaml${RESET}\n`,
      ]);
    });

    it("warns when the config directory cannot be created", async () => {
      mock.method(fsDeps, "mkdir", () =>
        Promise.reject(new Error("mkdir failed")),
      );
      actions.resetStdout();
      await initLocalConfig();
      assert.deepStrictEqual(getWrites(), [
        `${RED}Failed to create the directory: /test-cwd/.lasso${RESET}\n`,
      ]);
    });
  });
});
