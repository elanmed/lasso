import { dirname } from "node:path";
import { fsDeps } from "./deps.ts";
import { tryCatch } from "./utils.ts";

export function debugLog(enabled: boolean, path: string, content: string) {
  if (!enabled) return;
  if (path.length === 0) return;
  if (!fsDeps.existsSync(path)) {
    const mkdirResult = tryCatch(() =>
      fsDeps.mkdirSync(dirname(path), { recursive: true }),
    );
    if (!mkdirResult.ok) return;
  }
  tryCatch(() =>
    fsDeps.appendFileSync(
      path,
      `${new Date(Date.now()).toISOString()} :: ${content}\n`,
    ),
  );
}
