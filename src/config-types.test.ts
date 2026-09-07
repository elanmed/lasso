import { describe, it } from "node:test";
import assert from "node:assert";

import { ConfigSchema, DefaultedConfigSchema } from "./config-types.ts";

describe("config-types", () => {
  it("ConfigSchema and DefaultedConfigSchema have the same keys", () => {
    assert.deepStrictEqual(
      Object.keys(ConfigSchema.shape).sort(),
      Object.keys(DefaultedConfigSchema.shape).sort(),
    );
  });
});
