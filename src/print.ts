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

export function fencePrint(text: string, opts: FencePrintOpts = {}) {
  const showSessionInfo = opts.showSessionInfo ?? false;

  const fenceCharsLen = 6;
  const parensPlusSpace = 3;
  const availCol = getMaxColLength();

  const line = (() => {
    if (!showSessionInfo) return `━━ ${bold(truncate(text, fenceCharsLen))} ━━`;

    let accumulatedCol = fenceCharsLen;
    let sessionInfo = "";

    const fittedHeader = truncate(text, fenceCharsLen + parensPlusSpace);

    sessionInfo += bold(fittedHeader);
    accumulatedCol += fittedHeader.length;

    const prettyApiDuration = getPrettyApiDuration();
    if (
      accumulatedCol + prettyApiDuration.length + parensPlusSpace >
      availCol
    ) {
      return `━━ ${sessionInfo} ━━`;
    }
    sessionInfo += ` (${prettyApiDuration})`;
    accumulatedCol += prettyApiDuration.length + parensPlusSpace;

    const prettyUsage = getPrettyUsage();
    if (accumulatedCol + prettyUsage.length + parensPlusSpace > availCol) {
      return `━━ ${sessionInfo} ━━`;
    }
    sessionInfo += ` (${prettyUsage})`;
    accumulatedCol += prettyUsage.length;

    return `━━ ${sessionInfo} ━━`;
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
