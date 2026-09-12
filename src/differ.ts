import assert from "node:assert";
import os from "node:os";
import childProcess from "node:child_process";
import { fsDeps } from "./deps.ts";
import { fencePrint, print, printNewline } from "./print.ts";
import {
  execPromise,
  getMessageFromError,
  getTempFileName,
  type GetTempFileNameArgs,
  normalizeLine,
  shouldDisableColor,
  tryCatchAsync,
} from "./utils.ts";

export async function execGitDiff(opts: {
  tempFileBeforePath: string;
  tempFileAfterPath: string;
  includeFilename?: boolean;
}): Promise<{ stdout: string; stderr: string }> {
  const deltaResult = await tryCatchAsync(execPromise("delta --version"));
  const isDeltaAvailable = deltaResult.ok;

  const colorFlag = shouldDisableColor() ? "--color=never" : "--color=always";
  const base = `git diff --no-index ${colorFlag} -U3 ${opts.tempFileBeforePath} ${opts.tempFileAfterPath}`;
  const fileStyle = opts.includeFilename === true ? "normal" : "omit";
  const command = isDeltaAvailable
    ? `${base} | delta --paging=never --line-numbers --hunk-header-style=omit --file-style=${fileStyle}`
    : base;
  return new Promise((resolve, reject) => {
    childProcess.exec(
      command,
      { cwd: os.tmpdir() },
      (error, stdout, stderr) => {
        if (error?.code !== undefined) {
          const isError = isDeltaAvailable ? error.code > 1 : error.code >= 128;
          if (isError) {
            reject(error);
            return;
          }
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export async function printGitDiff({
  path,
  tempFileAfterPath,
  tempFileBeforePath,
}: {
  tempFileBeforePath: string;
  tempFileAfterPath: string;
  path: string;
}) {
  const diffResult = await tryCatchAsync(
    execGitDiff({
      tempFileBeforePath,
      tempFileAfterPath,
    }),
  );

  if (!diffResult.ok) {
    print.error(
      `An error occurred when getting the diff for ${path}: ${getMessageFromError(diffResult.error)}`,
    );
    return;
  }

  if (diffResult.value.stdout.length > 0) {
    printNewline();
    fencePrint(`File change: ${path}`);
    print(normalizeLine(diffResult.value.stdout));
    printNewline();
  }
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
    toolCallIdToTempFileBefore.clear();
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
