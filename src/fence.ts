import assert from "node:assert";
import { getState } from "./state.ts";
import { getPrettyUsage } from "./usage-format.ts";
import { getMaxColLength, getPrettyDuration } from "./utils.ts";
import { getUnicodeChar, truncate } from "./text.ts";
import { bold, colorPrint, type Color } from "./print.ts";

interface FencePrintOpts {
  showSessionInfo?: boolean;
  color?: Color;
}

export function wrapInFence(text: string) {
  const fence = getUnicodeChar("━").repeat(2);
  return `${fence} ${text} ${fence}`;
}

function getFenceSessionLine(text: string) {
  const fenceCharsLen = 6;
  const availCol = getMaxColLength();

  let accumulatedCol = fenceCharsLen;
  let sessionInfo = "";

  const fittedHeader = truncate(text, fenceCharsLen);

  sessionInfo += bold(fittedHeader);
  accumulatedCol += fittedHeader.length;

  const prettyApiDurationInfo = ` (${getPrettyApiDuration()})`;
  if (accumulatedCol + prettyApiDurationInfo.length > availCol) {
    return sessionInfo;
  }
  sessionInfo += prettyApiDurationInfo;
  accumulatedCol += prettyApiDurationInfo.length;

  const prettyUsageInfo = ` (${getPrettyUsage()})`;
  if (accumulatedCol + prettyUsageInfo.length > availCol) {
    return sessionInfo;
  }
  sessionInfo += prettyUsageInfo;
  accumulatedCol += prettyUsageInfo.length;

  return sessionInfo;
}

export function fencePrint(text: string, opts: FencePrintOpts = {}) {
  const showSessionInfo = opts.showSessionInfo ?? false;

  const line = (() => {
    const fenceCharsLen = 6;
    if (!showSessionInfo) {
      return wrapInFence(bold(truncate(text, fenceCharsLen)));
    }
    return wrapInFence(getFenceSessionLine(text));
  })();

  colorPrint(line, opts.color ?? "grey");
}

export function getPrettyApiDuration({
  includeMicroseconds = false,
}: { includeMicroseconds?: boolean } = {}) {
  const startTime = getState().app.apiStartTime;
  assert(startTime !== null);
  const endTime = getState().app.apiEndTime;
  assert(endTime !== null);

  return getPrettyDuration(startTime, endTime, { includeMicroseconds });
}
