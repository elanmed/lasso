import { basename, extname, join } from "node:path";
import { fsDeps } from "./deps.ts";
import { tryCatch } from "./utils.ts";
import { getGlobalSlashCommandDir, getLocalSlashCommandDir } from "./paths.ts";
import { getState, type SlashCommand } from "./state.ts";

export const builtinSlashCommands = [
  "edit",
  "editpage",
  "history",
  "clear",
  "paste",
  "model",
  "skills",
  "context",
  "contextpage",
  "commands",
  "commandspage",
  "keymaps",
  "usage",
  "resume",
  "config",
  "reload",
  "initlocal",
  "initglobal",
  "lastresponse",
] as const;
export type BuiltinSlashCommand = (typeof builtinSlashCommands)[number];

export function getAvailableCommandsStr() {
  const customCommandsFormatted = getState().app.slashCommands.map(
    (command) => `- ${command.filePath}`,
  );
  const builtinCommandsFormatted = builtinSlashCommands.map(
    (command) => `- /${command}`,
  );
  return builtinCommandsFormatted.concat(customCommandsFormatted).join("\n");
}

export function getCustomSlashCommandsStr() {
  const contents = getState()
    .app.slashCommands.map(
      ({ content, filePath }) => `## ${filePath}\n\n${content}`,
    )
    .join("\n\n");
  return `# [lasso] Slash commands:\n\n${contents}`;
}

export function getAvailableSlashCommands() {
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
    const globResult = tryCatch(() => fsDeps.globbySync(glob));
    if (!globResult.ok) continue;
    slashCommandFilePaths.push(...globResult.value);
  }

  for (const filePath of slashCommandFilePaths) {
    const readResult = tryCatch(() => fsDeps.readFileSync(filePath).toString());
    if (!readResult.ok) continue;
    const name = basename(filePath, extname(filePath));
    if (seenSlashCommands.has(name)) continue;
    seenSlashCommands.add(name);

    entries.push({ filePath, name, content: readResult.value });
  }

  return entries;
}
