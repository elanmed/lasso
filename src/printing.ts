import os from "node:os";
import { join } from "node:path";
import { stdin } from "node:process";
import { format } from "prettier";
import {
  assertAtBuildtime,
  tryCatchAsync,
  getMessageFromError,
  assertAtRuntime,
  tryCatch,
  normalizeNewline,
  getShortId,
  isShellSafePath,
  getMaxColLength,
  shouldDisableColor,
  getDurationColor,
  getPrettyDuration,
  type Color,
  bold,
  wrapInColor,
} from "./utils.ts";
import { actions, getState } from "./state.ts";
import { childProcessDeps, fsDeps, processDeps } from "./deps.ts";

export function getUnicodeChar(char: string) {
  const map = {
    ["┊"]: "|",
    ["…"]: "~",
    ["━"]: "=",
  };
  assertAtRuntime(char in map);
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

interface AppendNewlineOpts {
  appendNewline?: boolean;
  whileBuffering?: boolean;
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
  const out = (() => {
    const suffix = opts.appendNewline === false ? "" : "\n";
    if (color === "none" || shouldDisableColor()) {
      return `${text}${suffix}`;
    }
    return `${wrapInColor(text, color)}${suffix}`;
  })();

  if (opts.whileBuffering === true) {
    // Print immediately instead of buffering output while the editor is open.
    processDeps.stdout.write(out);
    return;
  }

  const { isNonBlockingProcessOngoing } = getState().terminal;
  if (isNonBlockingProcessOngoing) {
    actions.terminal.appendBufferedStdoutWhileEditorOpen(out);
    actions.terminal.appendStdoutTail(out);
    return;
  }

  const wasSpinnerActive = getState().terminal.loadingStateTimeout !== null;
  stopLoadingState();
  processDeps.stdout.write(out);
  if (wasSpinnerActive) startLoadingState();
  actions.terminal.appendStdoutTail(out);
}

export function createPerformanceLogger({
  logDuration,
}: {
  logDuration: boolean;
}) {
  let startTime: bigint | null = null;
  function start(label: string) {
    if (!logDuration) return;
    assertAtRuntime(startTime === null);
    startTime = process.hrtime.bigint();
    print.doing(label, { appendNewline: false });
  }

  function end() {
    if (!logDuration) return;
    assertAtRuntime(startTime !== null);
    const endTime = process.hrtime.bigint();
    const duration = getPrettyDuration(startTime, endTime, {
      includeMicroseconds: true,
    });
    colorPrint(duration, getDurationColor(startTime, endTime));
    startTime = null;
  }

  return { start, end };
}

export type ParallelPerformanceLogger = ReturnType<
  typeof createParallelPerformanceLogger
>;

export type LogIdToLabel = [logId: string, label: string][];

export function createParallelPerformanceLogger({
  logDuration,
  logIdToLabel,
}: {
  logDuration: boolean;
  logIdToLabel: LogIdToLabel;
}) {
  const startTimeByLogId = new Map<string, bigint>();
  const labels = logIdToLabel.map(([, label]) => label);

  function printAllLabels() {
    if (!logDuration) return;
    for (const labelContent of labels) {
      print.doing(labelContent);
    }
  }

  function start(logId: string) {
    if (!logDuration) return;
    startTimeByLogId.set(logId, process.hrtime.bigint());
  }

  function end(logId: string) {
    if (!logDuration) return;
    const startTime = startTimeByLogId.get(logId);
    assertAtRuntime(startTime !== undefined);
    const endTime = process.hrtime.bigint();
    const duration = getPrettyDuration(startTime, endTime, {
      includeMicroseconds: true,
    });
    const labelEntry = logIdToLabel.find(([id]) => id === logId);
    assertAtBuildtime(labelEntry !== undefined);
    const labelIndex = logIdToLabel.indexOf(labelEntry);
    const linesUp = labels.length - labelIndex;
    const label = labelEntry[1];
    processDeps.stdout.write(`\x1b[${String(linesUp)}A\x1b[2K\r`);
    print.doing(label, { appendNewline: false });
    colorPrint(duration, getDurationColor(startTime, endTime), {
      appendNewline: false,
    });
    processDeps.stdout.write(`\x1b[${String(linesUp)}B\r`);
  }

  return { printAllLabels, start, end };
}

export function printNewline() {
  if (getState().terminal.stdoutTail.endsWith("\n\n")) return;
  colorPrint("", "none");
}

export function successWithSpacing(cb: () => void) {
  printNewline();
  cb();
  printNewline();
}

export function errorWithSpacing(cb: () => void) {
  cb();
  printNewline();
}

export function startLoadingState() {
  if (getState().terminal.isNonBlockingProcessOngoing) return;

  writeLoadingStateFrame();
  const timeout = setInterval(() => {
    writeLoadingStateFrame();
  }, getState().config.loadingStateFrameDuration);
  actions.terminal.setLoadingStateTimeout(timeout);
}

function writeLoadingStateFrame() {
  const { loadingStateFrames } = getState().config;
  processDeps.stdout.write(
    `\r${String(loadingStateFrames[getState().terminal.loadingStateFrameIdx % loadingStateFrames.length])}`,
  );
  actions.terminal.incrementLoadingStateFrameIdx();
}

export function stopLoadingState() {
  const { loadingStateTimeout } = getState().terminal;
  if (loadingStateTimeout === null) return;

  clearInterval(loadingStateTimeout);
  actions.terminal.setLoadingStateTimeout(null);

  processDeps.stdout.write(
    `\r${" ".repeat(getState().config.loadingStateFrames[0]?.length ?? 0)}\r`,
  );
  actions.terminal.resetLoadingStateFrameIdx();
}

export function printSessionStartDate() {
  print.info(
    `Resume this session with /resume ${String(getState().session.sessionStartDate)}`,
  );
}

interface FencePrintOpts {
  showSessionInfo?: boolean;
  color?: Color;
}

export function wrapInFence(text: string) {
  const fence = getUnicodeChar("━").repeat(2);
  return `${fence} ${text} ${fence}`;
}

export function getFenceSessionLine(
  text: string,
  sessionInfoSegments: (() => string)[],
) {
  const fenceCharsLen = 6;
  const availCol = getMaxColLength();

  let accumulatedCol = fenceCharsLen;
  let sessionInfo = "";

  const fittedHeader = truncate(text, fenceCharsLen);

  sessionInfo += bold(fittedHeader);
  accumulatedCol += fittedHeader.length;

  for (const sessionInfoSegment of sessionInfoSegments) {
    const sessionInfoSegmentText = ` (${sessionInfoSegment()})`;
    if (accumulatedCol + sessionInfoSegmentText.length > availCol) {
      return sessionInfo;
    }
    sessionInfo += sessionInfoSegmentText;
    accumulatedCol += sessionInfoSegmentText.length;
  }

  return sessionInfo;
}

export function createFencePrint({
  sessionInfoSegments,
}: {
  sessionInfoSegments: (() => string)[];
}) {
  return function fencePrint(text: string, opts: FencePrintOpts = {}) {
    const showSessionInfo = opts.showSessionInfo ?? false;

    const line = (() => {
      const fenceCharsLen = 6;
      if (!showSessionInfo) {
        return wrapInFence(bold(truncate(text, fenceCharsLen)));
      }
      return wrapInFence(getFenceSessionLine(text, sessionInfoSegments));
    })();

    colorPrint(line, opts.color ?? "grey");
  };
}

export interface GetTempFileNameArgs {
  pathPrefix?: string | undefined;
  initialContentPath?: string | undefined;
  initialContentStr?: string | undefined;
  extension?: string;
}

export async function getTempFileName(args?: GetTempFileNameArgs) {
  const { pathPrefix, initialContentPath, initialContentStr, extension } =
    args ?? {};
  assertAtRuntime(
    initialContentPath === undefined || initialContentStr === undefined,
  );

  const tempFile = join(
    os.tmpdir(),
    `${pathPrefix ?? "lasso"}-${getShortId()}.${extension ?? "txt"}`,
  );

  assertAtRuntime(isShellSafePath(tempFile));

  if (initialContentPath !== undefined) {
    const existsResult = tryCatch(() => fsDeps.existsSync(initialContentPath));
    if (!existsResult.ok) {
      print.error(
        `Failed to create a temp file with content from path ${initialContentPath}. Error: ${getMessageFromError(existsResult.error)}`,
      );
      return null;
    }
    if (!existsResult.value) {
      const writeResult = await tryCatchAsync(fsDeps.writeFile(tempFile, ""));
      if (!writeResult.ok) {
        print.error(
          `Failed to write an empty temp file. Error: ${getMessageFromError(writeResult.error)}`,
        );
        return null;
      }
      return tempFile;
    }

    const readResult = await tryCatchAsync(
      fsDeps.readFile(initialContentPath, "utf8"),
    );
    if (!readResult.ok) {
      print.error(
        `Failed to read the content from path ${initialContentPath} to prepopulate a temp file. Error: ${getMessageFromError(readResult.error)}`,
      );
      return null;
    }

    const writeResult = await tryCatchAsync(
      fsDeps.writeFile(tempFile, readResult.value),
    );
    if (!writeResult.ok) {
      print.error(
        `Failed to write a temp file with the content from path ${initialContentPath}: ${getMessageFromError(writeResult.error)}`,
      );
      return null;
    }

    return tempFile;
  }

  if (initialContentStr !== undefined) {
    const writeResult = await tryCatchAsync(
      fsDeps.writeFile(tempFile, initialContentStr),
    );
    if (!writeResult.ok) {
      print.error(
        `Failed to write to a temp file. Error: ${getMessageFromError(writeResult.error)}`,
      );
      return null;
    }
    return tempFile;
  }

  const writeResult = await tryCatchAsync(fsDeps.writeFile(tempFile, ""));
  if (!writeResult.ok) {
    print.error(
      `Failed to create an empty temp file. Error: ${getMessageFromError(writeResult.error)}`,
    );
    return null;
  }
  return tempFile;
}

export async function formatMarkdown(content: string): Promise<string> {
  const formatResult = await tryCatchAsync(
    format(content, { parser: "markdown" }),
  );
  if (formatResult.ok) return formatResult.value;
  print.error(
    `Outputting raw content, markdown formatting failed: ${getMessageFromError(formatResult.error)}`,
  );
  return content;
}

export async function executeBat(content: string) {
  content = await formatMarkdown(content);
  content = normalizeNewline(content);
  if (!getState().content.batAvailable) {
    return print.plain(content);
  }

  function fallbackPrint(message: string) {
    print.error(message);
    print.plain(content);
  }
  const baseMessage =
    "Falling back to plain text rendering, an error occurred when spawning `bat`: ";
  const batResult = spawnBat(content);
  if (!batResult.ok) {
    return fallbackPrint(
      baseMessage.concat(getMessageFromError(batResult.error)),
    );
  }
  if (batResult.value.status !== null && batResult.value.status !== 0) {
    return fallbackPrint(
      baseMessage.concat(
        `\`bat\` returned code ${String(batResult.value.status)}`,
      ),
    );
  }
  if (batResult.value.stderr.length !== 0) {
    return fallbackPrint(baseMessage.concat(batResult.value.stderr));
  }
  print.plain(batResult.value.stdout);
}

export function toolPrint(
  label: string,
  detail: string,
  { maxLines = 5 }: { maxLines?: number } = {},
) {
  const detailArr = detail.split("\n").filter((str) => str.length > 0);
  const colonSpaceLen = 2;
  const labelLen = label.length + colonSpaceLen;
  const indent = " ".repeat(7).concat(getUnicodeChar("┊"));
  const lines = [];

  let detailIdx = 0;
  let strIdx = 0;
  while (lines.length < maxLines && detailIdx < detailArr.length) {
    const detailLine = detailArr[detailIdx];
    assertAtBuildtime(detailLine !== undefined);

    let maxLen = (() => {
      if (lines.length === 0) return getMaxColLength() - labelLen;
      return getMaxColLength() - indent.length;
    })();
    maxLen = Math.max(1, maxLen);

    const splitStr = detailLine.slice(strIdx, strIdx + maxLen);
    strIdx += splitStr.length;
    if (strIdx >= detailLine.length) {
      detailIdx++;
      strIdx = 0;
    }

    const prefix = (() => {
      if (lines.length === 0) return `${bold(label)}: `;
      return indent;
    })();

    lines.push(prefix.concat(splitStr));
  }

  const overflow = lines.length === maxLines && detailIdx < detailArr.length;

  if (overflow) {
    const lastLine = lines.pop();
    assertAtBuildtime(lastLine !== undefined);

    const ellipsis = getUnicodeChar("…");
    const newLastLine = (() => {
      if (lastLine.length >= getMaxColLength()) {
        return lastLine.slice(0, -1).concat(ellipsis);
      } else {
        return lastLine.concat(ellipsis);
      }
    })();
    lines.push(newLastLine);
  }

  const linesStr = lines.join("\n");

  print.doing(linesStr);
}

export type ToolPrint = typeof toolPrint;

export async function wrapToOpenNonBlockingProcess<T>(
  cb: () => Promise<T>,
  { pauseStdin = true }: { pauseStdin?: boolean } = {},
) {
  actions.terminal.setIsNonBlockingProcessOngoing(true);
  stopLoadingState();
  if (pauseStdin) stdin.pause();
  const ret = await cb();
  stdin.resume();
  actions.terminal.setIsNonBlockingProcessOngoing(false);
  const bufferedStdout = getState().terminal.bufferedStdoutWhileEditorOpen;
  if (bufferedStdout.length > 0) {
    processDeps.stdout.write(bufferedStdout);
    actions.terminal.resetBufferedStdoutWhileEditorOpen();
  }
  if (getState().abortControllers.apiStream !== null) {
    startLoadingState();
  }
  return ret;
}

export interface SpacingOpts {
  isTyped?: boolean;
}

export function streamingSupportedWithSpacing(
  isTyped: boolean,
  cb: () => void,
) {
  if (getState().abortControllers.apiStream !== null) {
    cb();
    return;
  }

  if (isTyped) {
    cb();
    printNewline();
    return;
  }

  printNewline();
  cb();
  printNewline();
}

export async function execGitDiff(opts: {
  tempFileBeforePath: string;
  tempFileAfterPath: string;
  includeFilename?: boolean;
}): Promise<{ stdout: string; stderr: string }> {
  const deltaResult = await tryCatchAsync(
    childProcessDeps.exec("delta --version"),
  );
  const isDeltaAvailable = deltaResult.ok;

  const colorFlag = shouldDisableColor() ? "--color=never" : "--color=always";
  const base = `git diff --no-index ${colorFlag} -U3 ${opts.tempFileBeforePath} ${opts.tempFileAfterPath}`;
  const fileStyle = opts.includeFilename === true ? "normal" : "omit";
  const command = isDeltaAvailable
    ? `${base} | delta --paging=never --line-numbers --hunk-header-style=omit --file-style=${fileStyle}`
    : base;
  const result = await tryCatchAsync(
    childProcessDeps.exec(command, { cwd: os.tmpdir() }),
  );
  // exit code 1 for files that differ
  // exec treats exit code 1 as an error

  if (!result.ok) {
    const code = (result.error as { code?: number }).code;
    const isError = (() => {
      if (code === undefined) return true;
      if (isDeltaAvailable) return code > 1;
      return [2, 127, 128].includes(code) || code > 128;
    })();

    if (isError) {
      throw result.error;
    }
  }

  if (result.ok) return result.value;

  const obj: { stdout: string; stderr: string } = { stderr: "", stdout: "" };
  if (
    typeof result.error === "object" &&
    result.error !== null &&
    "stdout" in result.error &&
    typeof result.error.stdout === "string"
  ) {
    obj.stdout = result.error.stdout;
  }

  if (
    typeof result.error === "object" &&
    result.error !== null &&
    "stderr" in result.error &&
    typeof result.error.stderr === "string"
  ) {
    obj.stderr = result.error.stderr;
  }
  return obj;
}

export function spawnBat(input: string) {
  return tryCatch(() =>
    childProcessDeps.spawnSync(
      "bat",
      [...baseBatFlags(), ...markdownBatFlags, "--paging=never", "-"],
      {
        input,
        encoding: "utf8",
      },
    ),
  );
}

export const markdownBatFlags = ["--language", "md", "--italic-text=always"];

export function baseBatFlags() {
  return shouldDisableColor()
    ? ["--style=plain", "--color=never"]
    : ["--style=plain", "--color=always"];
}
