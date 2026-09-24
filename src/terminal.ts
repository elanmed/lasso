import childProcess from "node:child_process";
import { format } from "prettier";
import { processDeps } from "./deps.ts";
import { actions, getState } from "./state.ts";
import {
  execPromise,
  getMessageFromError,
  getTempFileName,
  isExisty,
  normalizeLine,
  tryCatch,
  tryCatchAsync,
  shouldDisableColor,
} from "./utils.ts";
import { print } from "./print.ts";

import { getGlobalConfigPath, getLocalConfigPath } from "./paths.ts";

export async function checkBat(): Promise<boolean> {
  return (await tryCatchAsync(execPromise("bat --version"))).ok;
}

export async function warnOnMissingBat() {
  const batAvailable = await checkBat();
  actions.setBatAvailable(batAvailable);
  if (getState().config.suppressBatUnavailableWarning) return;

  if (!batAvailable) {
    print.warning(
      `\`bat\` is not available, consider installing it to properly render markdown responses in the terminal. Suppress this warning with \`suppressBatUnavailableWarning: true\` in ${getGlobalConfigPath()} or ${getLocalConfigPath()}`,
    );
  }
}

export function baseBatFlags() {
  return shouldDisableColor()
    ? ["--style=plain", "--color=never"]
    : ["--style=plain", "--color=always"];
}
export const markdownBatFlags = ["--language", "md", "--italic-text=always"];

function spawnBat(input: string) {
  return tryCatch(() =>
    childProcess.spawnSync(
      "bat",
      [...baseBatFlags(), ...markdownBatFlags, "--paging=never", "-"],
      {
        input,
        encoding: "utf8",
      },
    ),
  );
}

export async function formatMarkdown(content: string): Promise<string> {
  const formatResult = await tryCatchAsync(
    format(content, { parser: "markdown" }),
  );
  if (formatResult.ok) return formatResult.value;
  print.warning(
    `Outputting raw content, markdown formatting failed: ${getMessageFromError(formatResult.error)}`,
  );
  return content;
}

export async function executeBat(content: string) {
  content = await formatMarkdown(content);
  content = normalizeLine(content);
  if (!getState().app.batAvailable) {
    return print(content);
  }

  function fallbackPrint(message: string) {
    print.error(message);
    print(content);
  }
  const baseMessage =
    "Falling back to plain text rendering, an error occurred when spawning `bat`: ";
  const batResult = spawnBat(content);
  if (!batResult.ok) {
    return fallbackPrint(
      baseMessage.concat(getMessageFromError(batResult.error)),
    );
  }
  if (batResult.value.status !== null && batResult.value.status !== 0) {
    return fallbackPrint(
      baseMessage.concat(
        `\`bat\` returned code ${String(batResult.value.status)}`,
      ),
    );
  }
  if (batResult.value.stderr.length !== 0) {
    return fallbackPrint(baseMessage.concat(batResult.value.stderr));
  }
  print(batResult.value.stdout);
}

export function openWithPager({
  initialContentStr,
  contentType,
}: {
  initialContentStr?: string;
  contentType: "diff" | "markdown";
}): void {
  const tempFile = getTempFileName({ initialContentStr });
  if (tempFile === null) return;

  const pagerCommand = (() => {
    const lassoDefaultPagerEnvValue = processDeps.env.get("LASSO_PAGER");
    if (isExisty(lassoDefaultPagerEnvValue)) {
      return lassoDefaultPagerEnvValue.replace("__FILE__", tempFile);
    }

    const defaultPagerEnvValue = processDeps.env.get("PAGER");
    if (isExisty(defaultPagerEnvValue)) {
      return `${defaultPagerEnvValue} "${tempFile}"`;
    }

    if (getState().app.batAvailable) {
      const batFlags =
        contentType === "diff"
          ? baseBatFlags()
          : baseBatFlags().concat(markdownBatFlags);

      return `bat ${batFlags.join(" ")} --paging=always "${tempFile}"`;
    }

    return `less "${tempFile}"`;
  })();

  childProcess.spawnSync(pagerCommand, {
    shell: true,
    stdio: "inherit",
  });
}
