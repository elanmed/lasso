import { dirname, join } from "node:path";
import {
  actions,
  getState,
  SessionFileSchema,
  type ModelMessage,
  type ModelSummary,
  type SessionFile,
  type TranscriptEntry,
} from "./state.ts";
import { listSessionFiles, normalizeNewline, tryCatch } from "./utils.ts";
import { fsDeps } from "./deps.ts";
import { getSessionDir } from "./paths.ts";
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

export function syncSessionFile({
  messages = getState().app.conversation.messages,
  summaries = getState().app.conversation.summaries,
  transcript = getState().app.transcript,
}: {
  messages?: ModelMessage[];
  summaries?: ModelSummary[];
  transcript?: TranscriptEntry[];
}) {
  const { sessionFilePath } = getState().app;
  const sessionDir = getSessionDir();
  if (!fsDeps.existsSync(sessionDir)) {
    const mkdirResult = tryCatch(() =>
      fsDeps.mkdirSync(sessionDir, { recursive: true }),
    );
    if (!mkdirResult.ok) {
      print.warning(`Failed to create the directory: ${sessionDir}`);
      return;
    }
  }

  const next: SessionFile = {
    messages,
    summaries,
    transcript,
  };
  const stringifyResult = tryCatch(() => JSON.stringify(next));
  if (!stringifyResult.ok) {
    // TODO: warn
    return;
  }

  const writeResult = tryCatch(() =>
    fsDeps.writeFileSync(sessionFilePath, stringifyResult.value),
  );
  if (!writeResult.ok) {
    // TODO: warn
    return;
  }
}

export function initStateFromSessionFile() {
  const { sessionFilePath } = getState().app;
  const readResult = tryCatch(() =>
    fsDeps.readFileSync(sessionFilePath).toString(),
  );
  if (!readResult.ok) {
    // TODO: warn
    return;
  }

  const jsonResult = tryCatch((): unknown => JSON.parse(readResult.value));
  if (!jsonResult.ok) {
    // TODO: warn
    return;
  }

  const parseResult = tryCatch(() => SessionFileSchema.parse(jsonResult));
  if (!parseResult.ok) {
    // TODO: warn
    return;
  }
  const { messages, summaries, transcript } = parseResult.value;
  actions.setTranscript(transcript);
  actions.setConversationSummaries(summaries);
  actions.setConversationMessages(messages);
}

export function initSessionFile() {
  const sessionDir = getSessionDir();
  if (!fsDeps.existsSync(sessionDir)) {
    const mkDirResult = tryCatch(() =>
      fsDeps.mkdirSync(sessionDir, { recursive: true }),
    );
    if (!mkDirResult.ok) {
      print.warning(`Failed to create the directory: ${sessionDir}`);
      return;
    }
  }

  const sessionFilePath = join(
    sessionDir,
    `session-${getState().app.sessionStartDate.toString()}.json`,
  );
  actions.setSessionFilePath(sessionFilePath);
  const writeResult = tryCatch(() => fsDeps.writeFileSync(sessionFilePath, ""));
  if (!writeResult.ok) {
    print.warning(`Failed to write the session file to ${sessionFilePath}`);
  }
}

export function deleteExpiredSessionFiles() {
  const sessionFiles = listSessionFiles();

  for (const { absolutePath, timestampMs } of sessionFiles) {
    const oneDay = 1_000 * 60 * 60 * 24;
    if (timestampMs + oneDay < getState().app.sessionStartDate) {
      tryCatch(() => fsDeps.unlinkSync(absolutePath));
    }
  }
}

export function initLogs() {
  deleteExpiredSessionFiles();
  initSessionFile();
}
