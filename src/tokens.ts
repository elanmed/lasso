import { removeMediaReplacer, decimalToPercent } from "./utils.ts";
import { getState } from "./state.ts";
import { getBaseAgentPrompt } from "./prompts.ts";
import {
  dedicatedSummaryRatio,
  maxTokenCountPerSummary,
  type ModelMessage,
} from "./schemas.ts";
import { print } from "./printing.ts";
import { stringifyTools } from "./tools.ts";

function charLenToApproxTokens(charLen: number) {
  const { requestInputTokens } = getState().usage;
  if (
    requestInputTokens.stale ||
    requestInputTokens.value === 0 ||
    requestInputTokens.charLength === 0
  ) {
    return Math.floor(charLen / 3);
  }

  const tokensPerChar =
    requestInputTokens.value / requestInputTokens.charLength;
  return Math.floor(charLen * tokensPerChar);
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

export const dedicatedRequestInputOverheadRatio =
  compactTriggerRatio - dedicatedSummaryRatio;

export const defaultContextWindow = 128_000;

export const maxCharCountPerSummary = approxTokensToCharLen(
  maxTokenCountPerSummary,
);

export function getDefaultedContextWindow() {
  const { model, contextWindowPerModel } = getState().config;
  return contextWindowPerModel[model] ?? defaultContextWindow;
}

export function getMaxNumberSummaries() {
  const contextWindow = getDefaultedContextWindow();
  const allSummariesTokenCount = dedicatedSummaryRatio * contextWindow;
  return Math.floor(allSummariesTokenCount / maxTokenCountPerSummary);
}

export function getRequestInputOverheadTokensApprox() {
  return strToApproxTokens(getRequestInputOverheadStr());
}

export function getRequestInputOverheadStr() {
  return getSystemContent() + stringifyTools();
}

export function printLargeContextOverheadWarning() {
  const contextWindow = getDefaultedContextWindow();

  const requestInputOverheadTokensApprox =
    getRequestInputOverheadTokensApprox();

  const requestInputOverheadRatio =
    requestInputOverheadTokensApprox / contextWindow;
  if (requestInputOverheadRatio >= dedicatedRequestInputOverheadRatio) {
    print.warning(
      `The current set of context, skills, and tools is ${decimalToPercent(requestInputOverheadRatio)} of the ${contextWindow.toLocaleString()} token context window!

Lasso reserves ${decimalToPercent(dedicatedSummaryRatio)} of the context window for compacted summaries with the assumption that at most ${decimalToPercent(dedicatedRequestInputOverheadRatio)} of the context window will be used for input overhead. As is, the input overhead is large enough to break this assumption and, along with any user messages, may breach the llm's context window and cause API calls to be rejected. Consider converting some of your context to skills and minimizing MCP servers.`,
    );
  }
}

export function getApproxRequestInputTokens() {
  return (
    getApproxTokensFromMessages(getState().conversation.messages) +
    getRequestInputOverheadTokensApprox()
  );
}

export function getRequestInputCharLength() {
  return (
    stringifyMessages(getState().conversation.messages).length +
    getRequestInputOverheadStr().length
  );
}

export function resolveRequestInputTokens() {
  if (getState().usage.requestInputTokens.stale) {
    return getApproxRequestInputTokens();
  }
  return getState().usage.requestInputTokens.value;
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
  return {
    messages: getApproxTokensFromMessages(getState().conversation.messages),
    context: strToApproxTokens(getState().content.contextStr),
    tools: strToApproxTokens(stringifyTools()),
    basePrompt: strToApproxTokens(getBaseAgentPrompt(getState().mcp.clients)),
    skills: strToApproxTokens(getState().content.skillsStr),
  };
}

export function getPrettyContextWindowUsage() {
  const contextWindow = getDefaultedContextWindow();

  const inputTokens = resolveRequestInputTokens();

  const inputRatio = inputTokens / contextWindow;
  return `${decimalToPercent(inputRatio, { precision: 3 })} of context window`;
}
