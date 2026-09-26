import { actions, getState } from "./state.ts";
import { processDeps } from "./deps.ts";
import { shouldDisableColor } from "./utils.ts";

const COLORS = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  purple: "\x1b[35m",
  white: "\x1b[37m",
  grey: "\x1b[90m",
} as const;

export type Color = keyof typeof COLORS | "none";

export function bold(text: string) {
  if (shouldDisableColor()) return text;
  return `\x1b[1m${text}\x1b[22m`;
}

interface AppendNewlineOpts {
  appendNewline?: boolean;
}

export const print = {
  doing: (text: string, opts: AppendNewlineOpts = {}) =>
    colorPrint(text, "blue", opts),
  error: (text: string, opts: AppendNewlineOpts = {}) =>
    colorPrint(text, "red", opts),
  info: (text: string, opts: AppendNewlineOpts = {}) =>
    colorPrint(text, "purple", opts),
  infoSubtle: (text: string, opts: AppendNewlineOpts = {}) =>
    colorPrint(text, "grey", opts),
  warning: (text: string, opts: AppendNewlineOpts = {}) =>
    colorPrint(text, "yellow", opts),
  plain: (text: string, opts: AppendNewlineOpts = {}) =>
    colorPrint(text, "none", opts),
};

export function colorPrint(
  text: string,
  color: Color,
  opts: AppendNewlineOpts = {},
) {
  const reset = "\x1b[0m";
  const out = (() => {
    const suffix = opts.appendNewline === false ? "" : "\n";
    if (color === "none" || shouldDisableColor()) {
      return `${text}${suffix}`;
    }
    return `${COLORS[color]}${text}${reset}${suffix}`;
  })();

  const wasSpinnerActive = getState().app.loadingStateTimeout !== null;
  stopLoadingState();
  processDeps.stdout.write(out);
  if (wasSpinnerActive) startLoadingState();
  actions.appendStdoutTail(out);
}

export function printNewline() {
  if (getState().app.stdoutTail.endsWith("\n\n")) return;
  colorPrint("", "none");
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

export function printSessionStartDate() {
  print.info(
    `Resume this session with /resume ${String(getState().app.sessionStartDate)}`,
  );
}
