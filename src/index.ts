import { fileURLToPath } from "node:url";
import { getMessageFromError } from "./utils.ts";
import {
  print,
  fencePrint,
  printNewline,
  printSessionStartDate,
} from "./print.ts";
import { executeBat, warnOnMissingBat } from "./terminal.ts";
import { initState, blockOnMissingConfig } from "./config.ts";
import {
  initKeypress,
  initReadline,
  initSigInt,
  resolveUserInput,
} from "./input.ts";
import { resolveApiCall, maybeCompactMessageParams } from "./api.ts";
import { initLogs } from "./log.ts";
import { getState } from "./state.ts";

async function main() {
  await initState();
  initLogs();

  initReadline();
  initKeypress();
  initSigInt();

  await warnOnMissingBat();

  let isFirstInput = true;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const userInput = await resolveUserInput({ isFirstInput });
    isFirstInput = false;
    if (userInput === null) continue;

    if (userInput === "") {
      print.warning("Empty input");
      continue;
    }

    const missingConfig = blockOnMissingConfig();
    if (missingConfig) continue;

    await maybeCompactMessageParams(userInput);

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
    printSessionStartDate();
    await getState().mcp.close();
    process.exit(1);
  });
}
