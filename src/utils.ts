import assert from "node:assert";
import crypto from "node:crypto";
import { dirname } from "node:path";
import * as YAML from "yaml";
import { processDeps, fsDeps } from "./deps.ts";

export function assertAtBuildtime(value: boolean): asserts value {
  assert(value);
}

export function assertAtRuntime(value: boolean): asserts value {
  assert(value);
}

interface OptionSuccess<T> {
  ok: true;
  value: T;
}
interface OptionError {
  ok: false;
  error: unknown;
}
export type Option<T> = OptionSuccess<T> | OptionError;

function isMediaPart(value: unknown) {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "image" ||
      value.type === "file" ||
      value.type === "image-data" ||
      value.type === "file-data")
  );
}

export function removeMediaReplacer(_key: string, value: unknown) {
  return isMediaPart(value) ? "[media omitted]" : value;
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

function charLenToApproxTokens(charLen: number) {
  return Math.floor(charLen / 3);
}

export function approxTokensToCharLen(tokenCount: number) {
  return 3 * tokenCount;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function getTimeoutError(signal: AbortSignal | undefined): Error | null {
  if (signal?.aborted !== true) return null;
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === "TimeoutError") return reason;
  return null;
}

export function isReadlineClosedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE"
  );
}

function maybeForceSingleLine(str: string, forceSingleLine: boolean) {
  if (forceSingleLine) {
    return str.replaceAll("\n", " ");
  }
  return str;
}

export function getMessageFromError(
  error: unknown,
  { forceSingleLine = true }: { forceSingleLine?: boolean } = {},
) {
  if (typeof error === "string") {
    return maybeForceSingleLine(error, forceSingleLine);
  }
  if (error instanceof Error) {
    return maybeForceSingleLine(error.message, forceSingleLine);
  }
  const json = JSON.stringify(error) as string | undefined;
  return maybeForceSingleLine(json ?? String(error), forceSingleLine);
}

export async function writeDebugLog(
  enabled: boolean,
  path: string,
  content: string,
) {
  if (!enabled) return;
  if (path.length === 0) return;
  if (!fsDeps.existsSync(dirname(path))) {
    const mkdirResult = await tryCatchAsync(
      fsDeps.mkdir(dirname(path), { recursive: true }),
    );
    if (!mkdirResult.ok) return;
  }

  await tryCatchAsync(
    fsDeps.appendFile(
      path,
      `${new Date(Date.now()).toISOString()} :: ${content}\n`,
    ),
  );
}

export function tryCatch<T>(cb: () => T): Option<T> {
  try {
    const result = cb();
    return { ok: true, value: result };
  } catch (err) {
    return { ok: false, error: err };
  }
}

export async function tryCatchAsync<T>(
  promise: Promise<T>,
): Promise<Option<T>> {
  try {
    const result = await promise;
    return { ok: true, value: result };
  } catch (err) {
    return { ok: false, error: err };
  }
}

export function normalizeNewline(
  content: string,
  { count = 1 }: { count?: number } = {},
): string {
  return content.trimEnd().concat("\n".repeat(count));
}

export function markdownFence(lang: string, content: string) {
  return `\`\`\`${lang}\n${content}\n\`\`\``;
}

export function getShortId(): string {
  return crypto.randomBytes(9).toString("base64url");
}

export function shellQuote(str: string) {
  const quote = "'";
  const escapedQuote = "'\\''";
  return quote + str.replaceAll(quote, escapedQuote) + quote;
}

export function isShellSafePath(str: string) {
  // ^: start of string
  // \w: letters, digits, underscore
  // /: path separator
  // .: extension dot
  // -: dash
  // +: one or more of those
  // $: end of string
  return /^[\w./-]+$/.test(str);
}

export function stringify(val: unknown) {
  return JSON.stringify(val, null, 2);
}

export function isExisty<T>(val: T): val is NonNullable<T> {
  return val !== undefined && val !== null;
}

export function isNullish(val: unknown): val is null | undefined {
  return val === undefined || val === null;
}

export function safeStringify(val: unknown) {
  if (val === undefined) return "";
  const stringifyResult = tryCatch(() => JSON.stringify(val));
  if (stringifyResult.ok) {
    const stringified = stringifyResult.value as unknown as string | undefined;
    if (stringified === undefined) return "";
    return stringified;
  }
  return getMessageFromError(stringifyResult.error);
}

export function createQueue() {
  let queue: Promise<void> = Promise.resolve();

  function enqueue(fn: () => Promise<void>): Promise<void> {
    queue = queue.then(fn, fn);
    return queue;
  }

  function flush(): Promise<void> {
    return queue;
  }

  return { enqueue, flush };
}

export function getMaxColLength() {
  return Math.max(processDeps.stdout.getColumns() ?? 80, 1);
}

export function createLockUtils(lockPath: string) {
  async function writeLockFile() {
    return await tryCatchAsync(
      fsDeps.writeFile(lockPath, String(process.pid), { flag: "wx" }),
    );
  }

  async function overwriteLockFile(expectedContent: string | null) {
    const readResult = await tryCatchAsync(fsDeps.readFile(lockPath, "utf8"));
    const currentContent = readResult.ok ? readResult.value : null;
    if (currentContent !== expectedContent) return false;

    const unlinkResult = await tryCatchAsync(fsDeps.unlink(lockPath));
    if (!unlinkResult.ok) return false;
    return (await writeLockFile()).ok;
  }

  async function writeLock() {
    const writeLockResult = await writeLockFile();
    if (writeLockResult.ok) return true;

    const readLockResult = await tryCatchAsync(
      fsDeps.readFile(lockPath, "utf8"),
    );
    if (!readLockResult.ok) {
      return overwriteLockFile(null);
    }

    const lockContentPid = Number(readLockResult.value);
    if (Number.isNaN(lockContentPid)) {
      return overwriteLockFile(readLockResult.value);
    }

    const killResult = tryCatch(() => processDeps.kill(lockContentPid, 0));
    if (killResult.ok) return false;
    if ((killResult.error as NodeJS.ErrnoException).code === "EPERM") {
      return false;
    }

    return await overwriteLockFile(readLockResult.value);
  }

  return {
    async createLock() {
      let iter = 0;
      const maxIter = 10;

      let pendingWrite = !(await writeLock());
      while (pendingWrite && iter < maxIter) {
        await sleep(25);
        pendingWrite = !(await writeLock());
        iter++;
      }

      return !pendingWrite;
    },
    async deleteLock() {
      await tryCatchAsync(fsDeps.unlink(lockPath));
    },
  };
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

export function shouldDisableColor() {
  return (
    processDeps.env.get("NO_COLOR") !== undefined || !processDeps.stdout.isTTY()
  );
}

export function decimalToPercent(
  decimal: number,
  { precision = 2 }: { precision?: number } = {},
) {
  return `${String(Number((decimal * 100).toFixed(precision)))}%`;
}

function nonNegativeDiff<T extends number | bigint>(
  startTime: T,
  endTime: T,
): T {
  const zero = typeof startTime === "bigint" ? 0n : 0;
  return (endTime > startTime ? endTime - startTime : zero) as T;
}

export function getDurationColor(startTime: bigint, endTime: bigint): Color {
  const diffNs = nonNegativeDiff(startTime, endTime);
  if (diffNs < 500_000_000n) return "green";
  if (diffNs < 1_000_000_000n) return "yellow";
  return "red";
}

export function getPrettyDuration(
  startTime: bigint,
  endTime: bigint,
  { includeMicroseconds = false }: { includeMicroseconds?: boolean } = {},
) {
  const diffNs = nonNegativeDiff(startTime, endTime);
  const ms = Number((diffNs % 1_000_000_000n) / 1_000_000n);
  const us = Number((diffNs % 1_000_000n) / 1_000n);
  const sec = Number((diffNs / 1_000_000_000n) % 60n);
  const min = Number(diffNs / 60_000_000_000n);

  const prettyMs = includeMicroseconds
    ? `${String(ms)}.${String(us)}ms`
    : `${String(ms)}ms`;

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

export function getPrettyDate(timestamp: number) {
  return new Date(timestamp).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

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

export function wrapInColor(text: string, color: Color) {
  const reset = "\x1b[0m";
  if (color === "none") return text;
  return `${COLORS[color]}${text}${reset}`;
}

export function parseFrontMatter(content: string) {
  if (!content.startsWith("---\n")) return null;

  // start search on the char after the ---\n
  const closeIndex = content.indexOf("\n---", 4);
  if (closeIndex === -1) return null;

  // start slice on the char after the ---\n
  const yamlStr = content.slice(4, closeIndex);
  if (yamlStr === "") return null;
  const parseResult = tryCatch(() => YAML.parse(yamlStr) as unknown);
  if (!parseResult.ok) return null;

  // start slice on the char after the \n---
  const body = content.slice(closeIndex + 5);
  return { data: parseResult.value, body };
}

const lockQueues = new Map<string, ReturnType<typeof createQueue>>();

export function getLockQueue(lockPath: string) {
  let queue = lockQueues.get(lockPath);
  if (queue === undefined) {
    queue = createQueue();
    lockQueues.set(lockPath, queue);
  }
  return queue;
}

export function orApproxTokens(value: number | undefined, text: string) {
  return value ?? strToApproxTokens(text);
}

export function getPrettyMoney(money: number) {
  return money.toLocaleString("en-US", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}
