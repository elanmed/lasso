import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
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
  bold,
} from "./print.ts";
import { actions } from "./state.ts";
import { processDeps } from "./deps.ts";
import {
  BLUE,
  CLEAR_LINE,
  CR,
  DOWN_1,
  DOWN_2,
  GREEN,
  PURPLE,
  RED,
  RESET,
  UP_1,
  UP_2,
  testProcessEnv,
  mockStdoutWrites,
  mockSetInterval,
  mockClearInterval,
  setupTestContext,
} from "./test-helpers.ts";

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
