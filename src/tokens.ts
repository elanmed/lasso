import type { ModelMessage } from "ai";

export function getApproxTokensFromMessages(messages: ModelMessage[]) {
  const textOnly = messages.map((message) => {
    if (typeof message.content === "string") return message;
    return {
      ...message,
      content: message.content.filter(
        (part) => part.type !== "image" && part.type !== "file",
      ),
    };
  });
  return strToApproxTokens(JSON.stringify(textOnly));
}

export function strToApproxTokens(str: string) {
  return charLenToApproxTokens(str.length);
}

export function charLenToApproxTokens(charLen: number) {
  return Math.floor(charLen / 3);
}

export function approxTokensToCharLen(tokenCount: number) {
  return 3 * tokenCount;
}
