import { fileURLToPath } from "node:url";
import { getMessageFromError } from "./utils.ts";
import {
  print,
  printNewline,
  printSessionStartDate,
  stopLoadingState,
} from "./print.ts";
import { fencePrint } from "./fence.ts";
import { executeBat, warnOnMissingBat } from "./terminal.ts";
import { initState, blockOnMissingConfig } from "./config.ts";
import {
  initReadline,
  initStdin,
  initStdout,
  pollUntilNonBlockingProcessClosed,
  resolveUserInput,
} from "./input.ts";
import { resolveApiCall, maybeCompact } from "./api.ts";
import { actions, getState } from "./state.ts";
import { warnOnLargePromptOverhead } from "./usage.ts";

async function main() {
  actions.setIsInitializing(true);

  initStdin();
  initStdout();
  await initState();
  initReadline();

  await warnOnMissingBat();
  warnOnLargePromptOverhead();

  actions.setIsInitializing(false);

  let isFirstInput = true;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    await pollUntilNonBlockingProcessClosed();
    const userInput = await resolveUserInput({ isFirstInput });
    isFirstInput = false;

    if (userInput === null) continue;

    const missingConfig = blockOnMissingConfig();
    if (missingConfig) continue;

    if (userInput === "") {
      print.warning("Empty input");
      continue;
    }

    await maybeCompact(userInput);

    const text = await resolveApiCall(userInput);
    if (text === null) continue;

    printNewline();
    fencePrint("Output", {
      showSessionInfo: true,
    });
    await executeBat(text);
    printNewline();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(async (error: unknown) => {
    print.error(getMessageFromError(error));
    stopLoadingState();
    printSessionStartDate();
    await getState().mcp.close();
    process.exit(1);
  });
}
