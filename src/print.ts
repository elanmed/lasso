import assert from "node:assert";
import { actions, getState } from "./state.ts";
import { processDeps } from "./deps.ts";
import { getPrettyUsage } from "./usage-format.ts";
import { getMaxColLength, truncate } from "./utils.ts";

const COLORS = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  purple: "\x1b[35m",
  white: "\x1b[37m",
  grey: "\x1b[90m",
} as const;

export type Color = keyof typeof COLORS;

export function bold(text: Uint8Array | string) {
  return `\x1b[1m${text.toString()}\x1b[22m`;
}

export const print = Object.assign(
  (text: Uint8Array | string) => colorPrint(text),
  {
    doing: (text: Uint8Array | string) => colorPrint(text, "blue"),
    error: (text: Uint8Array | string) => colorPrint(text, "red"),
    info: (text: Uint8Array | string) => colorPrint(text, "purple"),
    infoSubtle: (text: Uint8Array | string) => colorPrint(text, "grey"),
    warning: (text: Uint8Array | string) => colorPrint(text, "yellow"),
  },
);

export function colorPrint(text: Uint8Array | string, color?: Color) {
  const reset = "\x1b[0m";
  const out = (() => {
    if (color !== undefined) {
      const colorCode = COLORS[color];
      return `${colorCode}${text.toString()}${reset}\n`;
    } else {
      return `${text.toString()}\n`;
    }
  })();

  const wasSpinnerActive = getState().app.loadingStateTimeout !== null;
  stopLoadingState();
  processDeps.stdout.write(out);
  if (wasSpinnerActive) startLoadingState();
  actions.appendToStdout(out);
}

export function printNewline() {
  if (getState().app.stdout.endsWith("\n\n")) return;
  colorPrint("");
}

interface FencePrintOpts {
  showSessionInfo?: boolean;
  color?: Color;
}

function wrapInFence(text: string) {
  return `━━ ${text} ━━`;
}

function getFenceSessionLine(text: string) {
  const fenceCharsLen = 6;
  const availCol = getMaxColLength();

  let accumulatedCol = fenceCharsLen;
  let sessionInfo = "";

  const fittedHeader = truncate(text, fenceCharsLen + 3);

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
    if (!showSessionInfo) return wrapInFence(bold(truncate(text, 6)));
    return wrapInFence(getFenceSessionLine(text));
  })();

  colorPrint(line, opts.color ?? "grey");
}

export function startLoadingState() {
  writeLoadingStateFrame();

  const timeout = setInterval(() => {
    writeLoadingStateFrame();
  }, getState().config.loadingStateFrameDuration);
  actions.setLoadingStateTimeout(timeout);
}

function writeLoadingStateFrame() {
  const { loadingStateFrames } = getState().config;
  processDeps.stdout.write(
    `\r${String(loadingStateFrames[getState().app.loadingStateFrameIdx % loadingStateFrames.length])}`,
  );
  actions.incrementLoadingStateFrameIdx();
}

export function stopLoadingState() {
  const { loadingStateTimeout } = getState().app;
  if (loadingStateTimeout === null) return;

  clearInterval(loadingStateTimeout);
  actions.setLoadingStateTimeout(null);

  processDeps.stdout.write(
    `\r${" ".repeat(getState().config.loadingStateFrames[0]?.length ?? 0)}\r`,
  );
  actions.resetLoadingStateFrameIdx();
}

export function getPrettyApiDuration() {
  const startTime = getState().app.apiStartTime;
  assert(startTime !== null);
  const endTime = getState().app.apiEndTime;
  assert(endTime !== null);

  const diff = Math.max(0, endTime - startTime);

  const ms = Math.floor(diff % 1000);
  const sec = Math.floor((diff / 1_000) % 60);
  const min = Math.floor(diff / 60_000);

  const prettyMs = `${String(ms)}ms`;

  const prettyMin = (() => {
    if (min > 0) {
      return `${String(min)}m `;
    }

    return "";
  })();

  const prettySec = (() => {
    if (sec > 0 || min > 0) {
      return `${String(sec)}s `;
    }

    return "";
  })();

  return `${prettyMin}${prettySec}${prettyMs}`;
}

export function printSessionStartDate() {
  print.info(
    `Resume this session with /resume ${String(getState().app.sessionStartDate)}`,
  );
}
