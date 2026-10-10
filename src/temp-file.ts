import os from "node:os";
import { join } from "node:path";
import { assertAtRuntime } from "./assert.ts";
import { fsDeps } from "./deps.ts";
import { print } from "./print.ts";
import {
  getMessageFromError,
  getShortId,
  isShellSafePath,
  tryCatch,
  tryCatchAsync,
} from "./utils.ts";

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
