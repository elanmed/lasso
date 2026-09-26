import os from "node:os";
import childProcess from "node:child_process";
import { assertAtRuntime } from "./assert.ts";
import { fsDeps } from "./deps.ts";
import { fencePrint } from "./fence.ts";
import { print, printNewline } from "./print.ts";
import {
  execPromise,
  getMessageFromError,
  getTempFileName,
  normalizeNewline,
  shouldDisableColor,
  tryCatch,
  tryCatchAsync,
} from "./utils.ts";
import { actions, getState } from "./state.ts";

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
          const isError = (() => {
            if (isDeltaAvailable) return error.code > 1;
            return [2, 127, 128].includes(error.code) || error.code > 128;
          })();

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

export function createToolCallDiffer() {
  const toolCallIdToTempFileBefore = new Map<string, string>();

  function setTempFileBefore(toolCallId: string, path: string) {
    const tempFileBefore = getTempFileName({ initialContentPath: path });
    if (tempFileBefore === null) return;
    toolCallIdToTempFileBefore.set(toolCallId, tempFileBefore);
  }

  function getTempFileBefore(toolCallId: string) {
    const tempFileBefore = toolCallIdToTempFileBefore.get(toolCallId);
    assertAtRuntime(tempFileBefore !== undefined);
    return tempFileBefore;
  }

  async function diffAndCleanup(toolCallId: string, path: string) {
    const tempFileAfterPath = getTempFileName({ initialContentPath: path });
    if (tempFileAfterPath === null) {
      if (toolCallIdToTempFileBefore.has(toolCallId)) {
        cleanupTempFileBefore(toolCallId);
      }
      return;
    }

    if (!toolCallIdToTempFileBefore.has(toolCallId)) {
      tryCatch(() => fsDeps.unlinkSync(tempFileAfterPath));
      return;
    }

    const tempFileBeforePath = getTempFileBefore(toolCallId);

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
      actions.appendToolEditDiff({
        fileName: path,
        diffStdout: diffResult.value.stdout,
      });

      if (!getState().config.suppressToolEditDiffs) {
        printNewline();
        fencePrint(`File change: ${path}`);
        print.plain(normalizeNewline(diffResult.value.stdout));
        printNewline();
      }
    }

    tryCatch(() => fsDeps.unlinkSync(tempFileAfterPath));
    cleanupTempFileBefore(toolCallId);
  }

  function cleanupTempFileBefore(toolCallId: string) {
    const tempFile = toolCallIdToTempFileBefore.get(toolCallId);
    if (tempFile === undefined) return;
    tryCatch(() => fsDeps.unlinkSync(tempFile));
    toolCallIdToTempFileBefore.delete(toolCallId);
  }

  function cleanupAllTempFileBefore() {
    for (const tempFile of toolCallIdToTempFileBefore.values()) {
      tryCatch(() => fsDeps.unlinkSync(tempFile));
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
