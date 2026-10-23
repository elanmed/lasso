import { removeMediaReplacer, decimalToPercent } from "./utils.ts";
import { getState } from "./state.ts";
function charLenToApproxTokens(charLen: number) {
  return Math.floor(charLen / 3);
}

export function strToApproxTokens(str: string) {
  return charLenToApproxTokens(str.length);
}

export function formatTokenCountAside(str: string) {
  return `_(${strToApproxTokens(str).toLocaleString()} tokens)_`;
}

export function formatTokenRangeAside(start: string, end: string) {
  return `_(${strToApproxTokens(start).toLocaleString()}-${strToApproxTokens(end).toLocaleString()} tokens)_`;
}

export function approxTokensToCharLen(tokenCount: number) {
  return 3 * tokenCount;
}

export function orApproxTokens(value: number | undefined, text: string) {
  return value ?? strToApproxTokens(text);
}
import { getBaseAgentPrompt } from "./prompts.ts";
import {
  dedicatedSummaryRatio,
  maxTokenCountPerSummary,
  type ModelMessage,
} from "./schemas.ts";
import { print } from "./printing.ts";
import { stringifyTools } from "./tools.ts";

export function getApproxTokensFromMessages(messages: ModelMessage[]) {
  return strToApproxTokens(stringifyMessages(messages));
}

export function stringifyMessages(messages: ModelMessage[]) {
  return JSON.stringify(messages, removeMediaReplacer);
}

export function getSystemContent() {
  return [
    getBaseAgentPrompt(getState().mcp.clients),
    getState().content.contextStr,
    getState().content.skillsStr,
  ].join("\n\n");
}

export function getToolsContentStr() {
  return stringifyTools();
}

export const compactTriggerRatio = 0.95;

export const dedicatedPromptOverheadRatio =
  compactTriggerRatio - dedicatedSummaryRatio;

export const defaultContextWindow = 128_000;

export const maxCharCountPerSummary = approxTokensToCharLen(
  maxTokenCountPerSummary,
);

export function getMaxNumberSummaries() {
  const { model } = getState().config;
  const contextWindow =
    getState().config.contextWindowPerModel[model] ?? defaultContextWindow;
  const allSummariesTokenCount = dedicatedSummaryRatio * contextWindow;
  return Math.floor(allSummariesTokenCount / maxTokenCountPerSummary);
}

export function getPromptOverheadTokensApprox() {
  return strToApproxTokens(getPromptOverheadStr());
}

export function getPromptOverheadStr() {
  return getSystemContent() + stringifyTools();
}

export function printLargeContextOverheadWarning() {
  const { model } = getState().config;
  const contextWindow =
    getState().config.contextWindowPerModel[model] ?? defaultContextWindow;

  const promptOverheadTokensApprox = getPromptOverheadTokensApprox();

  const promptOverheadRatio = promptOverheadTokensApprox / contextWindow;
  if (promptOverheadRatio >= dedicatedPromptOverheadRatio) {
    print.warning(
      `The current set of context, skills, and tools is ${decimalToPercent(promptOverheadRatio)} of the ${contextWindow.toLocaleString()} token context window!

Lasso reserves ${decimalToPercent(dedicatedSummaryRatio)} of the context window for compacted summaries with the assumption that at most ${decimalToPercent(dedicatedPromptOverheadRatio)} of the context window will be used for prompt overhead. As is, the prompt overhead is large enough to break this assumption and, along with any user messages, may breach the llm's context window and cause API calls to be rejected. Consider converting some of your context to skills and minimizing MCP servers.`,
    );
  }
}

export function getApproxInputTokens() {
  return (
    getApproxTokensFromMessages(getState().conversation.messages) +
    getPromptOverheadTokensApprox()
  );
}

export function getInputCharLength() {
  return (
    stringifyMessages(getState().conversation.messages).length +
    getPromptOverheadStr().length
  );
}

export function getCurrentPromptTokens() {
  if (getState().usage.promptTokens.stale) {
    return getApproxInputTokens();
  }
  return getState().usage.promptTokens.value;
}

interface TokensByArea {
  messages: number;
  tools: number;
  context: number;
  basePrompt: number;
  skills: number;
}

type TokenArea = keyof TokensByArea;

const tokenAreaToPrettyName: Record<TokenArea, string> = {
  basePrompt: "Base system prompt",
  context: "Context files",
  messages: "Chat messages",
  skills: "Skill descriptions",
  tools: "Harness and MCP tools",
};

export function getPrettyTokensByArea() {
  const tokensByArea = getTokensByArea();
  const lines = (Object.keys(tokensByArea) as TokenArea[]).map(
    (area) =>
      `- ${tokenAreaToPrettyName[area]}: ${Math.round(tokensByArea[area]).toLocaleString()}`,
  );
  return lines.join("\n");
}

export function getTokensByArea(): TokensByArea {
  const tokensByAreaApprox: TokensByArea = {
    messages: getApproxTokensFromMessages(getState().conversation.messages),
    context: strToApproxTokens(getState().content.contextStr),
    tools: strToApproxTokens(stringifyTools()),
    basePrompt: strToApproxTokens(getBaseAgentPrompt(getState().mcp.clients)),
    skills: strToApproxTokens(getState().content.skillsStr),
  };

  if (getState().usage.promptTokens.stale) {
    return tokensByAreaApprox;
  }

  const realTokens = getState().usage.promptTokens.value;
  const approxTotal = getApproxInputTokens();
  if (realTokens === 0 || approxTotal === 0) {
    return tokensByAreaApprox;
  }

  const realToApproxRatio = realTokens / approxTotal;
  const realTokensByArea = { ...tokensByAreaApprox };
  for (const area of Object.keys(realTokensByArea) as TokenArea[]) {
    realTokensByArea[area] = realTokensByArea[area] * realToApproxRatio;
  }
  return realTokensByArea;
}

export function getPrettyContextWindowUsage() {
  const { model } = getState().config;
  const contextWindow =
    getState().config.contextWindowPerModel[model] ?? defaultContextWindow;

  const currTokens = getCurrentPromptTokens();

  const currRatio = currTokens / contextWindow;
  return `${decimalToPercent(currRatio, { precision: 3 })} of context window`;
}
