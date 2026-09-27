import { dirname, join } from "node:path";
import { actions, getState } from "./state.ts";
import { listChatHistoryFiles, normalizeNewline, tryCatch } from "./utils.ts";
import { fsDeps } from "./deps.ts";
import { getChatHistoryDir } from "./paths.ts";
import { debugLog as writeDebugLog } from "./debug-log.ts";
import { print } from "./print.ts";

export function debugLog(content: string) {
  writeDebugLog(getState().app.debugLog, getState().app.debugLogPath, content);
}

export function prependToChatHistory(
  content: string,
  role: "user" | "assistant",
) {
  const path = getState().app.chatHistoryPath;
  const dir = dirname(path);
  if (!fsDeps.existsSync(dir)) {
    const mkdirResult = tryCatch(() =>
      fsDeps.mkdirSync(dir, { recursive: true }),
    );
    if (!mkdirResult.ok) {
      print.warning(`Failed to create the directory: ${dir}`);
      return;
    }
  }

  const readResult = tryCatch(() => fsDeps.readFileSync(path).toString());
  const existingContent = readResult.ok ? readResult.value : "";

  const newChatHistory = `${new Date(Date.now()).toISOString()}  *${role}*
${normalizeNewline(content)}
---
${existingContent}
`;

  const writeResult = tryCatch(() =>
    fsDeps.writeFileSync(path, newChatHistory),
  );
  if (!writeResult.ok) {
    print.warning(`Failed to write the chat history to ${path}`);
  }
}

export function initChatHistory() {
  const chatHistoryDir = getChatHistoryDir();
  if (!fsDeps.existsSync(chatHistoryDir)) {
    const mkDirResult = tryCatch(() =>
      fsDeps.mkdirSync(chatHistoryDir, { recursive: true }),
    );
    if (!mkDirResult.ok) {
      print.warning(`Failed to create the directory: ${chatHistoryDir}`);
      return;
    }
  }

  const chatHistorySessionPath = join(
    chatHistoryDir,
    `chat-history-${getState().app.sessionStartDate.toString()}.md`,
  );
  actions.setChatHistoryPath(chatHistorySessionPath);
  const writeResult = tryCatch(() =>
    fsDeps.writeFileSync(chatHistorySessionPath, ""),
  );
  if (!writeResult.ok) {
    print.warning(
      `Failed to write the chat history to ${chatHistorySessionPath}`,
    );
  }
}

export function deleteExpiredChatHistory() {
  const chatHistoryFileEntries = listChatHistoryFiles();

  for (const { absolutePath, timestampMs } of chatHistoryFileEntries) {
    const oneDay = 1_000 * 60 * 60 * 24;
    if (timestampMs + oneDay < getState().app.sessionStartDate) {
      tryCatch(() => fsDeps.unlinkSync(absolutePath));
    }
  }
}

export function initLogs() {
  deleteExpiredChatHistory();
  initChatHistory();
}
