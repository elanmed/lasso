import { basename, extname, join } from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { AssistantContent } from "ai";
import type { ModelMessage } from "./state.ts";
import { assertAtRuntime } from "./assert.ts";
import { fsDeps, processDeps } from "./deps.ts";
import { getSessionDir } from "./paths.ts";
import type { Color } from "./print.ts";

export type Result<T> = { ok: true; value: T } | { ok: false; error: unknown };

export function getApproxTokensFromMessages(messages: ModelMessage[]) {
  const textOnly = messages.map((message) => {
    const content = message.content as string | { type: string }[];
    if (typeof content === "string") return message;
    return {
      ...message,
      content: content.filter(
        (part) => part.type !== "image" && part.type !== "file",
      ),
    };
  });
  return strToApproxTokens(JSON.stringify(textOnly));
}

export function strToApproxTokens(str: string) {
  return charLenToApproxTokens(str.length);
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

export function isReadlineClosedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE"
  );
}

export function getMessageFromError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  const json = JSON.stringify(error) as string | undefined;
  return json ?? String(error);
}

export function tryCatch<T>(cb: () => T): Result<T> {
  try {
    const result = cb();
    return { ok: true, value: result };
  } catch (err) {
    return { ok: false, error: err };
  }
}

export async function tryCatchAsync<T>(
  promise: Promise<T>,
): Promise<Result<T>> {
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

export interface GetTempFileNameArgs {
  pathPrefix?: string | undefined;
  initialContentPath?: string | undefined;
  initialContentStr?: string | undefined;
}

export function getTempFileName(args?: GetTempFileNameArgs) {
  const { pathPrefix, initialContentPath, initialContentStr } = args ?? {};
  assertAtRuntime(
    initialContentPath === undefined || initialContentStr === undefined,
  );

  const tempFile = join(
    os.tmpdir(),
    `${pathPrefix ?? "lasso"}-${getShortId()}.txt`,
  );

  if (initialContentPath !== undefined) {
    const existsResult = tryCatch(() => fsDeps.existsSync(initialContentPath));
    if (!existsResult.ok) return null;
    if (!existsResult.value) {
      const writeResult = tryCatch(() => fsDeps.writeFileSync(tempFile, ""));
      if (!writeResult.ok) return null;
      return tempFile;
    }

    const readResult = tryCatch(() =>
      fsDeps.readFileSync(initialContentPath).toString(),
    );
    if (!readResult.ok) return null;

    const writeResult = tryCatch(() =>
      fsDeps.writeFileSync(tempFile, readResult.value),
    );
    if (!writeResult.ok) return null;

    return tempFile;
  }

  if (initialContentStr !== undefined) {
    const writeResult = tryCatch(() =>
      fsDeps.writeFileSync(tempFile, initialContentStr),
    );
    if (!writeResult.ok) return null;
    return tempFile;
  }

  const writeResult = tryCatch(() => fsDeps.writeFileSync(tempFile, ""));
  if (!writeResult.ok) return null;
  return tempFile;
}

export function stringify(val: unknown) {
  return JSON.stringify(val, null, 2);
}

export function isExisty(val: unknown) {
  return val !== undefined && val !== null;
}

export function isNullish(val: unknown) {
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

interface SessionFile {
  absolutePath: string;
  timestampMs: number;
}

export async function listSessionFiles() {
  const sessionDir = getSessionDir();
  if (!fsDeps.existsSync(sessionDir)) return [];

  const sessionFiles: SessionFile[] = [];
  for (const name of await fsDeps.readdir(sessionDir)) {
    const fullPath = join(sessionDir, name);
    const statResult = await tryCatchAsync(fsDeps.stat(fullPath));
    if (!statResult.ok) continue;
    if (!statResult.value.isFile()) continue;

    const fileName = basename(name, extname(name));
    const parts = fileName.split("-");
    if (parts.length !== 2) continue;
    if (parts[0] !== "session") continue;

    const timestampMs = Number(parts[1]);
    if (Number.isNaN(timestampMs)) continue;

    if (extname(name) !== ".json") continue;

    sessionFiles.push({
      absolutePath: fullPath,
      timestampMs,
    });
  }
  return sessionFiles;
}

export function createLockUtils(lockPath: string) {
  function writeLockFile() {
    return tryCatch(() =>
      fsDeps.writeFileSync(lockPath, String(process.pid), { flag: "wx" }),
    );
  }

  function overwriteLockFile() {
    const unlinkResult = tryCatch(() => fsDeps.unlinkSync(lockPath));
    if (!unlinkResult.ok) return false;
    return writeLockFile().ok;
  }

  function writeLock() {
    const writeLockResult = writeLockFile();
    if (writeLockResult.ok) return true;

    const readLockResult = tryCatch(() =>
      fsDeps.readFileSync(lockPath).toString(),
    );
    if (!readLockResult.ok) {
      return overwriteLockFile();
    }

    const lockContentPid = Number(readLockResult.value);
    if (Number.isNaN(lockContentPid)) {
      return overwriteLockFile();
    }

    const killResult = tryCatch(() => processDeps.kill(lockContentPid, 0));
    if (killResult.ok) return false;
    if ((killResult.error as NodeJS.ErrnoException).code === "EPERM") {
      return false;
    }

    return overwriteLockFile();
  }

  return {
    async createLock() {
      let iter = 0;
      const maxIter = 10;

      let pendingWrite = !writeLock();
      while (pendingWrite && iter < maxIter) {
        await sleep(25);
        pendingWrite = !writeLock();
        iter++;
      }

      return !pendingWrite;
    },
    deleteLock() {
      tryCatch(() => fsDeps.unlinkSync(lockPath));
    },
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

export function getStrFromAssistantContent(content: AssistantContent) {
  if (typeof content === "string") return content;
  return content
    .map((c) => {
      const { type: ctype } = c;
      switch (ctype) {
        case "text": {
          return c.text;
        }
        case "file":
        case "custom":
        case "reasoning":
        case "reasoning-file":
        case "tool-call":
        case "tool-result":
        case "tool-approval-request": {
          return "";
        }
        default: {
          ctype satisfies never;
          return "";
        }
      }
    })
    .join("\n");
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

export function nonNegativeDiff<T extends number | bigint>(
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
