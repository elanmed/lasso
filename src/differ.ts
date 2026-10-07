import os from "node:os";
import { assertAtRuntime } from "./assert.ts";
import { childProcessDeps, fsDeps } from "./deps.ts";
import { fencePrint } from "./fence.ts";
import { print, printNewline } from "./print.ts";
import {
  getMessageFromError,
  getTempFileName,
  normalizeNewline,
  shouldDisableColor,
  tryCatchAsync,
} from "./utils.ts";
import { actions, getState } from "./state.ts";

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

  return result.ok ? result.value : { stdout: "", stderr: "" };
}

export function isToolCallDiffIgnoredPath(path: string) {
  return path.startsWith(os.tmpdir());
}

export function createToolCallDiffer() {
  const toolCallIdToTempFileBefore = new Map<string, string>();

  async function setTempFileBefore(toolCallId: string, path: string) {
    if (isToolCallDiffIgnoredPath(path)) return;
    const tempFileBefore = await getTempFileName({ initialContentPath: path });
    if (tempFileBefore === null) {
      print.error(`Failed to create the before diff temp file for ${path}`);
      return;
    }
    toolCallIdToTempFileBefore.set(toolCallId, tempFileBefore);
  }

  function getTempFileBefore(toolCallId: string) {
    const tempFileBefore = toolCallIdToTempFileBefore.get(toolCallId);
    assertAtRuntime(tempFileBefore !== undefined);
    return tempFileBefore;
  }

  async function diffAndCleanup(toolCallId: string, path: string) {
    const tempFileAfterPath = await getTempFileName({
      initialContentPath: path,
    });
    if (tempFileAfterPath === null) {
      print.error(`Failed to create the after diff temp file for ${path}`);
      if (toolCallIdToTempFileBefore.has(toolCallId)) {
        await cleanupTempFileBefore(toolCallId);
      }
      return;
    }

    if (!toolCallIdToTempFileBefore.has(toolCallId)) {
      await tryCatchAsync(fsDeps.unlink(tempFileAfterPath));
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

    await tryCatchAsync(fsDeps.unlink(tempFileAfterPath));
    await cleanupTempFileBefore(toolCallId);
  }

  async function cleanupTempFileBefore(toolCallId: string) {
    const tempFile = toolCallIdToTempFileBefore.get(toolCallId);
    if (tempFile === undefined) return;
    await tryCatchAsync(fsDeps.unlink(tempFile));
    toolCallIdToTempFileBefore.delete(toolCallId);
  }

  async function cleanupAllTempFileBefore() {
    for (const tempFile of toolCallIdToTempFileBefore.values()) {
      await tryCatchAsync(fsDeps.unlink(tempFile));
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
