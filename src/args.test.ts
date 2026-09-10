import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert";
import { parseCliArgs, parseCliArgsDeps } from "./args.ts";

describe("args", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("returns default args when no arguments are provided", () => {
    mock.method(parseCliArgsDeps, "getArgv", () => ["node", "script.js"]);
    const result = parseCliArgs();
    assert.deepStrictEqual(result, { debug: false });
  });

  it("sets debug to true when --debug argument is provided", () => {
    mock.method(parseCliArgsDeps, "getArgv", () => [
      "node",
      "script.js",
      "--debug",
    ]);
    const result = parseCliArgs();
    assert.deepStrictEqual(result, { debug: true });
  });

  it("throws on unknown argument", () => {
    mock.method(parseCliArgsDeps, "getArgv", () => [
      "node",
      "script.js",
      "--unknown",
    ]);
    assert.throws(() => parseCliArgs(), /Usage/);
  });
});
