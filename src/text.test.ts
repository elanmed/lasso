import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert, { AssertionError } from "node:assert";

import { truncate, getUnicodeChar } from "./text.ts";
import { actions } from "./state.ts";
import { setupTestContext } from "./test-helpers.ts";
import { processDeps } from "./deps.ts";

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

    it("returns empty string unchanged", () => {
      assert.equal(truncate(""), "");
    });

    it("returns strings within the max length unchanged", () => {
      assert.equal(truncate("a".repeat(MAX_LEN)), "a".repeat(MAX_LEN));
    });

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
      assert.equal(truncate("a".repeat(MAX_LEN + 10)), `${"a".repeat(99)} `);
      assert.equal(truncate("short\nsecond line"), "short ");
    });

    it("falls back to 80 columns when stdout columns are undefined", () => {
      mock.method(processDeps.stdout, "getColumns", () => undefined);
      assert.equal(truncate("a".repeat(100)), `${"a".repeat(79)}…`);
    });
  });

  describe("getUnicodeChar", () => {
    it("returns the char unchanged by default", () => {
      assert.equal(getUnicodeChar("…"), "…");
      assert.equal(getUnicodeChar("┊"), "┊");
    });

    it("returns the ascii replacement when asciiOnly is on", () => {
      actions.setAsciiOnly(true);
      assert.equal(getUnicodeChar("…"), " ");
      assert.equal(getUnicodeChar("┊"), "|");
      assert.equal(getUnicodeChar("━"), "=");
      assert.equal(getUnicodeChar("—"), "-");
    });

    it("throws for a char outside the map", () => {
      assert.throws(() => getUnicodeChar("x"), AssertionError);
    });
  });
});
