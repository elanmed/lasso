import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { fencePrint, getPrettyApiDuration } from "./fence.ts";
import { actions } from "./state.ts";
import { processDeps } from "./deps.ts";
import { stripAnsi, mockStdout, setupTestContext } from "./test-helpers.ts";

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
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      actions.setApiStartTime();
      mock.method(process.hrtime, "bigint", () => BigInt(1_500_000_000));
      actions.setApiEndTime();

      fencePrint("Output", { showSessionInfo: true });

      assert.strictEqual(
        stripAnsi(getCaptured()),
        "\u2501\u2501 Output (500ms) (0 tokens in session) \u2501\u2501\n",
      );
    });

    it("includes context window usage when configured", () => {
      const getCaptured = mockStdout();
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      actions.setApiStartTime();
      mock.method(process.hrtime, "bigint", () => BigInt(1_500_000_000));
      actions.setApiEndTime();
      actions.setModel("test-model");
      actions.setContextWindowPerModel({ "test-model": 10_000 });
      actions.appendToConversation({ role: "user", content: "hi" });
      actions.setPromptTokens(5_000);

      fencePrint("Output", { showSessionInfo: true });

      assert.strictEqual(
        stripAnsi(getCaptured()),
        "\u2501\u2501 Output (500ms) (0 tokens in session, 50% of context window) \u2501\u2501\n",
      );
    });

    it("drops usage when there is not enough room", () => {
      mock.method(processDeps.stdout, "getColumns", () => 20);
      const getCaptured = mockStdout();
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      actions.setApiStartTime();
      mock.method(process.hrtime, "bigint", () => BigInt(1_500_000_000));
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
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      actions.setApiStartTime();
      mock.method(process.hrtime, "bigint", () => BigInt(1_500_000_000));
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
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      actions.setApiStartTime();
      mock.method(process.hrtime, "bigint", () => BigInt(1_500_000_000));
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
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      actions.setApiStartTime();
      mock.method(process.hrtime, "bigint", () => BigInt(1_500_000_000));
      actions.setApiEndTime();

      const result = getPrettyApiDuration();
      assert.strictEqual(result, "500ms");
    });

    it("includes microseconds when requested", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      actions.setApiStartTime();
      mock.method(process.hrtime, "bigint", () => BigInt(1_234_567_890));
      actions.setApiEndTime();

      const result = getPrettyApiDuration({ includeMicroseconds: true });
      assert.strictEqual(result, "234.567ms");
    });

    it("truncates nanoseconds", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      actions.setApiStartTime();
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_123_456));
      actions.setApiEndTime();

      const result = getPrettyApiDuration({ includeMicroseconds: true });
      assert.strictEqual(result, "0.123ms");
    });

    it("formats seconds and milliseconds", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      actions.setApiStartTime();
      mock.method(process.hrtime, "bigint", () => BigInt(6_500_000_000));
      actions.setApiEndTime();

      const result = getPrettyApiDuration();
      assert.strictEqual(result, "5s 500ms");
    });

    it("formats minutes, zero seconds, and milliseconds", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      actions.setApiStartTime();
      mock.method(process.hrtime, "bigint", () => BigInt(121_500_000_000));
      actions.setApiEndTime();

      const result = getPrettyApiDuration();
      assert.strictEqual(result, "2m 0s 500ms");
    });

    it("formats minutes, seconds, and milliseconds", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      actions.setApiStartTime();
      mock.method(process.hrtime, "bigint", () => BigInt(126_500_000_000));
      actions.setApiEndTime();

      const result = getPrettyApiDuration();
      assert.strictEqual(result, "2m 5s 500ms");
    });

    it("clamps negative durations from clock skew to zero", () => {
      mock.method(process.hrtime, "bigint", () => BigInt(1_000_000_000));
      actions.setApiStartTime();
      mock.method(process.hrtime, "bigint", () => BigInt(500_000_000));
      actions.setApiEndTime();

      const result = getPrettyApiDuration();
      assert.strictEqual(result, "0ms");
    });
  });
});
