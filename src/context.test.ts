import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { testFs, setupTestContext } from "./test-helpers.ts";
import { fsDeps } from "./deps.ts";
import { getGlobalContextDir } from "./paths.ts";
import {
  getContextFilesStr,
  getContextEntries,
  getSkillsStr,
  getSkills,
  getSkillJSON,
  parseFrontMatter,
} from "./context.ts";
import { actions } from "./state.ts";

describe("context", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  describe("getContextFilesStr", () => {
    it("returns empty string when no AGENTS.md files found", () => {
      const result = getContextFilesStr(getContextEntries());
      assert.equal(result, "");
    });

    it("returns formatted content for single file", () => {
      testFs._globResults.set("/test-cwd/**/AGENTS.md", [
        "/test-cwd/AGENTS.md",
      ]);
      testFs._files.set("/test-cwd/AGENTS.md", "# Agent Instructions");
      const result = getContextFilesStr(getContextEntries());
      assert.equal(
        result,
        `# [lasso] AGENTS.md context files

## Path: /test-cwd/AGENTS.md

# Agent Instructions
`,
      );
    });

    it("returns formatted content for multiple files", () => {
      testFs._dirs.add(getGlobalContextDir());
      testFs._files.set("/test-cwd/AGENTS.md", "Root content");
      testFs._files.set(
        "/fake-home/.config/lasso/context/AGENTS.md",
        "Global content",
      );
      const result = getContextFilesStr(getContextEntries());
      assert.equal(
        result,
        `# [lasso] AGENTS.md context files

## Path: /test-cwd/AGENTS.md

Root content


## Path: /fake-home/.config/lasso/context/AGENTS.md

Global content
`,
      );
    });

    it("skips files that fail to read", () => {
      testFs._dirs.add(getGlobalContextDir());
      testFs._files.set(
        "/fake-home/.config/lasso/context/AGENTS.md",
        "Global content",
      );
      const result = getContextFilesStr(getContextEntries());
      assert.equal(
        result,
        `# [lasso] AGENTS.md context files

## Path: /fake-home/.config/lasso/context/AGENTS.md

Global content
`,
      );
    });

    it("includes global agents dir files", () => {
      testFs._dirs.add(getGlobalContextDir());
      testFs._globResults.set("/fake-home/.config/lasso/context/**/AGENTS.md", [
        "/fake-home/.config/lasso/context/AGENTS.md",
      ]);
      testFs._files.set(
        "/fake-home/.config/lasso/context/AGENTS.md",
        "global content",
      );
      const result = getContextFilesStr(getContextEntries());
      assert.equal(
        result,
        `# [lasso] AGENTS.md context files

## Path: /fake-home/.config/lasso/context/AGENTS.md

global content
`,
      );
    });

    it("combines cwd and global agents dir files", () => {
      testFs._dirs.add(getGlobalContextDir());
      testFs._files.set(
        "/fake-home/.config/lasso/context/AGENTS.md",
        "global content",
      );
      testFs._files.set("/test-cwd/AGENTS.md", "local content");
      const result = getContextFilesStr(getContextEntries());
      assert.equal(
        result,
        `# [lasso] AGENTS.md context files

## Path: /test-cwd/AGENTS.md

local content


## Path: /fake-home/.config/lasso/context/AGENTS.md

global content
`,
      );
    });
  });

  describe("getSkillsStr", () => {
    it("returns empty string when no skills are found", () => {
      const result = getSkillsStr([]);
      assert.equal(result, "");
    });

    it("lists skills found in skill directories", () => {
      testFs._globResults.set("/fake-home/.config/lasso/skills/**/SKILL.md", [
        "/fake-home/.config/lasso/skills/my-skill/SKILL.md",
      ]);
      testFs._files.set(
        "/fake-home/.config/lasso/skills/my-skill/SKILL.md",
        `---
name: my-skill
description: A test skill
---
# Body`,
      );
      const result = getSkillsStr(getSkills());
      assert.equal(
        result,
        `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- my-skill: A test skill
`,
      );
    });

    it("deduplicates by parsed name, keeping first occurrence", () => {
      testFs._globResults.set("/test-cwd/.lasso/skills/**/SKILL.md", [
        "/test-cwd/.lasso/skills/local-skill/SKILL.md",
      ]);
      testFs._globResults.set("/fake-home/.config/lasso/skills/**/SKILL.md", [
        "/fake-home/.config/lasso/skills/global-skill/SKILL.md",
      ]);
      testFs._files.set(
        "/test-cwd/.lasso/skills/local-skill/SKILL.md",
        `---
name: deploy
description: Local deploy
---
# Local`,
      );
      testFs._files.set(
        "/fake-home/.config/lasso/skills/global-skill/SKILL.md",
        `---
name: deploy
description: Global deploy
---
# Global`,
      );
      const result = getSkillsStr(getSkills());
      assert.equal(
        result,
        `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- deploy: Local deploy
`,
      );
    });

    it("does not return duplicate skills", () => {
      testFs._globResults.set("/test-cwd/.lasso/skills/**/SKILL.md", [
        "/test-cwd/.lasso/skills/a/SKILL.md",
      ]);
      testFs._globResults.set("/fake-home/.config/lasso/skills/**/SKILL.md", [
        "/fake-home/.config/lasso/skills/b/SKILL.md",
      ]);
      testFs._files.set(
        "/test-cwd/.lasso/skills/a/SKILL.md",
        `---
name: deploy
description: First
---
# A`,
      );
      testFs._files.set(
        "/fake-home/.config/lasso/skills/b/SKILL.md",
        `---
name: deploy
description: Second
---
# B`,
      );
      const result = getSkills();
      assert.equal(result.length, 1);
      assert.deepStrictEqual(result[0], {
        name: "deploy",
        description: "First",
        content: "# A",
        dir: "/test-cwd/.lasso/skills/a",
      });
    });

    it("includes skills with different names", () => {
      testFs._globResults.set("/test-cwd/.lasso/skills/**/SKILL.md", [
        "/test-cwd/.lasso/skills/a/SKILL.md",
        "/test-cwd/.lasso/skills/b/SKILL.md",
      ]);
      testFs._files.set(
        "/test-cwd/.lasso/skills/a/SKILL.md",
        `---
name: skill-a
description: First
---
`,
      );
      testFs._files.set(
        "/test-cwd/.lasso/skills/b/SKILL.md",
        `---
name: skill-b
description: Second
---
`,
      );
      const result = getSkillsStr(getSkills());
      assert.equal(
        result,
        `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- skill-a: First
- skill-b: Second
`,
      );
    });

    it("skips non-existent skill directories", () => {
      testFs._globResults.set("/fake-home/.config/lasso/skills/**/SKILL.md", [
        "/fake-home/.config/lasso/skills/my-skill/SKILL.md",
      ]);
      testFs._files.set(
        "/fake-home/.config/lasso/skills/my-skill/SKILL.md",
        `---
name: my-skill
description: A test skill
---
# Body`,
      );
      const result = getSkillsStr(getSkills());
      assert.equal(
        result,
        `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- my-skill: A test skill
`,
      );
    });

    it("skips malformed skill files", () => {
      testFs._globResults.set("/fake-home/.config/lasso/skills/**/SKILL.md", [
        "/fake-home/.config/lasso/skills/bad/SKILL.md",
        "/fake-home/.config/lasso/skills/good/SKILL.md",
      ]);
      testFs._files.set(
        "/fake-home/.config/lasso/skills/bad/SKILL.md",
        "not front matter",
      );
      testFs._files.set(
        "/fake-home/.config/lasso/skills/good/SKILL.md",
        `---
name: good
description: Valid
---
`,
      );
      const result = getSkillsStr(getSkills());
      assert.equal(
        result,
        `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- good: Valid
`,
      );
    });

    it("includes skills from custom skill dirs", () => {
      actions.setCustomSkillDirs(["/custom/skills"]);
      testFs._globResults.set("/custom/skills/**/SKILL.md", [
        "/custom/skills/custom-skill/SKILL.md",
      ]);
      testFs._files.set(
        "/custom/skills/custom-skill/SKILL.md",
        `---
name: custom-skill
description: From custom dir
---
`,
      );
      const result = getSkillsStr(getSkills());
      assert.equal(
        result,
        `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- custom-skill: From custom dir
`,
      );
    });

    it("prioritizes custom skill dirs over local and global", () => {
      actions.setCustomSkillDirs(["/custom/skills"]);
      testFs._globResults.set("/custom/skills/**/SKILL.md", [
        "/custom/skills/deploy/SKILL.md",
      ]);
      testFs._globResults.set("/test-cwd/.lasso/skills/**/SKILL.md", [
        "/test-cwd/.lasso/skills/deploy/SKILL.md",
      ]);
      testFs._files.set(
        "/custom/skills/deploy/SKILL.md",
        `---
name: deploy
description: Custom deploy
---
`,
      );
      testFs._files.set(
        "/test-cwd/.lasso/skills/deploy/SKILL.md",
        `---
name: deploy
description: Local deploy
---
`,
      );
      const result = getSkillsStr(getSkills());
      assert.equal(
        result,
        `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- deploy: Custom deploy
`,
      );
    });

    it("includes nested AGENTS.md files as context skills", () => {
      testFs._gitLsFilesResults.set("**/AGENTS.md", [
        "/test-cwd/src/AGENTS.md",
      ]);
      testFs._files.set("/test-cwd/src/AGENTS.md", "nested content");
      const result = getSkillsStr(getSkills());
      assert.equal(
        result,
        `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- __lasso-context-for-/test-cwd/src: Context relevant for /test-cwd/src
`,
      );
    });

    it("nested AGENTS.md skills do not collide with regular skills", () => {
      testFs._globResults.set("/fake-home/.config/lasso/skills/**/SKILL.md", [
        "/fake-home/.config/lasso/skills/my-skill/SKILL.md",
      ]);
      testFs._files.set(
        "/fake-home/.config/lasso/skills/my-skill/SKILL.md",
        `---
name: my-skill
description: A test skill
---
# Body`,
      );
      testFs._gitLsFilesResults.set("**/AGENTS.md", [
        "/test-cwd/src/AGENTS.md",
      ]);
      testFs._files.set("/test-cwd/src/AGENTS.md", "nested content");
      const result = getSkillsStr(getSkills());
      assert.equal(
        result,
        `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- my-skill: A test skill
- __lasso-context-for-/test-cwd/src: Context relevant for /test-cwd/src
`,
      );
    });

    it("skips entries where globSync throws", () => {
      mock.method(fsDeps, "globSync", (pattern: string) => {
        if (pattern === "/test-cwd/.lasso/skills/**/SKILL.md")
          throw new Error("glob failed");
        return testFs.globSync(pattern);
      });
      testFs._globResults.set("/fake-home/.config/lasso/skills/**/SKILL.md", [
        "/fake-home/.config/lasso/skills/ok/SKILL.md",
      ]);
      testFs._files.set(
        "/fake-home/.config/lasso/skills/ok/SKILL.md",
        `---
name: ok
description: Works
---
`,
      );
      const result = getSkillsStr(getSkills());
      assert.equal(
        result,
        `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

- ok: Works
`,
      );
    });
  });

  describe("getSkillJSON", () => {
    it("returns null when file does not exist", () => {
      const result = getSkillJSON("/some/dir/SKILL.md");
      assert.equal(result, null);
    });

    it("parses valid SKILL.md front matter", () => {
      testFs._files.set(
        "/skill-dir/SKILL.md",
        `---
name: deploy
description: Deploy the app
---
# Deploy`,
      );
      const result = getSkillJSON("/skill-dir/SKILL.md");
      assert.deepStrictEqual(result, {
        name: "deploy",
        description: "Deploy the app",
        content: "# Deploy",
        dir: "/skill-dir",
      });
    });

    it("returns null when front matter is missing name", () => {
      testFs._files.set(
        "/skill-dir/SKILL.md",
        `---
description: No name here
---
`,
      );
      const result = getSkillJSON("/skill-dir/SKILL.md");
      assert.equal(result, null);
    });

    it("returns null when front matter is missing description", () => {
      testFs._files.set(
        "/skill-dir/SKILL.md",
        `---
name: deploy
---
`,
      );
      const result = getSkillJSON("/skill-dir/SKILL.md");
      assert.equal(result, null);
    });

    it("returns null when path is a directory", () => {
      testFs._dirs.add("/skill-dir");
      const result = getSkillJSON("/skill-dir");
      assert.equal(result, null);
    });

    it("returns null when readFileSync fails", () => {
      const result = getSkillJSON("/skill-dir/SKILL.md");
      assert.equal(result, null);
    });
  });

  describe("parseFrontMatter", () => {
    it("returns null when content does not start with ---\\n", () => {
      const result = parseFrontMatter("no front matter here");
      assert.equal(result, null);
    });

    it("returns null when content starts with --- but no newline", () => {
      const result = parseFrontMatter("---foo");
      assert.equal(result, null);
    });

    it("returns null when no closing delimiter", () => {
      const result = parseFrontMatter(`---
name: test
`);
      assert.equal(result, null);
    });

    it("returns null when yaml string is empty", () => {
      const result = parseFrontMatter(`---
---
body`);
      assert.equal(result, null);
    });

    it("parses valid front matter with attributes and body", () => {
      const result = parseFrontMatter(
        `---
name: my-skill
description: A skill
---
# Body content`,
      );
      assert.deepStrictEqual(result, {
        data: { name: "my-skill", description: "A skill" },
        body: "# Body content",
      });
    });

    it("parses front matter with no body", () => {
      const result = parseFrontMatter(`---
name: test
---
`);
      assert.deepStrictEqual(result, {
        data: { name: "test" },
        body: "",
      });
    });

    it("preserves body containing dashes", () => {
      const result = parseFrontMatter(
        `---
key: val
---
Body with --- inside
and more text`,
      );
      assert.deepStrictEqual(result, {
        data: { key: "val" },
        body: `Body with --- inside
and more text`,
      });
    });

    it("parses front matter when closing delimiter lacks trailing newline", () => {
      const result = parseFrontMatter(`---
key: val
---`);
      assert.deepStrictEqual(result, {
        data: { key: "val" },
        body: "",
      });
    });

    it("returns null on invalid yaml", () => {
      const result = parseFrontMatter(`---
* invalid
* ---
*  body`);
      assert.equal(result, null);
    });

    it("returns null on unclosed flow sequence in yaml", () => {
      const result = parseFrontMatter(`---
key: [unclosed
---
body`);
      assert.equal(result, null);
    });
  });
});
