import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import childProcess from "node:child_process";
import os from "node:os";
import { actions, getState, promptDeps } from "./state.ts";

import { strToApproxTokens } from "./utils.ts";
import {
  parseInputFromEditor,
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
  initSigInt,
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
  mockClipboardPaste,
  mockClipboardPasteFailure,
  mockExecCalls,
  mockSpawnSync,
  mockPagerSpawn,
  makeFakeMcpClient,
  makeMcpTool,
  batPagerCmd,
  stripAnsi,
  mockStdoutWrites,
  BLUE,
  BOLD,
  BOLD_RESET,
  GREY,
  PURPLE,
  RED,
  RESET,
  YELLOW,
  makeAbortError,
  makeErrnoError,
  mockProcessExit,
} from "./test-helpers.ts";
import { fsDeps } from "./deps.ts";
import { getGlobalConfigPath, getGlobalContextDir } from "./paths.ts";
import { defaultConfig } from "./config-types.ts";

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

      initSigInt();
      assert(sigint !== undefined);
      sigint();

      assert.equal(controller.signal.aborted, true);
    });

    it("aborts API stream", () => {
      let sigint: (() => void) | undefined;
      actions.setRl(
        makeFakeRl({
          on: (_event: string, listener: () => void) => {
            sigint = listener;
          },
        }),
      );
      const controller = new AbortController();
      actions.setApiStreamAbortController(controller);

      initSigInt();
      assert(sigint !== undefined);
      sigint();

      assert.equal(controller.signal.aborted, true);
    });

    it("clears readline input for an active question", () => {
      let sigint: (() => void) | undefined;
      let writeCount = 0;
      actions.setRl(
        makeFakeRl({
          line: "input",
          on: (_event: string, listener: () => void) => {
            sigint = listener;
          },
          write: () => {
            writeCount += 1;
          },
        }),
      );
      const controller = new AbortController();
      actions.setQuestionAbortController(controller);

      initSigInt();
      assert(sigint !== undefined);
      sigint();

      assert.equal(writeCount, 2);
      assert.equal(controller.signal.aborted, false);
    });

    it("aborts an active question when readline input is empty", () => {
      let sigint: (() => void) | undefined;
      actions.setRl(
        makeFakeRl({
          on: (_event: string, listener: () => void) => {
            sigint = listener;
          },
        }),
      );
      const controller = new AbortController();
      actions.setQuestionAbortController(controller);

      initSigInt();
      assert(sigint !== undefined);
      sigint();

      assert.equal(controller.signal.aborted, true);
    });

    it("does nothing when no controller is active", () => {
      let sigint: (() => void) | undefined;
      actions.setRl(
        makeFakeRl({
          on: (_event: string, listener: () => void) => {
            sigint = listener;
          },
        }),
      );

      initSigInt();
      assert(sigint !== undefined);
      assert.doesNotThrow(sigint);
    });

    it("rejects simultaneous API and editor interruption controllers", () => {
      let sigint: (() => void) | undefined;
      actions.setRl(
        makeFakeRl({
          on: (_event: string, listener: () => void) => {
            sigint = listener;
          },
        }),
      );
      actions.setApiStreamAbortController(new AbortController());
      actions.setInterruptWithEditorAbortController(new AbortController());

      initSigInt();
      assert(sigint !== undefined);
      assert.throws(sigint);
    });

    it("rejects simultaneous API and question controllers", () => {
      let sigint: (() => void) | undefined;
      actions.setRl(
        makeFakeRl({
          on: (_event: string, listener: () => void) => {
            sigint = listener;
          },
        }),
      );
      actions.setApiStreamAbortController(new AbortController());
      actions.setQuestionAbortController(new AbortController());

      initSigInt();
      assert(sigint !== undefined);
      assert.throws(sigint);
    });

    it("rejects simultaneous question and editor interruption controllers", () => {
      let sigint: (() => void) | undefined;
      actions.setRl(
        makeFakeRl({
          on: (_event: string, listener: () => void) => {
            sigint = listener;
          },
        }),
      );
      actions.setQuestionAbortController(new AbortController());
      actions.setInterruptWithEditorAbortController(new AbortController());

      initSigInt();
      assert(sigint !== undefined);
      assert.throws(sigint);
    });
  });

  describe("spawnAndReadEditorContent", () => {
    let spawned: string[];

    beforeEach(() => {
      spawned = [];
      actions.setRl(makeFakeRl({ line: "" }));
      mock.method(childProcess, "spawnSync", (cmd: string) => {
        spawned.push(cmd);
      });
    });

    describe("returns null on file failures", () => {
      it("returns null when writeFile fails", async () => {
        mock.method(fsDeps, "writeFileSync", () => {
          throw new Error("write failed");
        });
        const result = await spawnAndReadEditorContent();
        assert.strictEqual(result, null);
      });

      it("warns when creating the temp file fails", async () => {
        mock.method(fsDeps, "writeFileSync", () => {
          throw new Error("write failed");
        });
        const getWrites = mockStdoutWrites();

        const result = await spawnAndReadEditorContent();

        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), [
          `${RED}Failed to create a temp file${RESET}\n`,
        ]);
      });

      it("returns null and cleans up when readFile fails", async () => {
        mock.method(childProcess, "spawnSync", () => {
          testFs.writeFileSync("/tmp/lasso-test-uuid.txt", "modified");
        });
        mock.method(fsDeps, "readFileSync", () => {
          throw new Error("read failed");
        });
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
        mock.method(childProcess, "spawnSync", () => {
          testFs.writeFileSync("/tmp/lasso-test-uuid.txt", "");
        });
        const result = await spawnAndReadEditorContent();
        assert.strictEqual(result, null);
      });

      it("clears the editor input value and returns null when the editor result is whitespace only", async () => {
        actions.setEditorInputValue("prefill");
        mock.method(childProcess, "spawnSync", () => {
          testFs.writeFileSync("/tmp/lasso-test-uuid.txt", "   \n\t");
        });
        const result = await spawnAndReadEditorContent();
        assert.strictEqual(result, null);
        assert.strictEqual(getState().app.editorInputValue, null);
      });

      it("returns null without state changes when the editor result is whitespace only and there was no prefill", async () => {
        mock.method(childProcess, "spawnSync", () => {
          testFs.writeFileSync("/tmp/lasso-test-uuid.txt", "   ");
        });
        const result = await spawnAndReadEditorContent();
        assert.strictEqual(result, null);
        assert.strictEqual(getState().app.editorInputValue, null);
      });

      it("returns normalized content", async () => {
        mock.method(childProcess, "spawnSync", () => {
          testFs.writeFileSync("/tmp/lasso-test-uuid.txt", "  hello  ");
        });
        const result = await spawnAndReadEditorContent();
        assert.strictEqual(result, "  hello\n");
        assert.strictEqual(getState().app.editorInputValue, "  hello  ");
      });

      it("returns normalized content when editor saves unchanged content", async () => {
        actions.setRl(makeFakeRl({ line: "hello" }));
        mock.method(childProcess, "spawnSync", () => {
          testFs.writeFileSync("/tmp/lasso-test-uuid.txt", "hello");
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
        mock.method(childProcess, "spawnSync", () => {
          testFs.writeFileSync(
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
        mock.method(childProcess, "spawnSync", () => {
          testFs.writeFileSync("/tmp/lasso-test-uuid.txt", "queryclip");
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
        mock.method(childProcess, "spawnSync", () => {
          initialEditorContent = testFs
            .readFileSync("/tmp/lasso-test-uuid.txt")
            .toString();
          testFs.writeFileSync("/tmp/lasso-test-uuid.txt", "final");
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
      it("returns the whole editor value and clears it when no delimiter is present", () => {
        actions.setEditorInputValue("editor content");
        const result = parseInputFromEditor();
        assert.strictEqual(result, "editor content");
        assert.strictEqual(getState().app.editorInputValue, null);
        assert.deepStrictEqual(getState().app.transcript, [
          { timestamp: 0, role: "user", message: "editor content" },
        ]);
      });

      it("splits on the delimiter, returns the first message, and keeps the rest", () => {
        actions.setEditorInputValue(`first
l---
second
l---
third
`);
        const result = parseInputFromEditor();
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

      it("returns queued messages one per call until the queue is drained", () => {
        actions.setEditorInputValue(`first
l---
second
l---
third
`);
        assert.strictEqual(parseInputFromEditor(), "first\n");
        assert.strictEqual(parseInputFromEditor(), "second\n");
        assert.strictEqual(parseInputFromEditor(), "third\n");
        assert.strictEqual(getState().app.editorInputValue, null);
      });

      it("filters empty parts around the delimiter", () => {
        actions.setEditorInputValue(`l---
msg
l---
`);
        const result = parseInputFromEditor();
        assert.strictEqual(result, "msg\n");
        assert.strictEqual(getState().app.editorInputValue, null);
      });

      it("returns null when the editor value is nothing but delimiters", () => {
        actions.setEditorInputValue(`l---
l---
`);
        assert.strictEqual(parseInputFromEditor(), null);
        assert.strictEqual(getState().app.editorInputValue, null);
      });
    });

    describe("splits slash commands", () => {
      it("splits slash command lines into their own messages", () => {
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
        assert.strictEqual(parseInputFromEditor(), "message 2\n");
        assert.strictEqual(getState().app.editorInputValue, "/cwd\n");
        assert.deepStrictEqual(getState().app.transcript, [
          { timestamp: 0, role: "user", message: "message 2\n" },
        ]);
      });

      it("keeps the user's internal newlines when a command splits multi-line text", () => {
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
        assert.strictEqual(parseInputFromEditor(), "line one\nline two\n");
        assert.strictEqual(
          getState().app.editorInputValue,
          `/cwd
l---
line three
`,
        );
      });

      it("keeps arguments on the slash command line intact", () => {
        actions.setEditorInputValue(`context
/model new-model
`);
        assert.strictEqual(parseInputFromEditor(), "context\n");
        assert.strictEqual(
          getState().app.editorInputValue,
          "/model new-model\n",
        );
      });

      it("returns the slash command when it is the first message", () => {
        actions.setSlashCommands([
          {
            name: "cwd",
            filePath: "/test/.lasso/commands/cwd.md",
            content: "cwd",
          },
        ]);
        actions.setEditorInputValue(`/cwd
rest`);
        assert.strictEqual(parseInputFromEditor(), "/cwd\n");
        assert.strictEqual(getState().app.editorInputValue, "rest");
      });

      it("splits multiple slash commands within a single chunk", () => {
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
        assert.strictEqual(parseInputFromEditor(), "first\n");
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

      it("returns queued slash commands one per call until the queue is drained", () => {
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
        assert.strictEqual(parseInputFromEditor(), "first\n");
        assert.strictEqual(parseInputFromEditor(), "/cwd\n");
        assert.strictEqual(parseInputFromEditor(), "/pwd\n");
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
      mock.method(promptDeps, "getSystemContent", () => "s".repeat(150_000));

      setModelCommand("/model new-model");

      assert.ok(
        getWrites().some((w) =>
          w.includes(
            "The current set of context, skills, and tools is 50% of the 100,000 token context window!",
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

    it("resets params", () => {
      actions.setConversationMessages([{ role: "user", content: "hello" }]);
      actions.setConversationSummaries([
        { compacted: "summary", compactedAt: 3, tokens: 5 },
      ]);
      mock.method(promptDeps, "getSystemContent", () => "abc");
      clearCommand();
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [],
        messages: [],
      });
      assert.deepStrictEqual(getState().app.promptTokens, {
        value: strToApproxTokens("abc"),
        dirty: false,
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
        `${BLUE}Token count: 621 (0% of context window)${RESET}\n`,
        "- Chat messages: 11\n- Context files: 3\n- Harness and MCP tools: 4\n- Base system prompt: 602\n- Skill descriptions: 1\n",
        "\n",
      ]);
    });
  });

  describe("resume", () => {
    beforeEach(() => {
      actions.resetStdout();
    });

    it("prints usage error when no session start date is provided", () => {
      const result = resume("/resume");
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}Usage: /resume [session start date]${RESET}\n`,
      ]);
    });

    it("prints usage error when too many parts are provided", () => {
      const result = resume("/resume 123 456");
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}Usage: /resume [session start date]${RESET}\n`,
      ]);
    });

    it("prints usage error when session start date is not a number", () => {
      const result = resume("/resume abc");
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}Usage: /resume [session start date]${RESET}\n`,
      ]);
    });

    it("prints error when sessions directory does not exist", () => {
      const result = resume("/resume 1234567890000");
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}No conversation found with session start date: 1234567890000${RESET}\n`,
        "\n",
      ]);
    });

    it("loads the session and returns continue when the date matches", () => {
      actions.setConversationMessages([{ role: "user", content: "old" }]);
      addSessionFile(1234567890000, {
        messages: [{ role: "user", content: "hello" }],
        summaries: [],
        transcript: [
          { timestamp: 0, role: "user", message: "transcript content" },
        ],
      });

      const result = resume("/resume 1234567890000");

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

    it("prints error when no conversation is found", () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
      testFs._files.set(
        "/fake-home/.local/state/lasso/sessions/session-9999999999999.json",
        "transcript content",
      );
      const result = resume("/resume 1234567890000");
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}No conversation found with session start date: 1234567890000${RESET}\n`,
        "\n",
      ]);
    });

    it("prints an error and returns null when the session file cannot be parsed", () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
      testFs._files.set(
        "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
        "not json",
      );
      const result = resume("/resume 1234567890000");
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}Failed to parse the session file at /fake-home/.local/state/lasso/sessions/session-1234567890000.json${RESET}\n`,
        "\n",
      ]);
    });

    it("skips files that do not match the session format", () => {
      testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
      testFs._files.set(
        "/fake-home/.local/state/lasso/sessions/other-1234567890000.md",
        "other",
      );
      const result = resume("/resume 1234567890000");
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

    it("prints an error when there are no sessions to resume", () => {
      const result = resumeWithNoArgs();
      assert.strictEqual(result, null);
      assert.deepStrictEqual(getWrites(), [
        `${RED}No sessions to resume${RESET}\n`,
        "\n",
      ]);
    });

    it("resumes the most recent session", () => {
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

      const result = resumeWithNoArgs();

      assert.strictEqual(result, "Continue");
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [{ compacted: "summary", compactedAt: 123, tokens: 456 }],
        messages: [{ role: "assistant", content: "newer" }],
      });
      assert.deepStrictEqual(getState().app.transcript, [
        { timestamp: 0, role: "user", message: "newer transcript" },
      ]);
    });

    it("excludes the current session file when resuming the most recent session", () => {
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

      const result = resumeWithNoArgs();

      assert.strictEqual(result, "Continue");
      assert.deepStrictEqual(getState().app.conversation, {
        summaries: [],
        messages: [{ role: "user", content: "older" }],
      });
      assert.deepStrictEqual(getState().app.transcript, []);
    });

    it("prints an error when the current session is the only session", () => {
      actions.setSessionFilePath(
        "/fake-home/.local/state/lasso/sessions/session-1234567890000.json",
      );
      addSessionFile(1234567890000, {
        messages: [{ role: "user", content: "hello" }],
        summaries: [],
        transcript: [],
      });

      const result = resumeWithNoArgs();

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
        `${BLUE}No chat history${RESET}\n`,
        "\n",
      ]);
    });

    it("surrounds the message with blank lines when isTyped is false", () => {
      pageHistory();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${BLUE}No chat history${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", () => {
      actions.setApiStreamAbortController(new AbortController());
      pageHistory();
      assert.deepStrictEqual(getWrites(), [`${BLUE}No chat history${RESET}\n`]);
    });

    it("opens the chat history in a pager with a heading prepended", () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.setTranscript([
        {
          timestamp: 0,
          role: "user",
          message: "log content",
        },
      ]);
      pageHistory();
      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Chat history

Jan 1, 1970, 12:00:00 AM  *user*
log content

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
        `${BLUE}No llm messages${RESET}\n`,
        "\n",
      ]);
    });

    it("surrounds the message with blank lines when isTyped is false", async () => {
      await pageLastResponse();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${BLUE}No llm messages${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", async () => {
      actions.setApiStreamAbortController(new AbortController());
      await pageLastResponse();
      assert.deepStrictEqual(getWrites(), [`${BLUE}No llm messages${RESET}\n`]);
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
        `${BLUE}No user messages${RESET}\n`,
        "\n",
      ]);
    });

    it("surrounds the message with blank lines when isTyped is false", () => {
      pageLastMessage();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${BLUE}No user messages${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", () => {
      actions.setApiStreamAbortController(new AbortController());
      pageLastMessage();
      assert.deepStrictEqual(getWrites(), [
        `${BLUE}No user messages${RESET}\n`,
      ]);
    });

    it("opens the latest user message in a pager", () => {
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

      pageLastMessage();

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
        `${BLUE}No diffs from the last turn${RESET}\n`,
        "\n",
      ]);
    });

    it("surrounds the message with blank lines when isTyped is false", () => {
      pageLastDiff();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${BLUE}No diffs from the last turn${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", () => {
      actions.setApiStreamAbortController(new AbortController());
      pageLastDiff();
      assert.deepStrictEqual(getWrites(), [
        `${BLUE}No diffs from the last turn${RESET}\n`,
      ]);
    });

    it("opens the diffs in a pager with a fence per file", () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.appendToolEditDiff({ fileName: "/a.ts", diffStdout: "+a\n" });
      actions.appendToolEditDiff({ fileName: "/b.ts", diffStdout: "+b\n" });

      pageLastDiff();

      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `━━ /a.ts ━━\n+a\n\n\n━━ /b.ts ━━\n+b\n\n`,
      );
    });

    it("opens the diffs with collapsed extra trailing newlines", () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.appendToolEditDiff({ fileName: "/a.ts", diffStdout: "+a\n\n\n" });

      pageLastDiff();

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

    it("opens the summaries list newest first in a pager", () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.setConversationSummaries([
        { compacted: "older summary", compactedAt: 100, tokens: 10 },
        { compacted: "latest summary", compactedAt: 200, tokens: 20 },
      ]);

      pageSummaries();

      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.deepStrictEqual(
        stripAnsi(testFs._files.get("/tmp/lasso-test-uuid.txt") ?? ""),
        `# [lasso] Conversation summaries

## Summary 2 (20 tokens, compacted at 200)

latest summary

---

## Summary 1 (10 tokens, compacted at 100)

older summary

`,
      );
    });

    it("prints a message when there are no conversation summaries", () => {
      pageSummaries({ isTyped: true });

      assert.deepStrictEqual(getWrites(), [
        `${BLUE}No conversation summaries${RESET}\n`,
        "\n",
      ]);
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
    });

    it("surrounds the message with blank lines when isTyped is false", () => {
      pageSummaries();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${BLUE}No conversation summaries${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", () => {
      actions.setApiStreamAbortController(new AbortController());
      pageSummaries();
      assert.deepStrictEqual(getWrites(), [
        `${BLUE}No conversation summaries${RESET}\n`,
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
        `${BLUE}Editor is empty${RESET}\n`,
        "\n",
      ]);
    });

    it("surrounds the message with blank lines when isTyped is false", () => {
      pageEditStr();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${BLUE}Editor is empty${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", () => {
      actions.setApiStreamAbortController(new AbortController());
      pageEditStr();
      assert.deepStrictEqual(getWrites(), [`${BLUE}Editor is empty${RESET}\n`]);
    });

    it("opens the editor input in a pager with a header", () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.setEditorInputValue("editor input");

      pageEditStr();

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

    it("opens available skills in a pager", () => {
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

      pageSkills();

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

    it("filters out context file skills", () => {
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

      pageSkills();

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
        `${BLUE}No available skills${RESET}\n`,
        "\n",
      ]);
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
    });

    it("surrounds the message with blank lines when isTyped is false", () => {
      pageSkills();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${BLUE}No available skills${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", () => {
      actions.setApiStreamAbortController(new AbortController());
      pageSkills();
      assert.deepStrictEqual(getWrites(), [
        `${BLUE}No available skills${RESET}\n`,
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

    it("opens available context files in a pager", () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      actions.setContextEntries([
        { filePath: "/project/AGENTS.md", content: "context" },
      ]);

      pageAvailableContextFiles();

      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# Available context files:

- /project/AGENTS.md

`,
      );
      assert.deepStrictEqual(getWrites(), []);
    });

    it("includes context file skills", () => {
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

      pageAvailableContextFiles();

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
        `${BLUE}No available context files${RESET}\n`,
        "\n",
      ]);
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
    });

    it("surrounds the message with blank lines when isTyped is false", () => {
      pageAvailableContextFiles();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${BLUE}No available context files${RESET}\n`,
        "\n",
      ]);
    });

    it("does not add spacing when streaming", () => {
      actions.setApiStreamAbortController(new AbortController());
      pageAvailableContextFiles();
      assert.deepStrictEqual(getWrites(), [
        `${BLUE}No available context files${RESET}\n`,
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

    it("writes builtin and custom commands into the temp file", () => {
      actions.setSlashCommands([
        {
          name: "custom.md",
          filePath: "/test/.lasso/commands/custom.md",
          content: "custom",
        },
      ]);
      pageCommands();
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
- /test/.lasso/commands/custom.md

`,
      );
      assert.deepStrictEqual(getWrites(), []);
    });

    it("opens commands in a pager via LASSO_PAGER", () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "nano __FILE__");
      pageCommands();
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
      it("runs edit command when its keymap matches", async () => {
        const prompts: boolean[] = [];
        mock.method(harness.rl, "prompt", (arg: boolean) => {
          prompts.push(arg);
        });
        mock.method(childProcess, "spawnSync", () => {
          testFs.writeFileSync("/tmp/lasso-test-uuid.txt", "  edited  ");
        });
        harness.emitKey({ name: "g", ctrl: true });
        await harness.flush();
        assert.deepStrictEqual(prompts, []);
        assert.strictEqual(getState().app.editorInputValue, "  edited  ");
      });

      it("runs paste command with clipboard when its keymap matches", async () => {
        actions.setKeymaps({
          ...defaultConfig.keymaps,
          paste: { name: "v", ctrl: true },
        });
        mockClipboardPaste("world");
        mock.method(childProcess, "spawnSync", () => {
          testFs.writeFileSync(
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

      it("redraws the pending question prompt after a cancelled edit", async () => {
        const prompts: boolean[] = [];
        mock.method(harness.rl, "prompt", (arg: boolean) => {
          prompts.push(arg);
        });
        mock.method(childProcess, "spawnSync", () => {
          testFs.writeFileSync("/tmp/lasso-test-uuid.txt", "");
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
        mock.method(childProcess, "spawnSync", () => {
          testFs.writeFileSync("/tmp/lasso-test-uuid.txt", "from editor");
        });
        const result = await resolveSlashCommand("/edit");
        assert.strictEqual(result, "from editor\n");
        assert.deepStrictEqual(getState().app.transcript, [
          { timestamp: 0, role: "user", message: "from editor\n" },
        ]);
      });

      it("handles /paste command and logs editor content to the transcript", async () => {
        mockClipboardPaste("clip");
        mock.method(childProcess, "spawnSync", () => {
          testFs.writeFileSync("/tmp/lasso-test-uuid.txt", "pasted content");
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
          `${BLUE}No available skills${RESET}\n`,
          "\n",
        ]);
      });

      it("handles /context command", async () => {
        actions.resetStdout();
        const result = await resolveSlashCommand("/context");
        assert.strictEqual(result, null);
        assert.deepStrictEqual(getWrites(), [
          "\n",
          `${BLUE}No available context files${RESET}\n`,
          "\n",
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
          `${BLUE}No diffs from the last turn${RESET}\n`,
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
        mock.method(
          fsDeps,
          "writeFileSync",
          (path: string, content: string) => {
            if (path === "/tmp/lasso-global-before-test-uuid.txt") {
              throw new Error("write failed");
            }
            testFs.writeFileSync(path, content);
          },
        );
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
        mock.method(
          fsDeps,
          "writeFileSync",
          (path: string, content: string) => {
            if (path === "/tmp/lasso-global-after-test-uuid.txt") {
              throw new Error("write failed");
            }
            testFs.writeFileSync(path, content);
          },
        );
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
        mock.method(promptDeps, "getSystemContent", () => "s".repeat(150_000));
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
        assert.deepStrictEqual(
          writes[0],
          `${PURPLE}No diff from reload${RESET}\n`,
        );
        const warningWrite = writes[1];
        assert(warningWrite !== undefined);
        assert.ok(
          warningWrite.startsWith(
            `${YELLOW}The current set of context, skills, and tools is 51.09% of the 100,000 token context window!`,
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
        mock.method(promptDeps, "getSystemContent", () => "s".repeat(150_000));
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
              "The current set of context, skills, and tools is 51.09% of the 100,000 token context window!",
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
          "- /edit\n- /editpage\n- /history\n- /clear\n- /paste\n- /model\n- /skills\n- /context\n- /commands\n- /keymaps\n- /usage\n- /tokens\n- /resume\n- /config\n- /reload\n- /initlocal\n- /initglobal\n- /lastresponse\n- /lastmessage\n- /lastdiff\n- /summaries\n- /tools\n- /test-cwd/.lasso/commands/known.md\n",
        ]);
      });
    });
  });

  describe("initLocalConfig and initGlobalConfig", () => {
    it("creates the local config in .lasso/settings.yaml", () => {
      actions.resetStdout();
      initLocalConfig();
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

    it("warns and does not overwrite when the local config already exists", () => {
      testFs._files.set("/test-cwd/.lasso/settings.yaml", "existing config");
      actions.resetStdout();
      initLocalConfig();
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}The local config already exists at /test-cwd/.lasso/settings.yaml${RESET}\n`,
      ]);
      assert.strictEqual(
        testFs._files.get("/test-cwd/.lasso/settings.yaml"),
        "existing config",
      );
    });

    it("warns when writing the local config fails", () => {
      mock.method(fsDeps, "writeFileSync", () => {
        throw new Error("write failed");
      });
      actions.resetStdout();
      initLocalConfig();
      assert.deepStrictEqual(getWrites(), [
        `${RED}Failed to write the config to /test-cwd/.lasso/settings.yaml${RESET}\n`,
      ]);
    });

    it("creates the global config in ~/.config/lasso/settings.yaml", () => {
      actions.resetStdout();
      initGlobalConfig();
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

    it("warns and does not overwrite when the global config already exists", () => {
      testFs._files.set(
        "/fake-home/.config/lasso/settings.yaml",
        "existing config",
      );
      actions.resetStdout();
      initGlobalConfig();
      assert.deepStrictEqual(getWrites(), [
        `${YELLOW}The global config already exists at /fake-home/.config/lasso/settings.yaml${RESET}\n`,
      ]);
      assert.strictEqual(
        testFs._files.get("/fake-home/.config/lasso/settings.yaml"),
        "existing config",
      );
    });

    it("warns when writing the global config fails", () => {
      mock.method(fsDeps, "writeFileSync", () => {
        throw new Error("write failed");
      });
      actions.resetStdout();
      initGlobalConfig();
      assert.deepStrictEqual(getWrites(), [
        `${RED}Failed to write the config to /fake-home/.config/lasso/settings.yaml${RESET}\n`,
      ]);
    });

    it("warns when the config directory cannot be created", () => {
      mock.method(fsDeps, "mkdirSync", () => {
        throw new Error("mkdir failed");
      });
      actions.resetStdout();
      initLocalConfig();
      assert.deepStrictEqual(getWrites(), [
        `${RED}Failed to create the directory: /test-cwd/.lasso${RESET}\n`,
      ]);
    });
  });
});
