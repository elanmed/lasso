import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert, { AssertionError } from "node:assert/strict";
import {
  createParallelPerformanceLogger,
  createPerformanceLogger,
  startLoadingState,
  stopLoadingState,
  colorPrint,
  printSessionStartDate,
  printNewline,
  successWithSpacing,
  errorWithSpacing,
  truncate,
  getUnicodeChar,
  getTempFileName,
  executeBat,
  formatMarkdown,
  execGitDiff,
  createFencePrint,
} from "./printing.ts";

import { wrapInColor, bold } from "./utils.ts";
import { actions, getState } from "./state.ts";
import {
  setupTestContext,
  testFs,
  mockStdoutWrites,
  BLUE,
  RESET,
  testProcessEnv,
  CLEAR_LINE,
  CR,
  DOWN_1,
  DOWN_2,
  GREEN,
  PURPLE,
  RED,
  UP_1,
  UP_2,
  mockSetInterval,
  mockClearInterval,
  GREY,
  BOLD,
  BOLD_RESET,
  mockExecCalls,
  makeInvalidString,
  mockSpawnSync,
} from "./test-helpers.ts";
import { processDeps, fsDeps } from "./deps.ts";
import { getPrettyApiDuration } from "./app.ts";
import { getPrettyContextWindowUsage } from "./tokens.ts";
import { getPrettyTokenUsage } from "./usage.ts";

const fencePrint = createFencePrint({
  sessionInfoSegments: [
    () => getPrettyApiDuration(),
    () => getPrettyTokenUsage(),
    () => getPrettyContextWindowUsage(),
  ],
});

describe("print", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  describe("startLoadingState", () => {
    it("writes loadingStateFrames cyclically", () => {
      actions.resetState();
      const callbacks = mockSetInterval();
      mockClearInterval(callbacks);
      actions.setLoadingStateFrames(["a", "b", "c"]);

      const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });

      startLoadingState();
      callbacks.forEach((cb) => cb());
      callbacks.forEach((cb) => cb());
      callbacks.forEach((cb) => cb());
      callbacks.forEach((cb) => cb());
      stopLoadingState();

      assert.deepStrictEqual(getWrites(), [
        "\ra",
        "\rb",
        "\rc",
        "\ra",
        "\rb",
        "\r \r",
      ]);
    });

    it("uses default loadingStateFrames when none set", () => {
      actions.resetState();
      const callbacks = mockSetInterval();
      mockClearInterval(callbacks);

      const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });

      startLoadingState();
      callbacks.forEach((cb) => cb());
      callbacks.forEach((cb) => cb());
      stopLoadingState();

      assert.deepStrictEqual(getWrites(), ["\r|", "\r/", "\r-", "\r \r"]);
    });

    it("stopLoadingState gracefully handles multiple calls", () => {
      actions.resetState();
      const callbacks = mockSetInterval();
      mockClearInterval(callbacks);
      mockStdoutWrites();
      actions.setLoadingStateFrames(["a", "b", "c"]);

      startLoadingState();
      callbacks.forEach((cb) => cb());

      const stop1 = stopLoadingState();
      const stop2 = stopLoadingState();
      assert.strictEqual(stop1, stop2);
    });

    it("serializes concurrent colorPrint calls", async () => {
      actions.resetState();
      const callbacks = mockSetInterval();
      mockClearInterval(callbacks);
      const getWrites = mockStdoutWrites();
      actions.setLoadingStateFrames(["a", "b", "c"]);

      startLoadingState();
      callbacks.forEach((cb) => cb());

      colorPrint("X", "none");
      colorPrint("Y", "none");
      colorPrint("Z", "none");

      await Promise.resolve();

      assert.deepStrictEqual(getWrites(), ["X\n", "Y\n", "Z\n"]);
    });
  });

  describe("createPerformanceLogger", () => {
    it("prints the label when starting and the colored duration when ending", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      const logger = createPerformanceLogger({ logDuration: true });
      const getWrites = mockStdoutWrites();
      logger.start("Reading context files: ");
      assert.deepStrictEqual(getWrites(), [
        `${BLUE}Reading context files: ${RESET}`,
      ]);
      mock.method(process.hrtime, "bigint", () => BigInt(1_234_567_890));

      logger.end();

      assert.deepStrictEqual(getWrites(), [
        `${BLUE}Reading context files: ${RESET}`,
        `${GREEN}234.567ms${RESET}\n`,
      ]);
    });

    it("can start again after end", () => {
      let callIdx = 0;
      const values = [
        1_000_000_000, 1_000_000_000, 2_000_000_000, 3_000_000_000,
      ];
      mock.method(process.hrtime, "bigint", () =>
        BigInt(values[callIdx++] ?? 0),
      );
      const logger = createPerformanceLogger({ logDuration: true });
      const getWrites = mockStdoutWrites();

      logger.start("a: ");
      logger.end();
      logger.start("a: ");
      logger.end();

      assert.deepStrictEqual(getWrites(), [
        `${BLUE}a: ${RESET}`,
        `${GREEN}0.0ms${RESET}\n`,
        `${BLUE}a: ${RESET}`,
        `${RED}1s 0.0ms${RESET}\n`,
      ]);
    });

    it("does nothing when logDuration is false", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      const logger = createPerformanceLogger({ logDuration: false });
      const getWrites = mockStdoutWrites();
      logger.start("a: ");
      logger.end();
      assert.deepStrictEqual(getWrites(), []);
    });

    it("throws when started twice", () => {
      const logger = createPerformanceLogger({ logDuration: true });
      logger.start("a: ");
      assert.throws(() => logger.start("a: "));
    });

    it("throws when ended without start", () => {
      const logger = createPerformanceLogger({ logDuration: true });
      assert.throws(() => logger.end());
    });
  });

  describe("createParallelPerformanceLogger", () => {
    it("prints every label on its own line upfront", () => {
      const logger = createParallelPerformanceLogger({
        logDuration: true,
        logIdToLabel: [
          ["a", "Starting a: "],
          ["b", "Starting b: "],
        ],
      });
      const getWrites = mockStdoutWrites();

      logger.printAllLabels();

      assert.deepStrictEqual(getWrites(), [
        `${BLUE}Starting a: ${RESET}\n`,
        `${BLUE}Starting b: ${RESET}\n`,
      ]);
    });

    it("rewrites each label in place with its duration", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      const logger = createParallelPerformanceLogger({
        logDuration: true,
        logIdToLabel: [
          ["a", "Starting a: "],
          ["b", "Starting b: "],
        ],
      });
      const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });

      logger.printAllLabels();
      logger.start("a");
      mock.method(process.hrtime, "bigint", () => BigInt(1_234_567_890));
      logger.end("a");
      logger.start("b");
      mock.method(process.hrtime, "bigint", () => BigInt(2_234_567_890));
      logger.end("b");

      assert.deepStrictEqual(getWrites(), [
        `${BLUE}Starting a: ${RESET}\n`,
        `${BLUE}Starting b: ${RESET}\n`,
        `${UP_2}${CLEAR_LINE}${CR}`,
        `${BLUE}Starting a: ${RESET}`,
        `${GREEN}234.567ms${RESET}`,
        `${DOWN_2}${CR}`,
        `${UP_1}${CLEAR_LINE}${CR}`,
        `${BLUE}Starting b: ${RESET}`,
        `${RED}1s 0.0ms${RESET}`,
        `${DOWN_1}${CR}`,
      ]);
    });

    it("does nothing when logDuration is false", () => {
      const logger = createParallelPerformanceLogger({
        logDuration: false,
        logIdToLabel: [["a", "Starting a: "]],
      });
      const getWrites = mockStdoutWrites();

      logger.printAllLabels();
      logger.start("a");
      logger.end("a");

      assert.deepStrictEqual(getWrites(), []);
    });

    it("throws when ended without start", () => {
      const logger = createParallelPerformanceLogger({
        logDuration: true,
        logIdToLabel: [["a", "Starting a: "]],
      });
      assert.throws(() => logger.end("a"));
    });
  });

  describe("appendNewline", () => {
    it("appends a newline by default", () => {
      const getWrites = mockStdoutWrites();
      colorPrint("hello", "none");
      assert.deepStrictEqual(getWrites(), ["hello\n"]);
    });

    it("omits the newline when appendNewline is false", () => {
      const getWrites = mockStdoutWrites();
      colorPrint("hello", "none", { appendNewline: false });
      assert.deepStrictEqual(getWrites(), ["hello"]);
    });

    it("keeps color codes around the text without a trailing newline", () => {
      const getWrites = mockStdoutWrites();
      colorPrint("hello", "blue", { appendNewline: false });
      assert.deepStrictEqual(getWrites(), [`${BLUE}hello${RESET}`]);
    });
  });

  describe("whileBuffering", () => {
    it("writes to stdout directly while a non-blocking process is ongoing", () => {
      actions.setIsNonBlockingProcessOngoing(true);
      const getWrites = mockStdoutWrites();
      colorPrint("hello", "blue", { whileBuffering: true });
      assert.deepStrictEqual(getWrites(), [`${BLUE}hello${RESET}\n`]);
      assert.deepStrictEqual(
        getState().terminal.bufferedStdoutWhileEditorOpen,
        "",
      );
    });

    it("writes to stdout directly while a loading state is active", () => {
      actions.setLoadingStateTimeout({} as NodeJS.Timeout);
      const getWrites = mockStdoutWrites();
      colorPrint("hello", "blue", { whileBuffering: true });
      assert.deepStrictEqual(getWrites(), [`${BLUE}hello${RESET}\n`]);
    });
  });

  describe("color disabled", () => {
    it("omits ansi codes when NO_COLOR is set", () => {
      testProcessEnv._set("NO_COLOR", "1");
      const getWrites = mockStdoutWrites();
      colorPrint("hello", "blue");
      assert.deepStrictEqual(getWrites(), ["hello\n"]);
      assert.equal(bold("hello"), "hello");
    });

    it("omits ansi codes when stdout is not a tty", () => {
      mock.method(processDeps.stdout, "isTTY", () => false);
      const getWrites = mockStdoutWrites();
      colorPrint("hello", "blue");
      assert.deepStrictEqual(getWrites(), ["hello\n"]);
    });
  });

  describe("wrapInColor", () => {
    it("wraps the text in color codes", () => {
      assert.strictEqual(wrapInColor("hello", "blue"), `${BLUE}hello${RESET}`);
    });

    it("returns the text unchanged for none", () => {
      assert.strictEqual(wrapInColor("hello", "none"), "hello");
    });
  });

  describe("printNewline", () => {
    it("prints nothing when stdoutTail already ends with two newlines", () => {
      const getWrites = mockStdoutWrites();
      actions.appendStdoutTail("\n\n");
      printNewline();
      assert.deepStrictEqual(getWrites(), []);
    });

    it("appends a newline when stdoutTail does not end with two newlines", () => {
      const getWrites = mockStdoutWrites();
      colorPrint("a", "none", { appendNewline: false });
      printNewline();
      assert.deepStrictEqual(getWrites(), ["a", "\n"]);
    });
  });

  describe("successWithSpacing", () => {
    it("surrounds the callback output with blank lines", () => {
      const getWrites = mockStdoutWrites();
      successWithSpacing(() => colorPrint("hello", "none"));
      assert.deepStrictEqual(getWrites(), ["\n", "hello\n", "\n"]);
    });
  });

  describe("errorWithSpacing", () => {
    it("prints the callback output followed by a blank line", () => {
      const getWrites = mockStdoutWrites();
      errorWithSpacing(() => colorPrint("hello", "none"));
      assert.deepStrictEqual(getWrites(), ["hello\n", "\n"]);
    });

    it("does not reduce the blank lines between messages", () => {
      const getWrites = mockStdoutWrites();
      successWithSpacing(() => colorPrint("a", "none"));
      errorWithSpacing(() => colorPrint("b", "none"));
      assert.deepStrictEqual(getWrites(), ["\n", "a\n", "\n", "b\n", "\n"]);
    });
  });

  describe("printSessionStartDate", () => {
    beforeEach(() => {
      setupTestContext();
      actions.resetStdout();
    });

    it("prints the session start date", () => {
      mock.restoreAll();
      setupTestContext({ now: 42_000 });
      const getWrites = mockStdoutWrites();
      printSessionStartDate();
      assert.deepStrictEqual(getWrites(), [
        `${PURPLE}Resume this session with /resume 42000${RESET}\n`,
      ]);
    });
  });
});

describe("text", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  describe("truncate", () => {
    const MAX_LEN = 100;

    beforeEach(() => {
      mock.method(processDeps.stdout, "getColumns", () => MAX_LEN);
    });

    describe("returns unchanged", () => {
      it("returns empty string unchanged", () => {
        assert.equal(truncate(""), "");
      });

      it("returns strings within the max length unchanged", () => {
        assert.equal(truncate("a".repeat(MAX_LEN)), "a".repeat(MAX_LEN));
      });
    });

    describe("truncates with an ellipsis", () => {
      it("truncates longer strings to the max length with an ellipsis", () => {
        assert.equal(
          truncate("a".repeat(MAX_LEN + 10)),
          `${"a".repeat(MAX_LEN - 1)}…`,
        );
      });

      it("returns the first line with an ellipsis for multiline input", () => {
        assert.equal(truncate("short\nsecond line"), "short…");
      });

      it("truncates a long first line to the max length with an ellipsis", () => {
        assert.equal(
          truncate(`${"a".repeat(MAX_LEN + 10)}\nrest`),
          `${"a".repeat(MAX_LEN - 1)}…`,
        );
      });

      it("truncates with a three-char ellipsis when asciiOnly is set", () => {
        actions.setAsciiOnly(true);
        assert.equal(truncate("a".repeat(MAX_LEN + 10)), `${"a".repeat(99)}~`);
        assert.equal(truncate("short\nsecond line"), "short~");
      });
    });
  });

  it("falls back to 80 columns when stdout columns are undefined", () => {
    mock.method(processDeps.stdout, "getColumns", () => undefined);
    assert.equal(truncate("a".repeat(100)), `${"a".repeat(79)}…`);
  });

  describe("getUnicodeChar", () => {
    it("returns the char unchanged by default", () => {
      assert.equal(getUnicodeChar("…"), "…");
      assert.equal(getUnicodeChar("┊"), "┊");
    });

    it("returns the ascii replacement when asciiOnly is on", () => {
      actions.setAsciiOnly(true);
      assert.equal(getUnicodeChar("…"), "~");
      assert.equal(getUnicodeChar("┊"), "|");
      assert.equal(getUnicodeChar("━"), "=");
    });

    it("throws for a char outside the map", () => {
      assert.throws(() => getUnicodeChar("x"), AssertionError);
    });
  });
});

describe("temp-file", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  describe("getTempFileName", () => {
    it("returns temp file path without initial content", async () => {
      const result = await getTempFileName();
      assert.equal(result, "/tmp/lasso-test-uuid.txt");
    });

    it("copies initial content when initialContentPath is provided", async () => {
      testFs._files.set("/source/file.txt", "initial content");
      const result = await getTempFileName({
        initialContentPath: "/source/file.txt",
      });
      assert.equal(result, "/tmp/lasso-test-uuid.txt");
      assert.equal(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        "initial content",
      );
    });

    it("creates an empty temp file when the initial content path does not exist", async () => {
      const result = await getTempFileName({
        initialContentPath: "/missing/file.txt",
      });
      assert.equal(result, "/tmp/lasso-test-uuid.txt");
      assert.equal(testFs._files.get("/tmp/lasso-test-uuid.txt"), "");
    });

    it("returns null when reading an existing path fails", async () => {
      testFs._files.set("/source/file.txt", "initial content");
      mock.method(fsDeps, "readFile", () => Promise.reject(new Error("EIO")));
      const result = await getTempFileName({
        initialContentPath: "/source/file.txt",
      });
      assert.equal(result, null);
      assert.equal(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
    });

    it("returns null when write fails", async () => {
      testFs._files.set("/source.txt", "content");
      mock.method(fsDeps, "writeFile", () => Promise.reject(new Error("EIO")));
      const result = await getTempFileName({
        initialContentPath: "/source.txt",
      });
      assert.equal(result, null);

      const strResult = await getTempFileName({ initialContentStr: "content" });
      assert.equal(strResult, null);

      const noArgsResult = await getTempFileName();
      assert.equal(noArgsResult, null);
    });

    it("writes initialContentStr into the temp file", async () => {
      const result = await getTempFileName({
        initialContentStr: "string content",
      });
      assert.equal(result, "/tmp/lasso-test-uuid.txt");
      assert.equal(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        "string content",
      );
    });

    it("uses the extension in the temp file path", async () => {
      const result = await getTempFileName({ extension: "wav" });
      assert.equal(result, "/tmp/lasso-test-uuid.wav");
    });

    it("uses the path prefix in the temp file path", async () => {
      const result = await getTempFileName({
        pathPrefix: "lasso-local",
        initialContentStr: "local content",
      });
      assert.equal(result, "/tmp/lasso-local-test-uuid.txt");
      assert.equal(
        testFs._files.get("/tmp/lasso-local-test-uuid.txt"),
        "local content",
      );
    });

    it("throws when both initialContentPath and initialContentStr are provided", async () => {
      await assert.rejects(
        () =>
          getTempFileName({
            initialContentPath: "/source/file.txt",
            initialContentStr: "string content",
          }),
        /falsy value/,
      );
    });
    it("prints the error when checking the initial content path fails", async () => {
      mock.method(fsDeps, "existsSync", () => {
        throw new Error("EACCES");
      });
      const writes = mockStdoutWrites();
      const result = await getTempFileName({
        initialContentPath: "/source/file.txt",
      });
      assert.equal(result, null);
      assert.deepStrictEqual(writes(), [
        `${RED}Failed to create a temp file with content from path /source/file.txt. Error: EACCES${RESET}\n`,
      ]);
    });

    it("prints the error when reading the initial content fails", async () => {
      testFs._files.set("/source/file.txt", "initial content");
      mock.method(fsDeps, "readFile", () => Promise.reject(new Error("EIO")));
      const writes = mockStdoutWrites();
      const result = await getTempFileName({
        initialContentPath: "/source/file.txt",
      });
      assert.equal(result, null);
      assert.deepStrictEqual(writes(), [
        `${RED}Failed to read the content from path /source/file.txt to prepopulate a temp file. Error: EIO${RESET}\n`,
      ]);
    });

    it("prints the error when writing the initial content path fails", async () => {
      testFs._files.set("/source/file.txt", "initial content");
      mock.method(fsDeps, "writeFile", () =>
        Promise.reject(new Error("ENOSPC")),
      );
      const writes = mockStdoutWrites();
      const result = await getTempFileName({
        initialContentPath: "/source/file.txt",
      });
      assert.equal(result, null);
      assert.deepStrictEqual(writes(), [
        `${RED}Failed to write a temp file with the content from path /source/file.txt: ENOSPC${RESET}\n`,
      ]);
    });

    it("prints the error when the temp file cannot be created", async () => {
      mock.method(fsDeps, "writeFile", () => Promise.reject(new Error("EIO")));
      const writes = mockStdoutWrites();
      const result = await getTempFileName({ initialContentStr: "content" });
      assert.equal(result, null);
      assert.deepStrictEqual(writes(), [
        `${RED}Failed to write to a temp file. Error: EIO${RESET}\n`,
      ]);
    });

    it("prints the error when the empty temp file for a missing path cannot be created", async () => {
      mock.method(fsDeps, "writeFile", () => Promise.reject(new Error("EIO")));
      const writes = mockStdoutWrites();
      const result = await getTempFileName({
        initialContentPath: "/missing/file.txt",
      });
      assert.equal(result, null);
      assert.deepStrictEqual(writes(), [
        `${RED}Failed to write an empty temp file. Error: EIO${RESET}\n`,
      ]);
    });

    it("prints the error when no initial content is given and the temp file cannot be created", async () => {
      mock.method(fsDeps, "writeFile", () => Promise.reject(new Error("EIO")));
      const writes = mockStdoutWrites();
      const result = await getTempFileName();
      assert.equal(result, null);
      assert.deepStrictEqual(writes(), [
        `${RED}Failed to create an empty temp file. Error: EIO${RESET}\n`,
      ]);
    });
  });
});

describe("fence", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  describe("fencePrint", () => {
    beforeEach(() => {
      setupTestContext();
      actions.resetStdout();
    });

    describe("without session info", () => {
      it("prints the text in a fence without session info", () => {
        const getWrites = mockStdoutWrites();
        fencePrint("Output");
        assert.deepStrictEqual(getWrites(), [
          `${GREY}━━ ${BOLD}Output${BOLD_RESET} ━━${RESET}\n`,
        ]);
      });

      it("drops the header when it does not fit", () => {
        const longHeader = "a".repeat(100);
        const getWrites = mockStdoutWrites();
        fencePrint(longHeader);

        assert.deepStrictEqual(getWrites(), [
          `${GREY}━━ ${BOLD}${longHeader.substring(0, 73)}…${BOLD_RESET} ━━${RESET}\n`,
        ]);
      });
    });

    describe("with showSessionInfo", () => {
      it("prints duration and token usage when showSessionInfo is set", () => {
        const getWrites = mockStdoutWrites();
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(1_500_000_000));
        actions.setApiEndTime();

        fencePrint("Output", { showSessionInfo: true });

        assert.deepStrictEqual(getWrites(), [
          `${GREY}━━ ${BOLD}Output${BOLD_RESET} (500ms) (0 tokens in session) (1.531% of context window) ━━${RESET}\n`,
        ]);
      });

      it("includes context window usage when configured", () => {
        const getWrites = mockStdoutWrites();
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(1_500_000_000));
        actions.setApiEndTime();
        actions.setModel("test-model");
        actions.setContextWindowPerModel({ "test-model": 10_000 });
        actions.setConversationMessages([{ role: "user", content: "hi" }]);
        actions.setPromptTokens(5_000);
        actions.setPromptTokensDirty(false);

        fencePrint("Output", { showSessionInfo: true });

        assert.deepStrictEqual(getWrites(), [
          `${GREY}━━ ${BOLD}Output${BOLD_RESET} (500ms) (0 tokens in session) (50% of context window) ━━${RESET}\n`,
        ]);
      });

      it("drops usage when there is not enough room", () => {
        mock.method(processDeps.stdout, "getColumns", () => 20);
        const getWrites = mockStdoutWrites();
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(1_500_000_000));
        actions.setApiEndTime();
        actions.setContextWindowPerModel({ "unknown-model": 10_000 });

        fencePrint("Output", { showSessionInfo: true });

        assert.deepStrictEqual(getWrites(), [
          `${GREY}━━ ${BOLD}Output${BOLD_RESET} (500ms) ━━${RESET}\n`,
        ]);
      });

      it("drops duration and usage when there is not enough room", () => {
        mock.method(processDeps.stdout, "getColumns", () => 19);
        const getWrites = mockStdoutWrites();
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(1_500_000_000));
        actions.setApiEndTime();

        fencePrint("Output", { showSessionInfo: true });

        assert.deepStrictEqual(getWrites(), [
          `${GREY}━━ ${BOLD}Output${BOLD_RESET} ━━${RESET}\n`,
        ]);
      });

      it("truncates the header instead of dropping when showSessionInfo is set", () => {
        const longHeader = "b".repeat(100);
        const getWrites = mockStdoutWrites();
        mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
        actions.setApiStartTime();
        mock.method(process.hrtime, "bigint", () => BigInt(1_500_000_000));
        actions.setApiEndTime();

        fencePrint(longHeader, { showSessionInfo: true });

        assert.deepStrictEqual(getWrites(), [
          `${GREY}━━ ${BOLD}${longHeader.substring(0, 73)}…${BOLD_RESET} ━━${RESET}\n`,
        ]);
      });
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

    it("returns the diff from the error output when delta exits with code 1", async () => {
      const err = Object.assign(new Error("diff failed"), {
        code: 1,
        stdout: "delta diff output",
        stderr: "delta warning",
      });
      mockExecCalls([{ stdout: "delta 0.18.2" }, { stdout: "", error: err }]);
      const result = await execGitDiff({
        tempFileBeforePath: "a",
        tempFileAfterPath: "b",
      });
      assert.deepStrictEqual(result, {
        stdout: "delta diff output",
        stderr: "delta warning",
      });
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

    it("returns the diff from the error output when plain git diff exits with code 1", async () => {
      const err = Object.assign(new Error("diff failed"), {
        code: 1,
        stdout: "plain diff output",
        stderr: "",
      });
      mockExecCalls([
        { stdout: "", error: new Error("not found") },
        { stdout: "", error: err },
      ]);
      const result = await execGitDiff({
        tempFileBeforePath: "a",
        tempFileAfterPath: "b",
      });
      assert.deepStrictEqual(result, {
        stdout: "plain diff output",
        stderr: "",
      });
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

describe("terminal formatting", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
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
      const invalid = makeInvalidString();
      const result = await formatMarkdown(invalid);
      assert.equal(result, invalid);
      assert.deepStrictEqual(getWrites(), [
        `${RED}Outputting raw content, markdown formatting failed: Cannot read properties of null (reading 'length')${RESET}\n`,
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
});
