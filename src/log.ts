import { dirname, join } from "node:path";
import { z } from "zod";
import {
  type ConversationLogEntry,
  ConversationLogEntrySchema,
  actions,
  getState,
} from "./state.ts";
import {
  listChatHistoryFiles,
  listConversationLogFiles,
  normalizeNewline,
  tryCatch,
} from "./utils.ts";
import { fsDeps } from "./deps.ts";
import { getChatHistoryDir, getConversationLogDir } from "./paths.ts";
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

  tryCatch(() => fsDeps.writeFileSync(path, newChatHistory));
}

export function appendToConversationLog(
  content: string,
  role: "user" | "assistant",
) {
  const path = getState().app.conversationLogPath;
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
  if (!readResult.ok) {
    print.warning(`Failed to read the conversation log at ${path}`);
    return;
  }
  const jsonResult = tryCatch((): unknown => JSON.parse(readResult.value));
  if (!jsonResult.ok) {
    print.warning(`Failed to parse the conversation log at ${path}`);
    return;
  }

  const parseResult = tryCatch(() =>
    z.array(ConversationLogEntrySchema).parse(jsonResult.value),
  );
  if (!parseResult.ok) {
    print.warning(`Invalid conversation log format at ${path}`);
    return;
  }

  const entry: ConversationLogEntry = {
    timestamp: Date.now(),
    role,
    message: content,
  };

  parseResult.value.push(entry);
  const newContent = JSON.stringify(parseResult.value);
  const writeResult = tryCatch(() => fsDeps.writeFileSync(path, newContent));
  if (!writeResult.ok) {
    print.warning(`Failed to write the conversation log to ${path}`);
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
  tryCatch(() => fsDeps.writeFileSync(chatHistorySessionPath, ""));
}

export function initConversationLog() {
  const conversationLogDir = getConversationLogDir();
  if (!fsDeps.existsSync(conversationLogDir)) {
    const mkDirResult = tryCatch(() =>
      fsDeps.mkdirSync(conversationLogDir, { recursive: true }),
    );
    if (!mkDirResult.ok) {
      print.warning(`Failed to create the directory: ${conversationLogDir}`);
      return;
    }
  }

  const conversationLogSessionPath = join(
    conversationLogDir,
    `conversation-log-${getState().app.sessionStartDate.toString()}.json`,
  );
  actions.setConversationLogPath(conversationLogSessionPath);
  tryCatch(() => fsDeps.writeFileSync(conversationLogSessionPath, "[]"));
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

export function deleteExpiredConversationLog() {
  const conversationLogFiles = listConversationLogFiles();

  for (const { absolutePath, timestampMs } of conversationLogFiles) {
    const oneDay = 1_000 * 60 * 60 * 24;
    if (timestampMs + oneDay < getState().app.sessionStartDate) {
      tryCatch(() => fsDeps.unlinkSync(absolutePath));
    }
  }
}

export function initLogs() {
  deleteExpiredChatHistory();
  deleteExpiredConversationLog();
  initChatHistory();
  initConversationLog();
}
