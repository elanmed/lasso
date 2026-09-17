import { describe, it } from "node:test";
import assert from "node:assert";
import { strToApproxTokens, approxTokensToCharLen } from "./tokens.ts";

describe("strToApproxTokens", () => {
  it("splits character length by 3", () => {
    assert.equal(strToApproxTokens(""), 0);
    assert.equal(strToApproxTokens("abc"), 1);
    assert.equal(strToApproxTokens("abcdef"), 2);
    assert.equal(strToApproxTokens("abcdefg"), 2);
  });
});

describe("approxTokensToCharLen", () => {
  it("multiplies token count by 3", () => {
    assert.equal(approxTokensToCharLen(0), 0);
    assert.equal(approxTokensToCharLen(1), 3);
    assert.equal(approxTokensToCharLen(250), 750);
  });
});
