import { fileURLToPath } from "node:url";
import {
  getMessageFromError,
  print,
  printNewline,
  printSessionStartDate,
  stopLoadingState,
  fencePrint,
  executeBat,
  initState,
  blockOnMissingConfig,
  warnOnMissingConfig,
  actions,
  getState,
  warnOnLargePromptOverhead,
} from "./utils.ts";
import {
  initReadline,
  initStdin,
  initStdout,
  pollUntilNonBlockingProcessClosed,
  resolveUserInput,
} from "./input.ts";
import { resolveApiCall, maybeCompact } from "./app.ts";

async function main() {
  actions.setIsInitializing(true);
  initStdin();
  initStdout();
  await initState();
  initReadline();
  warnOnMissingConfig();
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
