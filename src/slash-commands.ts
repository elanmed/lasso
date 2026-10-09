import { basename, extname, join } from "node:path";
import { fsDeps } from "./deps.ts";
import {
  getMessageFromError,
  normalizeNewline,
  tryCatchAsync,
} from "./utils.ts";
import { getGlobalSlashCommandDir, getLocalSlashCommandDir } from "./paths.ts";
import { actions, getState, type SlashCommand } from "./state.ts";

export const builtinSlashCommands = [
  "edit",
  "editpage",
  "history",
  "clear",
  "paste",
  "model",
  "skills",
  "context",
  "commands",
  "keymaps",
  "usage",
  "tokens",
  "resume",
  "config",
  "reload",
  "initlocal",
  "initglobal",
  "lastresponse",
  "lastmessage",
  "lastdiff",
  "summaries",
  "tools",
  "record",
] as const;
export type BuiltinSlashCommand = (typeof builtinSlashCommands)[number];

export function getAvailableCommandsStr() {
  const customCommandsFormatted = getState().content.slashCommands.map(
    (command) => `- ${command.filePath}`,
  );
  const builtinCommandsFormatted = builtinSlashCommands.map(
    (command) => `- /${command}`,
  );
  return builtinCommandsFormatted.concat(customCommandsFormatted).join("\n");
}

export function getCustomSlashCommandsStr() {
  const contents = getState()
    .content.slashCommands.map(
      ({ content, filePath }) => `## ${filePath}

${normalizeNewline(content, { count: 0 })}`,
    )
    .join("\n\n");

  return `# [lasso] Slash commands:

${contents}`;
}

export async function getAvailableSlashCommands() {
  const seenSlashCommands = new Set<string>();

  const entries: SlashCommand[] = [];
  const slashCommandFilePaths: string[] = [];

  const slashCommandDirs = [
    ...getState().config.customSlashCommandDirs,
    getLocalSlashCommandDir(),
    getGlobalSlashCommandDir(),
  ];

  for (const dir of slashCommandDirs) {
    const glob = join(dir, "**/*.md");
    const globResult = await tryCatchAsync(fsDeps.glob(glob));
    if (!globResult.ok) {
      actions.appendConfigWarningMessage(
        `Failed to list the slash command files in ${dir}, ignoring. Error: ${getMessageFromError(globResult.error, { forceSingleLine: true })}`,
      );
      continue;
    }
    slashCommandFilePaths.push(...globResult.value);
  }

  for (const filePath of slashCommandFilePaths) {
    const readResult = await tryCatchAsync(fsDeps.readFile(filePath, "utf8"));
    if (!readResult.ok) {
      actions.appendConfigWarningMessage(
        `Failed to read the slash command file at ${filePath}, ignoring. Error: ${getMessageFromError(readResult.error, { forceSingleLine: true })}`,
      );
      continue;
    }
    const name = basename(filePath, extname(filePath));
    if (seenSlashCommands.has(name)) continue;
    seenSlashCommands.add(name);

    entries.push({ filePath, name, content: readResult.value });
  }

  return entries;
}
