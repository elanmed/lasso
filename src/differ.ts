import assert from "node:assert";
import os from "node:os";
import childProcess from "node:child_process";
import { fsDeps } from "./deps.ts";
import {
  execPromise,
  getTempFileName,
  type GetTempFileNameArgs,
} from "./utils.ts";

export async function execGitDiff(opts: {
  tempFileBeforePath: string;
  tempFileAfterPath: string;
  includeFilename?: boolean;
}): Promise<{ stdout: string; stderr: string }> {
  let isDeltaAvailable = false;
  try {
    await execPromise("delta --version");
    isDeltaAvailable = true;
  } catch {
    isDeltaAvailable = false;
  }
  const base = `git diff --no-index --color=always -U3 ${opts.tempFileBeforePath} ${opts.tempFileAfterPath}`;
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

async function defaultPrintGitDiff({
  tempFileBeforePath,
  tempFileAfterPath,
}: {
  tempFileBeforePath: string;
  tempFileAfterPath: string;
  path: string;
}) {
  await execGitDiff({ tempFileBeforePath, tempFileAfterPath });
}

export function createToolCallDiffer(
  printGitDiff: (opts: {
    tempFileBeforePath: string;
    tempFileAfterPath: string;
    path: string;
  }) => Promise<void> = defaultPrintGitDiff,
) {
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
