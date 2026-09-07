import { dirname, join } from "node:path";
import { fsDeps, processDeps } from "./deps.ts";
import { tryCatch } from "./utils.ts";
import { print } from "./print.ts";
import { getState } from "./state.ts";
import {
  getGlobalContextDir,
  getGlobalSkillDir,
  getLocalSkillDir,
} from "./paths.ts";
import * as YAML from "yaml";
import { z } from "zod";

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

${entry.content}
`,
    )
    .join("\n\n");

  return `# [lasso] AGENTS.md context files

${contextFilesList}`;
}
export function getContextEntries() {
  const agentFileDirs: string[] = [processDeps.cwd(), getGlobalContextDir()];

  const entries: ContextEntry[] = [];

  for (const agentFileDir of agentFileDirs) {
    const filePath = join(agentFileDir, "AGENTS.md");
    const readResult = tryCatch(() => fsDeps.readFileSync(filePath).toString());
    if (!readResult.ok) continue;
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

${skillsFormatted}
`;
}
export function getSkills() {
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
    const globResult = tryCatch(() => fsDeps.globbySync(glob));
    if (!globResult.ok) continue;
    skillPaths.push(...globResult.value);
  }

  for (const skillPath of skillPaths) {
    const skill = getSkillJSON(skillPath);
    if (skill === null) continue;

    if (seenSkills.has(skill.name)) continue;
    seenSkills.add(skill.name);
    skills.push(skill);
  }

  const agentFileGlob = join(processDeps.cwd(), "*/**/AGENTS.md");
  const agentFileGlobResult = tryCatch(() => fsDeps.globbySync(agentFileGlob));
  if (!agentFileGlobResult.ok) return skills;

  for (const agentFilePath of agentFileGlobResult.value) {
    const readResult = tryCatch(() =>
      fsDeps.readFileSync(agentFilePath).toString(),
    );
    if (!readResult.ok) continue;
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

export function getSkillJSON(skillMdPath: string) {
  const readResult = tryCatch(() =>
    fsDeps.readFileSync(skillMdPath).toString(),
  );
  if (!readResult.ok) return null;

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
