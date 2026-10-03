import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { actions } from "./state.ts";
import {
  getHeaders,
  getLanguageModel,
  getTranscriptionProvider,
} from "./model.ts";
import { setupTestContext, testProcessEnv } from "./test-helpers.ts";

describe("model", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext({ model: "claude-sonnet-4-20250514" });
    actions.setBaseURL("https://api.anthropic.com");
  });

  describe("getLanguageModel", () => {
    it("creates an Anthropic language model", () => {
      const model = getLanguageModel();
      assert.deepStrictEqual(
        { modelId: model.modelId, provider: model.provider },
        { modelId: "claude-sonnet-4-20250514", provider: "anthropic.messages" },
      );
    });

    it("creates an OpenAI-compatible language model", () => {
      actions.setSdkProvider("openai-compatible");
      const model = getLanguageModel();
      assert.deepStrictEqual(
        { modelId: model.modelId, provider: model.provider },
        {
          modelId: "claude-sonnet-4-20250514",
          provider: "openai-compatible.chat",
        },
      );
    });

    it("creates an OpenAI language model", () => {
      actions.setSdkProvider("openai");
      const model = getLanguageModel();
      assert.deepStrictEqual(
        { modelId: model.modelId, provider: model.provider },
        { modelId: "claude-sonnet-4-20250514", provider: "openai.responses" },
      );
    });

    it("creates a Google language model", () => {
      actions.setSdkProvider("google");
      const model = getLanguageModel();
      assert.deepStrictEqual(
        { modelId: model.modelId, provider: model.provider },
        {
          modelId: "claude-sonnet-4-20250514",
          provider: "google.generative-ai",
        },
      );
    });
  });

  describe("getTranscriptionProvider", () => {
    beforeEach(() => {
      testProcessEnv._set("LASSO_TRANSCRIPTION_API_KEY", "test-key");
    });

    it("creates an OpenAI transcription model", () => {
      actions.setTranscriptionSdkProvider("openai");
      const model =
        getTranscriptionProvider().transcription("gpt-4o-transcribe");
      assert.equal(model.provider, "openai.transcription");
    });

    it("creates a Google transcription model", () => {
      actions.setTranscriptionSdkProvider("google");
      const model =
        getTranscriptionProvider().transcription("gemini-2.0-flash");
      assert.equal(model.provider, "google.generative-ai.transcription");
    });
  });

  describe("getHeaders", () => {
    it("returns no headers when gateway is not opencode", () => {
      assert.deepStrictEqual(getHeaders(), {});
    });

    it("returns session and client headers when gateway is opencode", () => {
      actions.setGateway("opencode");
      assert.deepStrictEqual(getHeaders(), {
        "x-opencode-session": "test-uuid",
        "x-opencode-client": "lasso",
      });
    });
  });
});
