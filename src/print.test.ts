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
  RED,
  RESET,
  UP_1,
  UP_2,
  stripAnsi,
  testProcessEnv,
  mockStdout,
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

      const getCaptured = mockStdout({ includeSpinnerFrames: true });

      startLoadingState();
      callbacks.forEach((cb) => cb());
      callbacks.forEach((cb) => cb());
      callbacks.forEach((cb) => cb());
      callbacks.forEach((cb) => cb());
      stopLoadingState();

      assert.strictEqual(getCaptured(), "\ra\rb\rc\ra\rb\r \r");
    });

    it("uses default loadingStateFrames when none set", () => {
      actions.resetState();
      const callbacks = mockSetInterval();
      mockClearInterval(callbacks);

      const getCaptured = mockStdout({ includeSpinnerFrames: true });

      startLoadingState();
      callbacks.forEach((cb) => cb());
      callbacks.forEach((cb) => cb());
      stopLoadingState();

      assert.strictEqual(getCaptured(), "\r|\r/\r-\r \r");
    });

    it("stopLoadingState gracefully handles multiple calls", () => {
      actions.resetState();
      const callbacks = mockSetInterval();
      mockClearInterval(callbacks);
      mockStdout();
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
      const getCaptured = mockStdout();
      actions.setLoadingStateFrames(["a", "b", "c"]);

      startLoadingState();
      callbacks.forEach((cb) => cb());

      colorPrint("X", "none");
      colorPrint("Y", "none");
      colorPrint("Z", "none");

      await Promise.resolve();

      assert.strictEqual(stripAnsi(getCaptured()), "X\nY\nZ\n");
    });
  });

  describe("createPerformanceLogger", () => {
    it("prints the label when starting and the colored duration when ending", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      const logger = createPerformanceLogger({ logDuration: true });
      const getCaptured = mockStdout();
      logger.start("Reading context files: ");
      assert.strictEqual(stripAnsi(getCaptured()), "Reading context files: ");
      mock.method(process.hrtime, "bigint", () => BigInt(1_234_567_890));

      logger.end();

      assert.strictEqual(
        stripAnsi(getCaptured()),
        "Reading context files: 234.567ms\n",
      );
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
      const getCaptured = mockStdout();

      logger.start("a: ");
      logger.end();
      logger.start("a: ");
      logger.end();

      assert.strictEqual(stripAnsi(getCaptured()), "a: 0.0ms\na: 1s 0.0ms\n");
    });

    it("does nothing when logDuration is false", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      const logger = createPerformanceLogger({ logDuration: false });
      const getCaptured = mockStdout();
      logger.start("a: ");
      logger.end();
      assert.strictEqual(getCaptured(), "");
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
        labels: ["Starting a: ", "Starting b: "],
      });
      const getCaptured = mockStdout();

      logger.printAllLabels();

      assert.strictEqual(
        getCaptured(),
        `${BLUE}Starting a: ${RESET}
${BLUE}Starting b: ${RESET}
`,
      );
    });

    it("rewrites each label in place with its duration", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      const logger = createParallelPerformanceLogger({
        logDuration: true,
        labels: ["Starting a: ", "Starting b: "],
      });
      const getWrites = mockStdoutWrites();

      logger.printAllLabels();
      logger.start("Starting a: ");
      mock.method(process.hrtime, "bigint", () => BigInt(1_234_567_890));
      logger.end("Starting a: ");
      logger.start("Starting b: ");
      mock.method(process.hrtime, "bigint", () => BigInt(2_234_567_890));
      logger.end("Starting b: ");

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
        labels: ["Starting a: "],
      });
      const getCaptured = mockStdout();

      logger.printAllLabels();
      logger.start("Starting a: ");
      logger.end("Starting a: ");

      assert.strictEqual(getCaptured(), "");
    });

    it("throws when ended without start", () => {
      const logger = createParallelPerformanceLogger({
        logDuration: true,
        labels: ["Starting a: "],
      });
      assert.throws(() => logger.end("Starting a: "));
    });
  });

  describe("appendNewline", () => {
    it("appends a newline by default", () => {
      const getCaptured = mockStdout();
      colorPrint("hello", "none");
      assert.strictEqual(getCaptured(), "hello\n");
    });

    it("omits the newline when appendNewline is false", () => {
      const getCaptured = mockStdout();
      colorPrint("hello", "none", { appendNewline: false });
      assert.strictEqual(getCaptured(), "hello");
    });

    it("keeps color codes around the text without a trailing newline", () => {
      const getCaptured = mockStdout();
      colorPrint("hello", "blue", { appendNewline: false });
      assert.strictEqual(getCaptured(), `${BLUE}hello${RESET}`);
    });
  });

  describe("color disabled", () => {
    it("omits ansi codes when NO_COLOR is set", () => {
      testProcessEnv._set("NO_COLOR", "1");
      const getCaptured = mockStdout();
      colorPrint("hello", "blue");
      const out = getCaptured();
      assert.equal(out, "hello\n");
      assert.equal(bold("hello"), "hello");
    });

    it("omits ansi codes when stdout is not a tty", () => {
      mock.method(processDeps.stdout, "isTTY", () => false);
      const getCaptured = mockStdout();
      colorPrint("hello", "blue");
      assert.equal(getCaptured(), "hello\n");
    });
  });

  describe("printNewline", () => {
    it("prints nothing when stdoutTail already ends with two newlines", () => {
      const getCaptured = mockStdout();
      actions.appendStdoutTail("\n\n");
      printNewline();
      assert.strictEqual(getCaptured(), "");
    });

    it("appends a newline when stdoutTail does not end with two newlines", () => {
      const getCaptured = mockStdout();
      colorPrint("a", "none", { appendNewline: false });
      printNewline();
      assert.strictEqual(getCaptured(), "a\n");
    });
  });

  describe("successWithSpacing", () => {
    it("surrounds the callback output with blank lines", () => {
      const getCaptured = mockStdout();
      successWithSpacing(() => colorPrint("hello", "none"));
      assert.strictEqual(getCaptured(), "\nhello\n\n");
    });
  });

  describe("errorWithSpacing", () => {
    it("prints the callback output followed by a blank line", () => {
      const getCaptured = mockStdout();
      errorWithSpacing(() => colorPrint("hello", "none"));
      assert.strictEqual(getCaptured(), "hello\n\n");
    });

    it("does not reduce the blank lines between messages", () => {
      const getCaptured = mockStdout();
      successWithSpacing(() => colorPrint("a", "none"));
      errorWithSpacing(() => colorPrint("b", "none"));
      assert.strictEqual(getCaptured(), "\na\n\nb\n\n");
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
      const getCaptured = mockStdout();
      printSessionStartDate();
      assert.strictEqual(
        stripAnsi(getCaptured()),
        "Resume this session with /resume 42000\n",
      );
    });
  });
});
