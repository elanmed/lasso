import assert from "node:assert";
import { getState } from "./state.ts";
import { getMaxColLength } from "./utils.ts";

export function getUnicodeChar(char: string) {
  const map = {
    ["┊"]: "|",
    ["…"]: "~",
    ["━"]: "=",
    ["—"]: "-",
  };
  assert(char in map);
  const replacement = map[char as keyof typeof map];
  if (getState().config.asciiOnly) return replacement;
  return char;
}

export function truncate(str: string, padding = 0) {
  const maxLen = Math.max(1, getMaxColLength() - padding);
  const newlineIdx = str.indexOf("\n");
  const ellipsis = getUnicodeChar("…");

  const firstLine = (() => {
    if (newlineIdx === -1) return str;
    return str.substring(0, newlineIdx);
  })();

  if (newlineIdx !== -1) {
    return firstLine.substring(0, maxLen - 1).concat(ellipsis);
  }

  if (str.length <= maxLen) {
    return firstLine;
  }

  return firstLine.substring(0, maxLen - 1).concat(ellipsis);
}
