import { dirname } from "node:path";
import { fsDeps } from "./deps.ts";
import { tryCatchAsync } from "./utils.ts";

export async function debugLog(
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
