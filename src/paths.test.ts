import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { join } from "node:path";
import {
  getGlobalConfigDir,
  getGlobalContextDir,
  getGlobalConfigPath,
} from "./paths.ts";
import { testProcessEnv, setupTestContext } from "./test-helpers.ts";

describe("paths", () => {
  afterEach(() => {
    mock.restoreAll();
  });
  beforeEach(() => {
    setupTestContext();
  });

  it("uses the home config dir when XDG_CONFIG_HOME is unset", () => {
    assert.equal(getGlobalConfigDir(), join("/fake-home", ".config", "lasso"));
  });

  it("uses XDG_CONFIG_HOME for the global config dir when set", () => {
    testProcessEnv._set("XDG_CONFIG_HOME", "/xdg-config");
    const expected = join("/xdg-config", "lasso");
    assert.equal(getGlobalConfigDir(), expected);
    assert.equal(getGlobalContextDir(), join(expected, "context"));
    assert.equal(getGlobalConfigPath(), join(expected, "settings.yaml"));
  });
});
