import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import {
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

      colorPrint("X");
      colorPrint("Y");
      colorPrint("Z");

      await Promise.resolve();

      assert.strictEqual(stripAnsi(getCaptured()), "X\nY\nZ\n");
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
