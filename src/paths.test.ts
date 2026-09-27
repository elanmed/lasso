import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { join } from "node:path";
import {
  getSessionDir,
  getDataDir,
  getGlobalConfigDir,
  getGlobalContextDir,
  getDebugLogDir,
  getGlobalConfigPath,
  getStateDir,
  getUsageLogLockPath,
  getUsageLogPath,
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

  it("uses the home state dir when XDG_STATE_HOME is unset", () => {
    assert.equal(getStateDir(), join("/fake-home", ".local", "state", "lasso"));
  });

  it("uses XDG_STATE_HOME for the state dir when set", () => {
    testProcessEnv._set("XDG_STATE_HOME", "/xdg-state");
    assert.equal(getStateDir(), join("/xdg-state", "lasso"));
    assert.equal(getSessionDir(), join("/xdg-state", "lasso", "sessions"));
    assert.equal(getDebugLogDir(), join("/xdg-state", "lasso", "debug"));
  });

  it("uses the home data dir when XDG_DATA_HOME is unset", () => {
    assert.equal(getDataDir(), join("/fake-home", ".local", "share", "lasso"));
  });

  it("uses XDG_DATA_HOME for the data dir when set", () => {
    testProcessEnv._set("XDG_DATA_HOME", "/xdg-data");
    assert.equal(getDataDir(), join("/xdg-data", "lasso"));
    assert.equal(getUsageLogPath(), join("/xdg-data", "lasso", "usage.json"));
    assert.equal(
      getUsageLogLockPath(),
      join("/xdg-data", "lasso", "usage.lock"),
    );
  });
});
