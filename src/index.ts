import { fileURLToPath } from "node:url";
import {
  print,
  printNewline,
  printSessionStartDate,
  stopLoadingState,
  executeBat,
} from "./printing.ts";
import {
  printMissingConfigErrors,
  printMissingConfigWarnings,
} from "./config.ts";
import { printLargeContextOverheadWarning } from "./tokens.ts";
import { initStdin, initStdout } from "./commands.ts";
import { actions, getState } from "./state.ts";
import { getMessageFromError } from "./utils.ts";
import {
  fencePrint,
  initState,
  resolveApiCall,
  initReadline,
  pollUntilNonBlockingProcessClosed,
  resolveUserInput,
} from "./app.ts";

async function main() {
  actions.terminal.setIsInitializing(true);
  initStdin();
  initStdout();
  await initState();
  initReadline();
  printMissingConfigErrors();
  printMissingConfigWarnings();
  printLargeContextOverheadWarning();
  actions.terminal.setIsInitializing(false);

  let isFirstInput = true;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    await pollUntilNonBlockingProcessClosed();
    const userInput = await resolveUserInput({ isFirstInput });
    isFirstInput = false;

    if (userInput === null) continue;

    const missingConfig = printMissingConfigErrors();
    if (missingConfig) continue;

    if (userInput === "") {
      print.warning("Empty input");
      continue;
    }

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
    const closeErrors = await getState().mcp.close();
    for (const { clientName, error } of closeErrors) {
      print.error(
        `Failed to close the \`${clientName}\` mcp server while exiting. Error: ${getMessageFromError(error, { forceSingleLine: true })}`,
      );
    }
    process.exit(1);
  });
}
