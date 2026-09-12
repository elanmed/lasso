import assert from "node:assert";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { getState } from "./state.ts";
import { MISSING } from "./missing.ts";
import { processDeps } from "./deps.ts";

export function getHeaders() {
  const headers: Record<string, string> = {};
  if (getState().config.gateway === "opencode") {
    headers["x-opencode-session"] = getState().app.sessionId;
    headers["x-opencode-client"] = "lasso";
  }
  return headers;
}

export function getLanguageModel(model = getState().config.model) {
  const apiKey = processDeps.env.get("LASSO_API_KEY");
  const sdkProvider = getState().config.sdkProvider;

  assert(apiKey !== undefined);
  assert(sdkProvider !== MISSING);

  const baseURL = getState().config.baseURL;
  const headers = getHeaders();

  switch (sdkProvider) {
    case "openai-compatible": {
      assert(baseURL !== undefined);
      return createOpenAICompatible({
        apiKey,
        baseURL,
        name: "openai-compatible",
        headers,
      }).chatModel(model);
    }
    case "anthropic": {
      return createAnthropic({
        apiKey,
        headers,
        ...(baseURL === undefined ? {} : { baseURL }),
      })(model);
    }
    case "openai": {
      return createOpenAI({
        apiKey,
        headers,
        ...(baseURL === undefined ? {} : { baseURL }),
      })(model);
    }
    default: {
      sdkProvider satisfies never;
      throw new Error("Unhandled sdkProvider");
    }
  }
}
