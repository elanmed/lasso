import { dirname, join } from "node:path";
import { actions, getState } from "./state.ts";
import { listChatHistoryFiles, normalizeLine, tryCatch } from "./utils.ts";
import { fsDeps } from "./deps.ts";
import { getPromptHistoryDir } from "./paths.ts";
import { debugLog as writeDebugLog } from "./debug-log.ts";

export function debugLog(content: string) {
  writeDebugLog(getState().app.debugLog, getState().app.debugLogPath, content);
}

export function appendToChatHistory(
  content: string,
  role: "user" | "assistant",
) {
  const path = getState().app.chatHistoryPath;
  if (!fsDeps.existsSync(path)) {
    const mkdirResult = tryCatch(() =>
      fsDeps.mkdirSync(dirname(path), { recursive: true }),
    );
    if (!mkdirResult.ok) return;
  }
  tryCatch(() =>
    fsDeps.appendFileSync(
      path,
      `${new Date(Date.now()).toISOString()}  *${role}*

---
${normalizeLine(content)}
`,
    ),
  );
}

export function initPromptHistory() {
  const chatHistoryDir = getPromptHistoryDir();
  if (!fsDeps.existsSync(chatHistoryDir)) {
    const mkDirResult = tryCatch(() =>
      fsDeps.mkdirSync(chatHistoryDir, { recursive: true }),
    );
    if (!mkDirResult.ok) return;
  }

  const chatHistorySessionPath = join(
    chatHistoryDir,
    `chat-history-${getState().app.sessionStartDate.toString()}.md`,
  );
  actions.setChatHistoryPath(chatHistorySessionPath);
  tryCatch(() => fsDeps.writeFileSync(chatHistorySessionPath, ""));
}

export function deleteExpiredPromptHistory() {
  const chatHistoryFileEntries = listChatHistoryFiles();

  for (const { absolutePath, timestampMs } of chatHistoryFileEntries) {
    const oneDay = 1_000 * 60 * 60 * 24;
    if (timestampMs + oneDay < getState().app.sessionStartDate) {
      tryCatch(() => fsDeps.unlinkSync(absolutePath));
    }
  }
}

export function initLogs() {
  deleteExpiredPromptHistory();
  initPromptHistory();
}
