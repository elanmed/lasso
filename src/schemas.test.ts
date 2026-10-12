import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ConfigSchema,
  DefaultedConfigSchema,
  SessionFileSchema,
  isSameKey,
} from "./schemas.ts";

describe("config-types", () => {
  it("ConfigSchema and DefaultedConfigSchema have the same keys", () => {
    assert.deepStrictEqual(
      Object.keys(ConfigSchema.shape).sort(),
      Object.keys(DefaultedConfigSchema.shape).sort(),
    );
  });
  describe("isSameKey", () => {
    describe("matching keys", () => {
      it("returns true when missing modifier fields match false ones", () => {
        assert.equal(
          isSameKey(
            { name: "g", ctrl: true },
            { name: "g", ctrl: true, meta: false, shift: false },
          ),
          true,
        );
      });

      it("returns true when all fields match", () => {
        assert.equal(
          isSameKey(
            { name: "e", ctrl: true, meta: false, shift: false },
            { name: "e", ctrl: true, meta: false, shift: false },
          ),
          true,
        );
      });
    });

    describe("differing keys", () => {
      it("returns false when name differs", () => {
        assert.equal(
          isSameKey(
            { name: "e", ctrl: true, meta: false, shift: false },
            { name: "x", ctrl: true, meta: false, shift: false },
          ),
          false,
        );
      });

      it("returns false when ctrl differs", () => {
        assert.equal(
          isSameKey(
            { name: "e", ctrl: true, meta: false, shift: false },
            { name: "e", ctrl: false, meta: false, shift: false },
          ),
          false,
        );
      });

      it("returns false when meta differs", () => {
        assert.equal(
          isSameKey(
            { name: "x", ctrl: false, meta: true, shift: false },
            { name: "x", ctrl: false, meta: false, shift: false },
          ),
          false,
        );
      });

      it("returns false when shift differs", () => {
        assert.equal(
          isSameKey(
            { name: "x", ctrl: false, meta: false, shift: true },
            { name: "x", ctrl: false, meta: false, shift: false },
          ),
          false,
        );
      });
    });
  });

  describe("contextWindowPerModel", () => {
    const schema = ConfigSchema.shape.contextWindowPerModel;

    it("accepts a context window equal to the minimum", () => {
      const result = schema.safeParse({ "test-model": 40_000 });
      assert.deepStrictEqual(result.data, { "test-model": 40_000 });
    });

    it("accepts a null context window", () => {
      const result = schema.safeParse({ "test-model": null });
      assert.deepStrictEqual(result.data, { "test-model": null });
    });

    it("rejects a context window below the minimum", () => {
      const result = schema.safeParse({ "test-model": 39_999 });
      assert.strictEqual(result.success, false);
    });
  });
});

describe("SessionFileSchema", () => {
  it("parses a valid session file", () => {
    assert.deepStrictEqual(
      SessionFileSchema.parse({
        messages: [{ role: "user", content: "hello" }],
        summaries: [{ compacted: "summary", compactedAt: 123, tokens: 456 }],
        transcript: [{ timestamp: 0, role: "user", message: "hello" }],
      }),
      {
        messages: [{ role: "user", content: "hello" }],
        summaries: [{ compacted: "summary", compactedAt: 123, tokens: 456 }],
        transcript: [{ timestamp: 0, role: "user", message: "hello" }],
      },
    );
  });

  it("rejects an invalid transcript role", () => {
    const result = SessionFileSchema.safeParse({
      messages: [],
      summaries: [],
      transcript: [{ timestamp: 0, role: "system", message: "hello" }],
    });
    assert.strictEqual(result.success, false);
  });

  it("rejects an invalid summary shape", () => {
    const result = SessionFileSchema.safeParse({
      messages: [],
      summaries: [{ compacted: 1, compactedAt: 123, tokens: 456 }],
      transcript: [],
    });
    assert.strictEqual(result.success, false);
  });

  it("allows extra fields on messages", () => {
    assert.deepStrictEqual(
      SessionFileSchema.parse({
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            name: "assistant",
          },
        ],
        summaries: [],
        transcript: [],
      }),
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            name: "assistant",
          },
        ],
        summaries: [],
        transcript: [],
      },
    );
  });

  it("rejects a message without content", () => {
    const result = SessionFileSchema.safeParse({
      messages: [{ role: "user" }],
      summaries: [],
      transcript: [],
    });
    assert.strictEqual(result.success, false);
  });

  it("rejects extra fields on summaries", () => {
    const result = SessionFileSchema.safeParse({
      messages: [],
      summaries: [
        { compacted: "summary", compactedAt: 123, tokens: 456, extra: 1 },
      ],
      transcript: [],
    });
    assert.strictEqual(result.success, false);
  });

  it("rejects extra fields on transcript entries", () => {
    const result = SessionFileSchema.safeParse({
      messages: [],
      summaries: [],
      transcript: [{ timestamp: 0, role: "user", message: "hello", extra: 1 }],
    });
    assert.strictEqual(result.success, false);
  });
});
