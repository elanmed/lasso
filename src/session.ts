import { join, basename, extname } from "node:path";
import { tryCatchAsync, getMessageFromError, tryCatch } from "./utils.ts";
import { actions, getState } from "./state.ts";
import { fsDeps } from "./deps.ts";
import { getSessionDir, getWebpagesDir } from "./paths.ts";
import {
  SessionFileSchema,
  type ModelMessage,
  type ModelSummary,
  type SessionFile,
  type TranscriptEntry,
} from "./schemas.ts";
import { print, errorWithSpacing } from "./printing.ts";

export const interruptContent = "[Interrupted before a response was generated]";

interface SessionFileInfo {
  absolutePath: string;
  timestampMs: number;
}

export async function listSessionFiles() {
  const sessionDir = getSessionDir();
  const sessionDirExistsResult = tryCatch(() => fsDeps.existsSync(sessionDir));
  if (!sessionDirExistsResult.ok) {
    print.error(
      `Failed to check if ${sessionDir} exists. Error: ${getMessageFromError(sessionDirExistsResult.error)}`,
    );
    return [];
  }
  if (!sessionDirExistsResult.value) return [];

  const sessionFiles: SessionFileInfo[] = [];
  const readdirResult = await tryCatchAsync(fsDeps.readdir(sessionDir));
  if (!readdirResult.ok) {
    print.error(
      `Failed to read ${sessionDir}. Error: ${getMessageFromError(readdirResult.error)}`,
    );
    return [];
  }
  for (const name of readdirResult.value) {
    const fullPath = join(sessionDir, name);
    const statResult = await tryCatchAsync(fsDeps.stat(fullPath));
    if (!statResult.ok) continue;
    if (!statResult.value.isFile()) continue;

    const fileName = basename(name, extname(name));
    const parts = fileName.split("-");
    if (parts.length !== 2) continue;
    if (parts[0] !== "session") continue;

    const timestampMs = Number(parts[1]);
    if (Number.isNaN(timestampMs)) continue;

    if (extname(name) !== ".json") continue;

    sessionFiles.push({
      absolutePath: fullPath,
      timestampMs,
    });
  }
  return sessionFiles;
}

export function getAppendedConversationMessages(...messages: ModelMessage[]) {
  return [...getState().conversation.messages, ...messages];
}

export function getAppendedTranscript(...transcriptEntries: TranscriptEntry[]) {
  return [...getState().conversation.transcript, ...transcriptEntries];
}

export async function syncSessionFile({
  messages = getState().conversation.messages,
  summaries = getState().conversation.summaries,
  transcript = getState().conversation.transcript,
}: {
  messages?: ModelMessage[];
  summaries?: ModelSummary[];
  transcript?: TranscriptEntry[];
} = {}) {
  const sessionFilePath = getState().session.sessionFilePath;
  const sessionDir = getSessionDir();
  const sessionDirExistsResult = tryCatch(() => fsDeps.existsSync(sessionDir));
  if (!sessionDirExistsResult.ok) {
    print.error(
      `Failed to check if ${sessionDir} exists. Error: ${getMessageFromError(sessionDirExistsResult.error)}`,
    );
    return;
  }
  if (!sessionDirExistsResult.value) {
    const mkdirResult = await tryCatchAsync(
      fsDeps.mkdir(sessionDir, { recursive: true }),
    );
    if (!mkdirResult.ok) {
      print.error(`Failed to create the directory: ${sessionDir}`);
      return;
    }
  }

  const next: SessionFile = {
    messages,
    summaries,
    transcript,
  };

  actions.conversation.setMessages(messages);
  actions.conversation.setSummaries(summaries);
  actions.conversation.setTranscript(transcript);

  const stringifyResult = tryCatch(() => JSON.stringify(next));
  if (!stringifyResult.ok) {
    print.error("Failed to stringify the session file");
    return;
  }

  const writeResult = await tryCatchAsync(
    fsDeps.writeFile(sessionFilePath, stringifyResult.value),
  );
  if (!writeResult.ok) {
    print.error(`Failed to write the session file to ${sessionFilePath}`);
    return;
  }
}

export async function resumeFromSessionFile(sessionFilePath: string) {
  const readResult = await tryCatchAsync(
    fsDeps.readFile(sessionFilePath, "utf8"),
  );
  if (!readResult.ok) {
    errorWithSpacing(() => {
      print.error(`Failed to read the session file at ${sessionFilePath}`);
    });
    return false;
  }

  const jsonResult = tryCatch((): unknown => JSON.parse(readResult.value));
  if (!jsonResult.ok) {
    errorWithSpacing(() => {
      print.error(`Failed to parse the session file at ${sessionFilePath}`);
    });
    return false;
  }

  const parseResult = tryCatch(() => SessionFileSchema.parse(jsonResult.value));
  if (!parseResult.ok) {
    errorWithSpacing(() => {
      print.error(`Failed to validate the session file at ${sessionFilePath}`);
    });
    return false;
  }
  const { messages, summaries, transcript } = parseResult.value;
  actions.conversation.setTranscript(transcript);
  actions.conversation.setSummaries(summaries);
  actions.conversation.setMessages(messages);
  actions.usage.setPromptTokensStale(true);
  return true;
}

export function initSessionFile() {
  const sessionDir = getSessionDir();
  const sessionFilePath = join(
    sessionDir,
    `session-${getState().session.sessionStartDate.toString()}.json`,
  );
  actions.session.setFilePath(sessionFilePath);
}

export async function deleteExpiredSessionFiles() {
  const sessionFiles = await listSessionFiles();

  for (const { absolutePath, timestampMs } of sessionFiles) {
    const oneDay = 1_000 * 60 * 60 * 24;
    if (timestampMs + oneDay < getState().session.sessionStartDate) {
      await tryCatchAsync(fsDeps.unlink(absolutePath));
    }
  }
}

export async function deleteExpiredWebpageFiles() {
  const webpagesDir = getWebpagesDir();
  const webpagesDirExistsResult = tryCatch(() =>
    fsDeps.existsSync(webpagesDir),
  );
  if (!webpagesDirExistsResult.ok) {
    print.error(
      `Failed to check if ${webpagesDir} exists. Error: ${getMessageFromError(webpagesDirExistsResult.error)}`,
    );
    return;
  }
  if (!webpagesDirExistsResult.value) return;

  interface WebpageFileInfo {
    absolutePath: string;
    timestampMs: number;
  }

  const webpageFiles: WebpageFileInfo[] = [];
  const readdirResult = await tryCatchAsync(fsDeps.readdir(webpagesDir));
  if (!readdirResult.ok) {
    print.error(
      `Failed to read ${webpagesDir}. Error: ${getMessageFromError(readdirResult.error)}`,
    );
    return;
  }
  for (const name of readdirResult.value) {
    const fullPath = join(webpagesDir, name);
    const statResult = await tryCatchAsync(fsDeps.stat(fullPath));
    if (!statResult.ok) continue;
    if (!statResult.value.isFile()) continue;

    const fileName = basename(name, extname(name));
    const parts = fileName.split("-");
    const lastPart = parts.at(-1);
    if (lastPart === undefined) continue;

    const timestampMs = Number(lastPart);
    if (Number.isNaN(timestampMs)) continue;

    if (extname(name) !== ".md") continue;

    webpageFiles.push({
      absolutePath: fullPath,
      timestampMs,
    });
  }

  for (const { absolutePath, timestampMs } of webpageFiles) {
    const oneDay = 1_000 * 60 * 60 * 24;
    if (timestampMs + oneDay < getState().session.sessionStartDate) {
      await tryCatchAsync(fsDeps.unlink(absolutePath));
    }
  }
}
