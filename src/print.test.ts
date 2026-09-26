import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import {
  createPerformanceLogger,
  startLoadingState,
  stopLoadingState,
  colorPrint,
  printSessionStartDate,
  bold,
} from "./print.ts";
import { actions } from "./state.ts";
import { processDeps } from "./deps.ts";
import {
  stripAnsi,
  testProcessEnv,
  mockStdout,
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
      assert.strictEqual(getCaptured(), "\u001b[34mhello\u001b[0m");
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
