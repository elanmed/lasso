import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import {
  getPrettyApiDuration,
  startLoadingState,
  stopLoadingState,
  colorPrint,
  fencePrint,
  printSessionStartDate,
} from "./print.ts";
import { actions } from "./state.ts";
import { processDeps } from "./deps.ts";
import {
  stripAnsi,
  mockStdout,
  mockSetInterval,
  mockClearInterval,
  setupFakeDeps,
  setupTestContext,
} from "./test-helpers.ts";

describe("print", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupFakeDeps();
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

  describe("fencePrint", () => {
    beforeEach(() => {
      setupFakeDeps();
      actions.resetState();
      actions.resetStdout();
    });

    it("prints the text in a fence without session info", () => {
      const getCaptured = mockStdout();
      fencePrint("Output");
      assert.strictEqual(
        stripAnsi(getCaptured()),
        "\u2501\u2501 Output \u2501\u2501\n",
      );
    });

    it("prints duration and token usage when showSessionInfo is set", () => {
      const getCaptured = mockStdout();
      mock.method(performance, "now", () => 1_000);
      actions.setApiStartTime();
      mock.method(performance, "now", () => 1_500);
      actions.setApiEndTime();

      fencePrint("Output", { showSessionInfo: true });

      assert.strictEqual(
        stripAnsi(getCaptured()),
        "\u2501\u2501 Output (500ms) (0 tokens in session) \u2501\u2501\n",
      );
    });

    it("includes context window usage when configured", () => {
      const getCaptured = mockStdout();
      mock.method(performance, "now", () => 1_000);
      actions.setApiStartTime();
      mock.method(performance, "now", () => 1_500);
      actions.setApiEndTime();
      actions.setModel("test-model");
      actions.setContextWindowPerModel({ "test-model": 10_000 });
      actions.appendToMessageParams({ role: "user", content: "hi" });
      actions.setMessageParamTokens(5_000);

      fencePrint("Output", { showSessionInfo: true });

      assert.strictEqual(
        stripAnsi(getCaptured()),
        "\u2501\u2501 Output (500ms) (0 tokens in session, 50% of context window) \u2501\u2501\n",
      );
    });

    it("drops usage when there is not enough room", () => {
      mock.method(processDeps.stdout, "getColumns", () => 20);
      const getCaptured = mockStdout();
      mock.method(performance, "now", () => 1_000);
      actions.setApiStartTime();
      mock.method(performance, "now", () => 1_500);
      actions.setApiEndTime();
      actions.setContextWindowPerModel({ "unknown-model": 10_000 });

      fencePrint("Output", { showSessionInfo: true });

      assert.strictEqual(
        stripAnsi(getCaptured()),
        "\u2501\u2501 Output (500ms) \u2501\u2501\n",
      );
    });

    it("drops duration and usage when there is not enough room", () => {
      mock.method(processDeps.stdout, "getColumns", () => 19);
      const getCaptured = mockStdout();
      mock.method(performance, "now", () => 1_000);
      actions.setApiStartTime();
      mock.method(performance, "now", () => 1_500);
      actions.setApiEndTime();

      fencePrint("Output", { showSessionInfo: true });

      assert.strictEqual(
        stripAnsi(getCaptured()),
        "\u2501\u2501 Output \u2501\u2501\n",
      );
    });

    it("drops the header when it does not fit", () => {
      const longHeader = "a".repeat(100);
      const getCaptured = mockStdout();
      fencePrint(longHeader);

      assert.strictEqual(
        stripAnsi(getCaptured()),
        `\u2501\u2501 ${longHeader.substring(0, 73)}\u2026 \u2501\u2501\n`,
      );
    });

    it("truncates the header instead of dropping when showSessionInfo is set", () => {
      const longHeader = "b".repeat(100);
      const getCaptured = mockStdout();
      mock.method(performance, "now", () => 1_000);
      actions.setApiStartTime();
      mock.method(performance, "now", () => 1_500);
      actions.setApiEndTime();

      fencePrint(longHeader, { showSessionInfo: true });

      assert.strictEqual(
        stripAnsi(getCaptured()),
        `\u2501\u2501 ${longHeader.substring(0, 73)}\u2026 \u2501\u2501\n`,
      );
    });
  });

  describe("getPrettyApiDuration", () => {
    beforeEach(() => {
      actions.resetState();
    });

    it("formats sub-second duration as milliseconds", () => {
      mock.method(performance, "now", () => 1_000);
      actions.setApiStartTime();
      mock.method(performance, "now", () => 1_500);
      actions.setApiEndTime();
      const result = getPrettyApiDuration();
      assert.strictEqual(result, "500ms");
    });

    it("formats seconds and milliseconds", () => {
      mock.method(performance, "now", () => 1_000);
      actions.setApiStartTime();
      mock.method(performance, "now", () => 6_500);
      actions.setApiEndTime();
      const result = getPrettyApiDuration();
      assert.strictEqual(result, "5s 500ms");
    });

    it("formats minutes, zero seconds, and milliseconds", () => {
      mock.method(performance, "now", () => 1_000);
      actions.setApiStartTime();
      mock.method(performance, "now", () => 121_500);
      actions.setApiEndTime();
      const result = getPrettyApiDuration();
      assert.strictEqual(result, "2m 0s 500ms");
    });

    it("formats minutes, seconds, and milliseconds", () => {
      mock.method(performance, "now", () => 1_000);
      actions.setApiStartTime();
      mock.method(performance, "now", () => 126_500);
      actions.setApiEndTime();
      const result = getPrettyApiDuration();
      assert.strictEqual(result, "2m 5s 500ms");
    });

    it("clamps negative durations from clock skew to zero", () => {
      mock.method(performance, "now", () => 1_000);
      actions.setApiStartTime();
      mock.method(performance, "now", () => 500);
      actions.setApiEndTime();
      const result = getPrettyApiDuration();
      assert.strictEqual(result, "0ms");
    });
  });

  describe("printSessionStartDate", () => {
    beforeEach(() => {
      setupFakeDeps();
      actions.resetState();
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
