import { dirname, join } from "node:path";
import * as YAML from "yaml";
import { z } from "zod";
import { fsDeps, processDeps } from "./deps.ts";
import {
  getMessageFromError,
  normalizeNewline,
  tryCatch,
  tryCatchAsync,
} from "./utils.ts";
import { print } from "./print.ts";
import { actions, getState } from "./state.ts";
import {
  getGlobalContextDir,
  getGlobalSkillDir,
  getLocalSkillDir,
} from "./paths.ts";

export interface ContextEntry {
  filePath: string;
  content: string;
}

export const contextFileSkillNamePrefix = "__lasso-context-for";

export function getContextFilesStr(contextEntries: ContextEntry[]) {
  if (contextEntries.length === 0) return "";

  const contextFilesList = contextEntries
    .map(
      (entry) => `## Path: ${entry.filePath}

${normalizeNewline(entry.content)}`,
    )
    .join("\n\n");

  return `# [lasso] AGENTS.md context files

${contextFilesList}`;
}

export async function getContextEntries() {
  const agentFileDirs: string[] = [processDeps.cwd(), getGlobalContextDir()];

  const entries: ContextEntry[] = [];

  for (const agentFileDir of agentFileDirs) {
    const filePath = join(agentFileDir, "AGENTS.md");
    if (!fsDeps.existsSync(filePath)) continue;
    const readResult = await tryCatchAsync(fsDeps.readFile(filePath, "utf8"));
    if (!readResult.ok) {
      actions.appendConfigWarningMessage(
        `Failed to read the agent file at ${filePath}, ignoring. Error: ${getMessageFromError(readResult.error, { forceSingleLine: true })} `,
      );
      continue;
    }
    entries.push({ filePath, content: readResult.value });
  }

  return entries;
}

const skillMetadataSchema = z.object({
  name: z.string(),
  description: z.string(),
});
export type SkillMetadata = z.infer<typeof skillMetadataSchema>;
export interface Skill {
  name: string;
  description: string;
  dir: string;
  content: string;
}

export function getSkillsStr(skills: Skill[]) {
  if (skills.length === 0) return "";

  const skillsFormatted = skills
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join("\n");

  return `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

${skillsFormatted}`;
}
export async function getSkills() {
  const seenSkills = new Set<string>();
  const skillGrandparentDirs = [
    ...getState().config.customSkillDirs,
    getLocalSkillDir(),
    getGlobalSkillDir(),
  ];
  const skills: Skill[] = [];
  const skillPaths: string[] = [];

  for (const skillGrandparentDir of skillGrandparentDirs) {
    const glob = join(skillGrandparentDir, "**/SKILL.md");
    const globResult = await tryCatchAsync(fsDeps.glob(glob));
    if (!globResult.ok) {
      actions.appendConfigWarningMessage(
        `Failed to list the skill files in ${skillGrandparentDir}, ignoring`,
      );
      continue;
    }
    skillPaths.push(...globResult.value);
  }

  for (const skillPath of skillPaths) {
    const skill = await getSkillJSON(skillPath);
    if (skill === null) continue;

    if (seenSkills.has(skill.name)) continue;
    seenSkills.add(skill.name);
    skills.push(skill);
  }

  const agentFileGlobResult = await tryCatchAsync(
    fsDeps.gitLsFiles("**/AGENTS.md"),
  );
  if (!agentFileGlobResult.ok) {
    actions.appendConfigWarningMessage(
      `Failed to list the agent files with git, ignoring. Error: ${getMessageFromError(agentFileGlobResult.error, { forceSingleLine: true })}`,
    );
    return skills;
  }

  for (const agentFilePath of agentFileGlobResult.value) {
    const isRootAgentsMd = agentFilePath === "AGENTS.md";
    if (isRootAgentsMd) continue;
    const readResult = await tryCatchAsync(
      fsDeps.readFile(agentFilePath, "utf8"),
    );
    if (!readResult.ok) {
      actions.appendConfigWarningMessage(
        `Failed to read the agent file at ${agentFilePath}, ignoring. Error: ${getMessageFromError(readResult.error, { forceSingleLine: true })}`,
      );
      continue;
    }
    const dir = dirname(agentFilePath);

    const skill: Skill = {
      content: readResult.value,
      description: `Context relevant for ${dir}`,
      dir,
      name: `${contextFileSkillNamePrefix}-${dir}`,
    };
    skills.push(skill);
  }

  return skills;
}

export function parseFrontMatter(content: string) {
  if (!content.startsWith("---\n")) return null;

  // start search on the char after the ---\n
  const closeIndex = content.indexOf("\n---", 4);
  if (closeIndex === -1) return null;

  // start slice on the char after the ---\n
  const yamlStr = content.slice(4, closeIndex);
  if (yamlStr === "") return null;
  const parseResult = tryCatch(() => YAML.parse(yamlStr) as unknown);
  if (!parseResult.ok) return null;

  // start slice on the char after the \n---
  const body = content.slice(closeIndex + 5);
  return { data: parseResult.value, body };
}

export async function getSkillJSON(skillMdPath: string) {
  const readResult = await tryCatchAsync(fsDeps.readFile(skillMdPath, "utf8"));
  if (!readResult.ok) {
    print.error(`Failed to read the skill at ${skillMdPath}`);
    return null;
  }

  const parsed = parseFrontMatter(readResult.value);
  if (parsed === null) {
    print.error(
      `Malformed skill at ${skillMdPath}! A skill's front matter must contain valid YAML between \`---\` and \`---\`.`,
    );
    return null;
  }
  const parseResult = skillMetadataSchema.safeParse(parsed.data);
  if (!parseResult.success) {
    print.error(
      `Malformed skill at ${skillMdPath}! A skill's front matter must contain a \`name\` and \`description\` field.`,
    );
    return null;
  }

  const skill: Skill = {
    content: parsed.body,
    dir: dirname(skillMdPath),
    name: parseResult.data.name,
    description: parseResult.data.description,
  };
  return skill;
}
