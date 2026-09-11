import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { actions, getState, promptDeps } from "./state.ts";
import { getApproxTokens } from "./utils.ts";

import {
  parseInputFromEditor,
  resolveSlashCommand,
  resolveUserInput,
  shouldResolveSlashCommand,
  getModel,
  setModelCommand,
  isSameKey,
  clearCommand,
  printSkills,
  printAvailableContextFiles,
  pageContextStr,
  pageCustomSlashCommandsStr,
  pageEditStr,
  spawnAndReadEditorContent,
  resume,
  initSigInt,
  initLocalConfig,
  initGlobalConfig,
  pageHistory,
  pageLastResponse,
  resolveInterruptWithEditor,
} from "./input.ts";

function getTestRl() {
  const rl = getState().app.rl;
  assert(rl !== null);
  return rl;
}

import {
  testFs,
  testProcessEnv,
  setupTestContext,
  setupKeypressTests,
  makeFakeRl,
  mockClipboardPaste,
  mockExecCalls,
  mockSpawnSync,
  mockPagerSpawn,
  mockBatAvailable,
  batPagerCmd,
  stripAnsi,
  mockStdout,
} from "./test-helpers.ts";
import { fsDeps } from "./deps.ts";
import childProcess from "node:child_process";
import { getGlobalConfigPath, getGlobalContextDir } from "./paths.ts";

describe("input", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  let getCapturedStdout: () => string;

  beforeEach(() => {
    setupTestContext();
    getCapturedStdout = mockStdout();
  });

  describe("resolveInterruptWithEditor", () => {
    it("waits for enter and clears the interrupt controller", async () => {
      let questionOptions: { signal: AbortSignal } | undefined;
      actions.setRl(
        makeFakeRl({
          question: (_prompt: string, options: { signal: AbortSignal }) => {
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
    });

    it("returns normally when interrupted", async () => {
      actions.setRl(
        makeFakeRl({
          question: () => {
            const error = new Error("interrupted");
            error.name = "AbortError";
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

    it("returns null when writeFile fails", async () => {
      mock.method(fsDeps, "writeFileSync", () => {
        throw new Error("write failed");
      });
      const result = await spawnAndReadEditorContent();
      assert.strictEqual(result, null);
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
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
    });

    it("returns null when editor returns empty content", async () => {
      mock.method(childProcess, "spawnSync", () => {
        testFs.writeFileSync("/tmp/lasso-test-uuid.txt", "");
      });
      const result = await spawnAndReadEditorContent();
      assert.strictEqual(result, null);
    });

    it("returns normalized content", async () => {
      mock.method(childProcess, "spawnSync", () => {
        testFs.writeFileSync("/tmp/lasso-test-uuid.txt", "  hello  ");
      });
      const result = await spawnAndReadEditorContent();
      assert.strictEqual(result, "hello\n");
    });

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

    it("falls back to vi when no editor env vars are set", async () => {
      await spawnAndReadEditorContent();
      assert.strictEqual(spawned[0], "vi /tmp/lasso-test-uuid.txt");
    });

    it("returns normalized content when editor saves unchanged content", async () => {
      actions.setRl(makeFakeRl({ line: "hello" }));
      mock.method(childProcess, "spawnSync", () => {
        testFs.writeFileSync("/tmp/lasso-test-uuid.txt", "hello");
      });
      const result = await spawnAndReadEditorContent();
      assert.strictEqual(result, "hello\n");
    });

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
      assert.strictEqual(result, "hello world modified\n");
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
  });

  describe("resolveUserInput", () => {
    beforeEach(() => {
      actions.resetStdout();
      actions.setRl(makeFakeRl());
    });

    it("returns editor input value when set and clears it", async () => {
      actions.setChatHistoryPath("/tmp/test-history.log");
      actions.setEditorInputValue("editor content");
      const result = await resolveUserInput({ isFirstInput: false });
      assert.strictEqual(result, "editor content");
      assert.strictEqual(getState().app.editorInputValue, null);
      assert.strictEqual(
        testFs._files.get("/tmp/test-history.log"),
        `
1970-01-01T00:00:00.000Z  *user*
editor content

---
`,
      );
    });

    it("resolves slash commands from editor input", async () => {
      actions.setChatHistoryPath("/tmp/test-history.log");
      actions.setModel("old");
      actions.setEditorInputValue("/model new-model");
      const result = await resolveUserInput({ isFirstInput: false });
      assert.strictEqual(result, null);
      assert.strictEqual(getState().config.model, "new-model");
      assert.strictEqual(getState().app.editorInputValue, null);
      assert.strictEqual(
        testFs._files.get("/tmp/test-history.log"),
        `
1970-01-01T00:00:00.000Z  *user*
/model new-model

---
`,
      );
    });

    it("returns trimmed user input", async () => {
      mock.method(getTestRl(), "question", () => Promise.resolve("  hello  "));
      actions.setChatHistoryPath("/tmp/test-history.log");
      const result = await resolveUserInput({ isFirstInput: false });
      assert.strictEqual(result, "hello");
      assert.strictEqual(stripAnsi(getCapturedStdout()), "\n━━ Input ━━\n");
      assert.strictEqual(
        testFs._files.get("/tmp/test-history.log"),
        `
1970-01-01T00:00:00.000Z  *user*
hello

---
`,
      );
    });

    it("resolves slash commands when input starts with /", async () => {
      actions.setChatHistoryPath("/tmp/test-history.log");
      actions.setModel("old");
      actions.resetStdout();
      mock.method(getTestRl(), "question", () =>
        Promise.resolve("/model new-model"),
      );
      const result = await resolveUserInput({ isFirstInput: false });
      assert.strictEqual(result, null);
      assert.strictEqual(getState().config.model, "new-model");
      assert.strictEqual(
        testFs._files.get("/tmp/test-history.log"),
        `
1970-01-01T00:00:00.000Z  *user*
/model new-model

---
`,
      );
    });

    it("returns null and prints error on non-abort error", async () => {
      mock.method(getTestRl(), "question", () =>
        Promise.reject(new Error("read failed")),
      );
      const result = await resolveUserInput({ isFirstInput: false });
      assert.strictEqual(result, null);
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        `
━━ Input ━━
read failed
`,
      );
    });

    it("returns editor value when aborted by editor", async () => {
      actions.setChatHistoryPath("/tmp/test-history.log");
      mock.method(getTestRl(), "question", () => {
        actions.setEditorInputValue("from editor");
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      });
      const result = await resolveUserInput({ isFirstInput: false });
      assert.strictEqual(result, "from editor");
      assert.strictEqual(getState().app.editorInputValue, null);
      assert.strictEqual(
        testFs._files.get("/tmp/test-history.log"),
        `
1970-01-01T00:00:00.000Z  *user*
from editor

---
`,
      );
    });

    it("exits on abort during exit confirmation", async () => {
      mock.method(process, "exit", () => {
        throw new Error("process.exit called");
      });
      const questionMock = mock.method(getTestRl(), "question", () => {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      });
      await assert.rejects(
        resolveUserInput({ isFirstInput: false }),
        /process.exit called/,
      );
      assert.strictEqual(questionMock.mock.callCount(), 2);
    });

    it("returns null when user declines exit confirmation", async () => {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      const questionMock = mock.method(getTestRl(), "question", () =>
        Promise.resolve("n"),
      );
      questionMock.mock.mockImplementationOnce(() => Promise.reject(err));
      const result = await resolveUserInput({ isFirstInput: false });
      assert.strictEqual(result, null);
      assert.strictEqual(questionMock.mock.callCount(), 2);
    });

    it("exits when user confirms exit confirmation", async () => {
      mock.method(process, "exit", () => {
        throw new Error("process.exit called");
      });
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
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
      getCapturedStdout = mockStdout();
      mock.method(process, "exit", () => {
        throw new Error("process.exit called");
      });
      actions.setRl(makeFakeRl());
      actions.resetStdout();
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      const questionMock = mock.method(getTestRl(), "question", () =>
        Promise.resolve("yes"),
      );
      questionMock.mock.mockImplementationOnce(() => Promise.reject(err));
      await assert.rejects(
        resolveUserInput({ isFirstInput: false }),
        /process.exit called/,
      );
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        `
━━ Input ━━
Resume this session with /resume 42000
`,
      );
    });

    it("returns the first queued editor message and keeps the rest for the next iteration", async () => {
      actions.setChatHistoryPath("/tmp/test-history.log");
      actions.setEditorInputValue("first\nl---\nsecond\n");
      const result = await resolveUserInput({ isFirstInput: false });
      assert.strictEqual(result, "first\n");
      assert.strictEqual(getState().app.editorInputValue, "second\n");
      assert.strictEqual(
        testFs._files.get("/tmp/test-history.log"),
        `
1970-01-01T00:00:00.000Z  *user*
first

---
`,
      );
    });

    it("drains queued editor messages across iterations", async () => {
      actions.setChatHistoryPath("/tmp/test-history.log");
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

  describe("parseInputFromEditor", () => {
    beforeEach(() => {
      actions.setChatHistoryPath("/tmp/test-history.log");
    });

    it("returns the whole editor value and clears it when no delimiter is present", () => {
      actions.setEditorInputValue("editor content");
      const result = parseInputFromEditor();
      assert.strictEqual(result, "editor content");
      assert.strictEqual(getState().app.editorInputValue, null);
      assert.strictEqual(
        testFs._files.get("/tmp/test-history.log"),
        `
1970-01-01T00:00:00.000Z  *user*
editor content

---
`,
      );
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
      assert.strictEqual(
        testFs._files.get("/tmp/test-history.log"),
        `
1970-01-01T00:00:00.000Z  *user*
first

---
`,
      );
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
      assert.strictEqual(
        testFs._files.get("/tmp/test-history.log"),
        `
1970-01-01T00:00:00.000Z  *user*
message 2

---
`,
      );
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
      assert.strictEqual(getState().app.editorInputValue, "/model new-model\n");
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

  describe("shouldResolveSlashCommand", () => {
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
        shouldResolveSlashCommand("hello there", { forceKnownCommand: false }),
        false,
      );
    });

    it("returns false for multi-line input", () => {
      assert.strictEqual(
        shouldResolveSlashCommand("/cwd\n/pwd", { forceKnownCommand: false }),
        false,
      );
    });

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

  describe("setModelCommand", () => {
    beforeEach(() => {
      actions.resetStdout();
    });

    it("sets model and prints blue confirmation when input is valid", () => {
      actions.setModel("old-model");
      setModelCommand("/model new-model");
      assert.strictEqual(getState().config.model, "new-model");
      assert.strictEqual(getState().app.messageParams.tokensStale, true);
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "Model updated from `old-model` to `new-model`\n",
      );
    });

    it("prints red error when input has too many parts", () => {
      actions.setModel("old-model");
      setModelCommand("/model new-model extra");
      assert.strictEqual(getState().config.model, "old-model");
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "Usage: /model [model]?\n",
      );
    });

    it("prints red error when input has only the command", () => {
      actions.setModel("old-model");
      setModelCommand("/model");
      assert.strictEqual(getState().config.model, "old-model");
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "Usage: /model [model]?\n",
      );
    });

    it("handles model name with slashes", () => {
      actions.setModel("old");
      setModelCommand("/model provider/new-model");
      assert.strictEqual(getState().config.model, "provider/new-model");
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "Model updated from `old` to `provider/new-model`\n",
      );
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
  });

  describe("getModel", () => {
    beforeEach(() => {
      actions.resetStdout();
    });

    it("prints current model", () => {
      actions.setModel("gpt-4");
      getModel();
      assert.strictEqual(stripAnsi(getCapturedStdout()), "gpt-4\n");
    });
  });

  describe("clearCommand", () => {
    beforeEach(() => {
      actions.resetStdout();
    });

    it("resets params", () => {
      actions.appendToMessageParams({ role: "user", content: "hello" });
      mock.method(promptDeps, "getSystemContent", () => "abc");
      clearCommand();
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: getApproxTokens("abc"),
        tokensStale: false,
        messages: [],
      });
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "Context cleared (0 tokens in session)\n",
      );
    });
  });

  describe("resume", () => {
    beforeEach(() => {
      actions.resetStdout();
    });

    it("prints usage error when no session start date is provided", () => {
      const result = resume("/resume");
      assert.strictEqual(result, null);
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "Usage: /resume [session start date]\n",
      );
    });

    it("prints usage error when too many parts are provided", () => {
      const result = resume("/resume 123 456");
      assert.strictEqual(result, null);
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "Usage: /resume [session start date]\n",
      );
    });

    it("prints usage error when session start date is not a number", () => {
      const result = resume("/resume abc");
      assert.strictEqual(result, null);
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "Usage: /resume [session start date]\n",
      );
    });

    it("prints error when history directory does not exist", () => {
      const result = resume("/resume 1234567890000");
      assert.strictEqual(result, null);
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "No conversation found with session start date: 1234567890000\n",
      );
    });

    it("returns transcript and resets message params when conversation is found", () => {
      actions.appendToMessageParams({ role: "user", content: "hello" });
      testFs._dirs.add("/fake-home/.config/lasso/history");
      testFs._files.set(
        "/fake-home/.config/lasso/history/chat-history-1234567890000.md",
        "transcript content",
      );
      const result = resume("/resume 1234567890000");
      assert.strictEqual(
        result,
        `Continue the conversation recorded in the transcript below. Respond to this message with "Ready to continue chatting."
Transcript:
transcript content
    `,
      );
      assert.deepStrictEqual(getState().app.messageParams, {
        tokens: 0,
        tokensStale: false,
        messages: [],
      });
    });

    it("prints error when no conversation is found", () => {
      testFs._dirs.add("/fake-home/.config/lasso/history");
      testFs._files.set(
        "/fake-home/.config/lasso/history/chat-history-9999999999999.md",
        "transcript content",
      );
      const result = resume("/resume 1234567890000");
      assert.strictEqual(result, null);
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "No conversation found with session start date: 1234567890000\n",
      );
    });

    it("skips files that do not match the chat-history format", () => {
      testFs._dirs.add("/fake-home/.config/lasso/history");
      testFs._files.set(
        "/fake-home/.config/lasso/history/other-1234567890000.md",
        "other",
      );
      const result = resume("/resume 1234567890000");
      assert.strictEqual(result, null);
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "No conversation found with session start date: 1234567890000\n",
      );
    });
  });

  describe("pageContextStr", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("prints no available context files when entries list is empty", async () => {
      await pageContextStr();
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "No available context files\n",
      );
    });

    it("opens context string in a pager via LASSO_PAGER_CONTEXT", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER_CONTEXT", "nano __FILE__");
      actions.setContextStr("context string content");
      actions.setContextEntries([
        { filePath: "/project/AGENTS.md", content: "context" },
      ]);
      await pageContextStr();
      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
    });

    it("copies context string into the temp file", async () => {
      actions.setContextStr("context string content");
      actions.setContextEntries([
        { filePath: "/project/AGENTS.md", content: "context" },
      ]);
      await pageContextStr();
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `context string content`,
      );
      assert.strictEqual(getCapturedStdout(), "");
    });
  });

  describe("pageHistory", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
      actions.setChatHistoryPath("/tmp/test-history.log");
    });

    it("prints that history is empty when the chat history file does not exist", async () => {
      await pageHistory();
      assert.strictEqual(stripAnsi(getCapturedStdout()), "No chat history\n");
    });

    it("prints that history is empty when the chat history file is empty", async () => {
      testFs._files.set("/tmp/test-history.log", "");
      await pageHistory();
      assert.strictEqual(stripAnsi(getCapturedStdout()), "No chat history\n");
    });

    it("opens the chat history in a pager with a heading prepended", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER_HISTORY", "nano __FILE__");
      testFs._files.set("/tmp/test-history.log", "log content");
      await pageHistory();
      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Chat history

log content`,
      );
    });
  });

  describe("pageLastResponse", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("prints no messages when there is no assistant response", async () => {
      await pageLastResponse();
      assert.strictEqual(stripAnsi(getCapturedStdout()), "No messages\n");
    });

    it("opens the latest assistant response in a pager", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER_LAST_RESPONSE", "nano __FILE__");
      actions.appendToMessageParams({ role: "user", content: "question" });
      actions.appendToMessageParams({
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      });

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

  describe("pageEditStr", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("prints that the editor is empty when editor input is null", async () => {
      await pageEditStr();
      assert.strictEqual(stripAnsi(getCapturedStdout()), "Editor is empty\n");
    });
  });

  describe("pageCustomSlashCommandsStr", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("prints no available custom slash commands when list is empty", async () => {
      await pageCustomSlashCommandsStr();
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "No available custom slash commands\n",
      );
    });

    it("opens custom commands in a pager via LASSO_PAGER_COMMANDS", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER_COMMANDS", "nano __FILE__");
      actions.setSlashCommands([
        {
          name: "custom",
          filePath: "/test/.lasso/commands/custom.md",
          content: "custom command content",
        },
      ]);
      await pageCustomSlashCommandsStr();
      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
    });
  });

  describe("printSkills", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("prints available skills", () => {
      actions.setSkills([
        {
          name: "test-skill",
          description: "A test skill",
          dir: "/skills/test-skill",
          content: "skill content",
        },
      ]);
      printSkills();
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        `
Available skills:
- test-skill: A test skill
  /skills/test-skill
`,
      );
    });

    it("prints no available skills when skills list is empty", () => {
      printSkills();
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        `
No available skills
`,
      );
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
      printSkills();
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        `
Available skills:
- real-skill: A real skill
  /skills/real
`,
      );
    });
  });

  describe("printAvailableContextFiles", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("prints available context files", () => {
      actions.setContextEntries([
        { filePath: "/project/AGENTS.md", content: "context" },
      ]);
      printAvailableContextFiles();
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        `
Available context files:
- /project/AGENTS.md
`,
      );
    });

    it("prints no available context files when entries list is empty", () => {
      printAvailableContextFiles();
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        `
No available context files
`,
      );
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
      printAvailableContextFiles();
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        `
Available context files:
- /project/AGENTS.md
- /other/AGENTS.md (as a skill)
`,
      );
    });
  });

  describe("printAvailableCommandsStr", () => {
    beforeEach(() => {
      actions.resetState();
      actions.resetStdout();
    });

    it("prints builtin and custom commands", async () => {
      actions.setSlashCommands([
        {
          name: "custom.md",
          filePath: "/test/.lasso/commands/custom.md",
          content: "custom",
        },
      ]);
      await resolveSlashCommand("/commands");
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        `
Available commands:
- /edit
- /editpage
- /history
- /clear
- /paste
- /model
- /skills
- /context
- /contextpage
- /commands
- /commandspage
- /keymaps
- /usage
- /resume
- /config
- /reload
- /initlocal
- /initglobal
- /lastresponse
- /test/.lasso/commands/custom.md
`,
      );
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
      actions.setKeymap("custom", { name: "c", ctrl: true });
      harness = setupKeypressTests();
    });

    afterEach(() => {
      harness.cleanup();
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

    it("does nothing on unmatched keys", () => {
      harness.emitKey({ name: "x", ctrl: true });
      assert.deepStrictEqual(harness.writes, []);
    });

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
      assert.strictEqual(getState().app.editorInputValue, "edited\n");
    });

    it("runs paste command with clipboard when its keymap matches", async () => {
      actions.setKeymap("paste", { name: "v", ctrl: true });
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
        "hello world modified\n",
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

    it("opens chat history in a pager when history keymap matches", async () => {
      const prompts: boolean[] = [];
      mock.method(harness.rl, "prompt", (arg: boolean) => {
        prompts.push(arg);
      });
      const { spawned } = mockPagerSpawn();
      mockBatAvailable(true);
      actions.setKeymap("history", { name: "h", ctrl: true });
      actions.setChatHistoryPath("/tmp/editor.log");
      testFs._files.set("/tmp/editor.log", "log content");
      harness.emitKey({ name: "h", ctrl: true });
      await harness.flush();
      assert.strictEqual(spawned[0], batPagerCmd("/tmp/lasso-test-uuid.txt"));
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Chat history

log content`,
      );
      assert.strictEqual(getCapturedStdout(), "");
      assert.deepStrictEqual(prompts, [true]);
    });

    it("does not redraw the prompt after paging chat history without a pending question", async () => {
      const prompts: boolean[] = [];
      mock.method(harness.rl, "prompt", (arg: boolean) => {
        prompts.push(arg);
      });
      const { spawned } = mockPagerSpawn();
      mockBatAvailable(true);
      actions.setQuestionAbortController(null);
      actions.setKeymap("history", { name: "h", ctrl: true });
      actions.setChatHistoryPath("/tmp/editor.log");
      testFs._files.set("/tmp/editor.log", "log content");
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
      testProcessEnv._set("LASSO_PAGER_LAST_RESPONSE", "nano __FILE__");
      actions.setKeymap("lastresponse", { name: "u", ctrl: true });
      actions.appendToMessageParams({ role: "user", content: "question" });
      actions.appendToMessageParams({
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      });
      harness.emitKey({ name: "u", ctrl: true });
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
      testProcessEnv._set("LASSO_PAGER_RELOAD", "cat __FILE__");
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
      actions.setKeymap("reload", { name: "w", ctrl: true });
      harness.emitKey({ name: "w", ctrl: true });
      await harness.flush();
      assert.deepStrictEqual(prompts, [true]);
      assert.notStrictEqual(spawned.length, 0);
    });

    it("opens editor input in a pager when editpage keymap matches", async () => {
      const prompts: boolean[] = [];
      mock.method(harness.rl, "prompt", (arg: boolean) => {
        prompts.push(arg);
      });
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "cat __FILE__");
      actions.setKeymap("editpage", { name: "e", ctrl: true });
      actions.setEditorInputValue("editor input");
      harness.emitKey({ name: "e", ctrl: true });
      await harness.flush();
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        "editor input",
      );
      assert.strictEqual(getCapturedStdout(), "");
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
      actions.setKeymap("config", { name: "q", ctrl: true });
      harness.emitKey({ name: "q", ctrl: true });
      await harness.flush();
      assert.match(
        testFs._files.get("/tmp/lasso-test-uuid.txt") ?? "",
        /# Applied config/,
      );
      assert.strictEqual(getCapturedStdout(), "");
      assert.deepStrictEqual(prompts, [true]);
      assert.deepStrictEqual(spawned, ["cat /tmp/lasso-test-uuid.txt"]);
    });

    it("opens context in a pager when contextpage keymap matches", async () => {
      const prompts: boolean[] = [];
      mock.method(harness.rl, "prompt", (arg: boolean) => {
        prompts.push(arg);
      });
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "cat __FILE__");
      actions.setKeymap("contextpage", { name: "d", ctrl: true });
      actions.setContextEntries([
        { filePath: "/project/AGENTS.md", content: "context" },
      ]);
      actions.setContextStr("context string content");
      harness.emitKey({ name: "d", ctrl: true });
      await harness.flush();
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `context string content`,
      );
      assert.strictEqual(getCapturedStdout(), "");
      assert.deepStrictEqual(prompts, [true]);
      assert.deepStrictEqual(spawned, ["cat /tmp/lasso-test-uuid.txt"]);
    });

    it("opens custom commands in a pager when commandspage keymap matches", async () => {
      const prompts: boolean[] = [];
      mock.method(harness.rl, "prompt", (arg: boolean) => {
        prompts.push(arg);
      });
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER", "cat __FILE__");
      actions.setKeymap("commandspage", { name: "m", ctrl: true });
      harness.emitKey({ name: "m", ctrl: true });
      await harness.flush();
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Slash commands:

## /test/.lasso/commands/custom.md

custom command content`,
      );
      assert.strictEqual(getCapturedStdout(), "");
      assert.deepStrictEqual(prompts, [true]);
      assert.deepStrictEqual(spawned, ["cat /tmp/lasso-test-uuid.txt"]);
    });

    for (const [command, keyName] of [
      ["clear", "k"],
      ["model", "m"],
      ["skills", "l"],
      ["context", "n"],
      ["commands", "o"],
      ["keymaps", "p"],
      ["usage", "u"],
      ["resume", "r"],
    ] as const) {
      it(`types /${command} into the prompt when its keymap matches`, () => {
        actions.setKeymap(command, { name: keyName, ctrl: true });
        harness.emitKey({ name: keyName, ctrl: true });
        assert.deepStrictEqual(harness.writes, [
          { chunk: `/${command}\n`, key: undefined },
        ]);
      });
    }

    it("does not type builtin command when no question is pending", () => {
      actions.setKeymap("clear", { name: "k", ctrl: true });
      actions.setQuestionAbortController(null);
      harness.emitKey({ name: "k", ctrl: true });
      assert.deepStrictEqual(harness.writes, []);
    });

    it("uses the first matching builtin keymap when commands share a key", () => {
      actions.setKeymap("clear", { name: "x", ctrl: true });
      actions.setKeymap("skills", { name: "x", ctrl: true });
      harness.emitKey({ name: "x", ctrl: true });
      assert.deepStrictEqual(harness.writes, [
        { chunk: "/clear\n", key: undefined },
      ]);
    });

    it("prefers builtin commands over custom commands on the same key", () => {
      actions.setKeymap("clear", { name: "c", ctrl: true });
      harness.emitKey({ name: "c", ctrl: true });
      assert.deepStrictEqual(harness.writes, [
        { chunk: "/clear\n", key: undefined },
      ]);
    });

    it("clears the line on unmatched keys during loading", () => {
      actions.setLoadingStateTimeout({} as NodeJS.Timeout);
      harness.emitKey({ name: "z", ctrl: true });
      assert.deepStrictEqual(harness.writes, [
        { chunk: null, key: { ctrl: true, name: "u" } },
      ]);
      assert.strictEqual(getCapturedStdout(), "");
    });

    it("types keymap command while loading when a question is pending", () => {
      actions.setKeymap("clear", { name: "k", ctrl: true });
      actions.setLoadingStateTimeout({} as NodeJS.Timeout);
      harness.emitKey({ name: "k", ctrl: true });
      assert.deepStrictEqual(harness.writes, [
        { chunk: "/clear\n", key: undefined },
      ]);
    });

    it("does not clear the line for matched keys during loading", () => {
      actions.setKeymap("clear", { name: "k", ctrl: true });
      actions.setQuestionAbortController(null);
      actions.setLoadingStateTimeout({} as NodeJS.Timeout);
      harness.emitKey({ name: "k", ctrl: true });
      assert.strictEqual(getCapturedStdout(), "");
      assert.deepStrictEqual(harness.writes, []);
    });
  });

  describe("isSameKey", () => {
    it("returns true when all fields match", () => {
      assert.equal(
        isSameKey(
          { name: "e", ctrl: true, meta: false, shift: false },
          { name: "e", ctrl: true, meta: false, shift: false },
        ),
        true,
      );
    });

    it("returns false when name differs", () => {
      assert.equal(
        isSameKey(
          { name: "e", ctrl: true, meta: false, shift: false },
          { name: "x", ctrl: true, meta: false, shift: false },
        ),
        false,
      );
    });

    it("returns false when ctrl differs", () => {
      assert.equal(
        isSameKey(
          { name: "e", ctrl: true, meta: false, shift: false },
          { name: "e", ctrl: false, meta: false, shift: false },
        ),
        false,
      );
    });

    it("returns false when meta differs", () => {
      assert.equal(
        isSameKey(
          { name: "x", ctrl: false, meta: true, shift: false },
          { name: "x", ctrl: false, meta: false, shift: false },
        ),
        false,
      );
    });

    it("returns false when shift differs", () => {
      assert.equal(
        isSameKey(
          { name: "x", ctrl: false, meta: false, shift: true },
          { name: "x", ctrl: false, meta: false, shift: false },
        ),
        false,
      );
    });
  });

  describe("resolveSlashCommand", () => {
    beforeEach(() => {
      actions.setRl(makeFakeRl({ line: "" }));
      mockSpawnSync();
    });

    it("handles /edit command", async () => {
      const result = await resolveSlashCommand("/edit");
      assert.strictEqual(result, null);
    });

    it("handles /editpage command by opening the current editor input in a pager", async () => {
      testProcessEnv._set("LASSO_PAGER_EDIT", "nano __FILE__");
      actions.setEditorInputValue("editor input");
      const result = await resolveSlashCommand("/editpage");
      assert.strictEqual(result, null);
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        "editor input",
      );
    });

    it("handles /edit command and logs editor content to chat history", async () => {
      actions.setChatHistoryPath("/tmp/test-history.log");
      mock.method(childProcess, "spawnSync", () => {
        testFs.writeFileSync("/tmp/lasso-test-uuid.txt", "from editor");
      });
      const result = await resolveSlashCommand("/edit");
      assert.strictEqual(result, "from editor\n");
      assert.strictEqual(
        testFs._files.get("/tmp/test-history.log"),
        `
1970-01-01T00:00:00.000Z  *user*
from editor

---
`,
      );
    });

    it("handles /paste command and logs editor content to chat history", async () => {
      actions.setChatHistoryPath("/tmp/test-history.log");
      mockClipboardPaste("clip");
      mock.method(childProcess, "spawnSync", () => {
        testFs.writeFileSync("/tmp/lasso-test-uuid.txt", "pasted content");
      });
      const result = await resolveSlashCommand("/paste");
      assert.strictEqual(result, "pasted content\n");
      assert.strictEqual(
        testFs._files.get("/tmp/test-history.log"),
        `
1970-01-01T00:00:00.000Z  *user*
pasted content

---
`,
      );
    });

    it("handles /clear command", async () => {
      const result = await resolveSlashCommand("/clear");
      assert.strictEqual(result, null);
    });

    it("handles /history command by opening chat history in a pager", async () => {
      testProcessEnv._set("LASSO_PAGER_HISTORY", "nano __FILE__");
      actions.setChatHistoryPath("/tmp/test-history.log");
      testFs._files.set("/tmp/test-history.log", "log content");
      const result = await resolveSlashCommand("/history");
      assert.strictEqual(result, null);
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Chat history

log content`,
      );
    });

    it("handles /model command", async () => {
      actions.setModel("old");
      actions.resetStdout();
      const result = await resolveSlashCommand("/model new-model");
      assert.strictEqual(result, null);
      assert.strictEqual(getState().config.model, "new-model");
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "Model updated from `old` to `new-model`\n",
      );
    });

    it("handles /model without args", async () => {
      actions.setModel("gpt-4");
      actions.resetStdout();
      const result = await resolveSlashCommand("/model");
      assert.strictEqual(result, null);
      assert.strictEqual(stripAnsi(getCapturedStdout()), "gpt-4\n");
    });

    it("handles /skills command", async () => {
      actions.resetStdout();
      const result = await resolveSlashCommand("/skills");
      assert.strictEqual(result, null);
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        `
No available skills
`,
      );
    });

    it("handles /context command", async () => {
      actions.resetStdout();
      const result = await resolveSlashCommand("/context");
      assert.strictEqual(result, null);
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        `
No available context files
`,
      );
    });

    it("handles /commands command by printing commands", async () => {
      actions.resetStdout();
      const result = await resolveSlashCommand("/commands");
      assert.strictEqual(result, null);
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        `
Available commands:
- /edit
- /editpage
- /history
- /clear
- /paste
- /model
- /skills
- /context
- /contextpage
- /commands
- /commandspage
- /keymaps
- /usage
- /resume
- /config
- /reload
- /initlocal
- /initglobal
- /lastresponse
`,
      );
    });

    it("handles /commandspage command by opening custom commands in a pager", async () => {
      testProcessEnv._set("LASSO_PAGER_COMMANDS", "nano __FILE__");
      actions.setSlashCommands([
        {
          name: "custom",
          filePath: "/test/.lasso/commands/custom.md",
          content: "custom command content",
        },
      ]);
      const result = await resolveSlashCommand("/commandspage");
      assert.strictEqual(result, null);
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `# [lasso] Slash commands:

## /test/.lasso/commands/custom.md

custom command content`,
      );
    });

    it("uses LASSO_PAGER_COMMANDS for the commandspage pager", async () => {
      const { spawned } = mockPagerSpawn();
      testProcessEnv._set("LASSO_PAGER_COMMANDS", "nano __FILE__");
      actions.setSlashCommands([
        {
          name: "custom",
          filePath: "/test/.lasso/commands/custom.md",
          content: "custom command content",
        },
      ]);
      const result = await resolveSlashCommand("/commandspage");
      assert.strictEqual(result, null);
      assert.strictEqual(spawned[0], "nano /tmp/lasso-test-uuid.txt");
    });

    it("prints message for commandspage when there are no custom commands", async () => {
      actions.resetStdout();
      const result = await resolveSlashCommand("/commandspage");
      assert.strictEqual(result, null);
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "No available custom slash commands\n",
      );
    });

    it("handles /contextpage command with no context files", async () => {
      actions.resetStdout();
      const result = await resolveSlashCommand("/contextpage");
      assert.strictEqual(result, null);
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "No available context files\n",
      );
    });

    it("handles /contextpage command by opening context in a pager", async () => {
      testProcessEnv._set("LASSO_PAGER_CONTEXT", "nano __FILE__");
      actions.setContextStr("context string content");
      actions.setContextEntries([
        { filePath: "/project/AGENTS.md", content: "context" },
      ]);
      const result = await resolveSlashCommand("/contextpage");
      assert.strictEqual(result, null);
      assert.strictEqual(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        `context string content`,
      );
    });

    it("handles /config command by opening combined config in a pager", async () => {
      testProcessEnv._set("LASSO_PAGER_CONFIG", "nano __FILE__");
      actions.resetStdout();
      const result = await resolveSlashCommand("/config");
      assert.strictEqual(result, null);
      assert.strictEqual(stripAnsi(getCapturedStdout()), "");
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
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        `
Keymaps:
- edit: {"name":"g","ctrl":true}
`,
      );
    });

    it("handles /usage command", async () => {
      actions.resetStdout();
      actions.setModel("unknown-model");
      const result = await resolveSlashCommand("/usage");
      assert.strictEqual(result, null);
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "0 tokens in session\n",
      );
    });

    it("handles /usage command with context window usage", async () => {
      actions.resetStdout();
      actions.setModel("test-model");
      actions.setContextWindowPerModel({ "test-model": 10_000 });
      actions.appendToMessageParams({ role: "user", content: "hi" });
      actions.setMessageParamTokens(5_000);
      const result = await resolveSlashCommand("/usage");
      assert.strictEqual(result, null);
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "0 tokens in session, 50% of context window\n",
      );
    });

    it("handles /resume without args", async () => {
      actions.resetStdout();
      const result = await resolveSlashCommand("/resume");
      assert.strictEqual(result, null);
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "Usage: /resume [session start date]\n",
      );
    });

    it("handles /resume with a session start date", async () => {
      testFs._dirs.add("/fake-home/.config/lasso/history");
      testFs._files.set(
        "/fake-home/.config/lasso/history/chat-history-1234567890000.md",
        "transcript content",
      );
      const result = await resolveSlashCommand("/resume 1234567890000");
      assert.strictEqual(
        result,
        `Continue the conversation recorded in the transcript below. Respond to this message with "Ready to continue chatting."
Transcript:
transcript content
    `,
      );
    });

    it("handles /reload command by opening the config diff in a pager", async () => {
      testFs._files.set(
        getGlobalConfigPath(),
        JSON.stringify({
          model: "gpt-4",
          baseURL: "https://api.example.com",
        }),
      );
      testProcessEnv._set("LASSO_PAGER_RELOAD", "cat __FILE__");
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
    });

    it("only includes nonempty config diffs", async () => {
      testProcessEnv._set("LASSO_PAGER_RELOAD", "cat __FILE__");
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
                testFs._files.get(`/tmp/lasso-${prefix}-after-test-uuid.txt`) ??
                  "",
              );
            }
          }
        },
      );

      testProcessEnv._set("LASSO_PAGER_RELOAD", "cat __FILE__");

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
        `Follow the instructions below along with the provided context:
## [lasso] Instructions
custom command content

## [lasso] Context
some task
  `,
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
        `Follow the instructions below along with the provided context:
## [lasso] Instructions
custom command content

## [lasso] Context
some   task
  `,
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
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        `
Invalid command: /unknown, valid commands:
- /edit
- /editpage
- /history
- /clear
- /paste
- /model
- /skills
- /context
- /contextpage
- /commands
- /commandspage
- /keymaps
- /usage
- /resume
- /config
- /reload
- /initlocal
- /initglobal
- /lastresponse
- /test-cwd/.lasso/commands/known.md
`,
      );
    });
  });

  describe("initLocalConfig and initGlobalConfig", () => {
    it("creates the local config in .lasso/settings.yaml", () => {
      actions.resetStdout();
      initLocalConfig();
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "Created the local config at /test-cwd/.lasso/settings.yaml\n",
      );
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
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "The local config already exists at /test-cwd/.lasso/settings.yaml\n",
      );
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
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "Failed to write the config to /test-cwd/.lasso/settings.yaml\n",
      );
    });

    it("creates the global config in ~/.config/lasso/settings.yaml", () => {
      actions.resetStdout();
      initGlobalConfig();
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "Created the global config at /fake-home/.config/lasso/settings.yaml\n",
      );
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
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "The global config already exists at /fake-home/.config/lasso/settings.yaml\n",
      );
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
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "Failed to write the config to /fake-home/.config/lasso/settings.yaml\n",
      );
    });

    it("warns when the config directory cannot be created", () => {
      mock.method(fsDeps, "mkdirSync", () => {
        throw new Error("mkdir failed");
      });
      actions.resetStdout();
      initLocalConfig();
      assert.strictEqual(
        stripAnsi(getCapturedStdout()),
        "Failed to create the directory: /test-cwd/.lasso\n",
      );
    });
  });
});
