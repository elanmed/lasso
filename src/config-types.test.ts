import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert";

import { ConfigSchema, DefaultedConfigSchema } from "./config-types.ts";

describe("config-types", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("ConfigSchema and DefaultedConfigSchema have the same keys", () => {
    assert.deepStrictEqual(
      Object.keys(ConfigSchema.shape).sort(),
      Object.keys(DefaultedConfigSchema.shape).sort(),
    );
  });
});
