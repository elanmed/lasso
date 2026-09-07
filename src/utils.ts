import { basename, extname, join } from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import { fsDeps, processDeps } from "./deps.ts";
import { getPromptHistoryDir } from "./paths.ts";
import assert from "node:assert";
import { checkBat, baseBatFlags, markdownBatFlags } from "./print.ts";
import { printGitDiff } from "./tools.ts";

export type Result<T> = { ok: true; value: T } | { ok: false; error: unknown };

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
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

export function normalizeLine(content: string): string {
  return content.trim().concat("\n");
}

export function getShortId(): string {
  return crypto.randomBytes(9).toString("base64url");
}

interface GetTempFileNameArgs {
  pathPrefix?: string | undefined;
  initialContentPath?: string | undefined;
  initialContentStr?: string | undefined;
}

export function getTempFileName(args?: GetTempFileNameArgs) {
  const { pathPrefix, initialContentPath, initialContentStr } = args ?? {};
  assert(initialContentPath === undefined || initialContentStr === undefined);

  const tempFile = join(
    os.tmpdir(),
    `${pathPrefix ?? "lasso"}-${getShortId()}.txt`,
  );

  if (initialContentPath !== undefined) {
    const readResult = tryCatch(() =>
      fsDeps.readFileSync(initialContentPath).toString(),
    );
    if (readResult.ok) {
      tryCatch(() => fsDeps.writeFileSync(tempFile, readResult.value));
    }
  } else if (initialContentStr !== undefined) {
    tryCatch(() => fsDeps.writeFileSync(tempFile, initialContentStr));
  } else {
    tryCatch(() => fsDeps.writeFileSync(tempFile, ""));
  }

  return tempFile;
}

export async function openWithPager({
  pagerEnvKey,
  initialContentPath,
  initialContentStr,
  contentType,
}: {
  initialContentPath?: string;
  initialContentStr?: string;
  pagerEnvKey: string;
  contentType: "diff" | "markdown";
}) {
  assert(initialContentPath === undefined || initialContentStr === undefined);

  const tempFile = getTempFileName({ initialContentPath, initialContentStr });

  const pagerCommand = await (async () => {
    const pagerEnvValue = processDeps.env.get(pagerEnvKey);
    if (isExisty(pagerEnvValue)) {
      return pagerEnvValue.replace("__FILE__", tempFile);
    }

    const lassoDefaultPagerEnvValue = processDeps.env.get("LASSO_PAGER");
    if (isExisty(lassoDefaultPagerEnvValue)) {
      return lassoDefaultPagerEnvValue.replace("__FILE__", tempFile);
    }

    const defaultPagerEnvValue = processDeps.env.get("PAGER");
    if (isExisty(defaultPagerEnvValue)) {
      return `${defaultPagerEnvValue} "${tempFile}"`;
    }

    const isBatAvailable = await checkBat();
    if (isBatAvailable) {
      const batFlags =
        contentType === "diff"
          ? baseBatFlags
          : baseBatFlags.concat(markdownBatFlags);

      return `bat ${batFlags.join(" ")} --paging=always "${tempFile}"`;
    }

    return `less "${tempFile}"`;
  })();

  childProcess.spawnSync(pagerCommand, {
    shell: true,
    stdio: "inherit",
  });
}

export function execPromise(
  command: string,
  options?: { signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    childProcess.exec(
      command,
      { encoding: "utf8", ...options },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

export function stringify(val: unknown) {
  return JSON.stringify(val, null, 2);
}

export function isExisty(val: unknown) {
  return val !== undefined && val !== null;
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

export function truncate(str: string) {
  const columns = processDeps.stdout.getColumns() ?? 80;
  const maxLen = 0.9 * columns;
  const newlineIdx = str.indexOf("\n");

  const firstLine = (() => {
    if (newlineIdx === -1) return str;
    return str.substring(0, newlineIdx);
  })();

  if (newlineIdx !== -1) {
    return firstLine.substring(0, maxLen).concat("…");
  }

  if (str.length <= maxLen) {
    return firstLine;
  }

  return firstLine.substring(0, maxLen).concat("…");
}

interface ChatHistoryEntry {
  absolutePath: string;
  timestampMs: number;
}

export function listChatHistoryFiles() {
  const chatHistoryPath = getPromptHistoryDir();
  if (!fsDeps.existsSync(chatHistoryPath)) return [];

  const chatHistoryFiles: ChatHistoryEntry[] = [];
  for (const name of fsDeps.readdirSync(chatHistoryPath)) {
    const fullPath = join(chatHistoryPath, name);
    const statResult = tryCatch(() => fsDeps.statSync(fullPath));
    if (!statResult.ok) continue;
    if (!statResult.value.isFile()) continue;

    const fileName = basename(name, extname(name));
    const parts = fileName.split("-");
    if (parts.length !== 3) continue;
    if (parts[0] !== "chat" || parts[1] !== "history") continue;

    const timestampMs = Number(parts[2]);
    if (Number.isNaN(timestampMs)) continue;

    if (extname(name) !== ".md") continue;

    chatHistoryFiles.push({
      absolutePath: fullPath,
      timestampMs,
    });
  }
  return chatHistoryFiles;
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

      return iter < maxIter;
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

export function createToolCallDiffer() {
  const toolCallIdToTempFileBefore = new Map<string, string>();

  function setTempFileBefore(toolCallId: string, args?: GetTempFileNameArgs) {
    const tempFileBefore = getTempFileName(args);
    toolCallIdToTempFileBefore.set(toolCallId, tempFileBefore);
  }

  function getTempFileBefore(toolCallId: string) {
    const tempFileBefore = toolCallIdToTempFileBefore.get(toolCallId);
    assert(tempFileBefore !== undefined);
    return tempFileBefore;
  }

  async function diffAndCleanup(toolCallId: string, path: string) {
    const tempFileAfter = getTempFileName({ initialContentPath: path });
    const tempFileBefore = getTempFileBefore(toolCallId);
    await printGitDiff({
      tempFileBeforePath: tempFileBefore,
      tempFileAfterPath: tempFileAfter,
      path,
    });
    fsDeps.unlinkSync(tempFileAfter);
    cleanupTempFileBefore(toolCallId);
  }

  function cleanupTempFileBefore(toolCallId: string) {
    const tempFile = getTempFileBefore(toolCallId);
    fsDeps.unlinkSync(tempFile);
    toolCallIdToTempFileBefore.delete(toolCallId);
  }

  function cleanupAllTempFileBefore() {
    for (const tempFile of toolCallIdToTempFileBefore.values()) {
      fsDeps.unlinkSync(tempFile);
    }
  }

  return {
    toolCallIdToTempFileBefore,
    setTempFileBefore,
    getTempFileBefore,
    diffAndCleanup,
    cleanupTempFileBefore,
    cleanupAllTempFileBefore,
  };
}
