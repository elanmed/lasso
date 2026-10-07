const writeInstructions = `### Write content to an empty file
\`\`\`bash
cat > target.txt << 'EOF'
Your content here
with "quotes" and $variables left literal
EOF
\`\`\`

### Insert content starting after a line
\`\`\`bash
INSERTFILE=$(mktemp)
cat > "$INSERTFILE" << 'EOF'
Content to insert
EOF
TMPFILE=$(mktemp)
sed -e "\${LINE}r $INSERTFILE" target.txt > "$TMPFILE" && mv "$TMPFILE" target.txt
rm "$INSERTFILE"
\`\`\`

### Replace a range of lines
\`\`\`bash
INSERTFILE=$(mktemp)
cat > "$INSERTFILE" << 'EOF'
Replacement content
EOF
TMPFILE=$(mktemp)
sed -e "\${END}r $INSERTFILE" -e "\${START},\${END}d" target.txt > "$TMPFILE" && mv "$TMPFILE" target.txt
rm "$INSERTFILE"
\`\`\`

### Delete a range of lines
\`\`\`bash
TMPFILE=$(mktemp)
sed -e "\${START},\${END}d" target.txt > "$TMPFILE" && mv "$TMPFILE" target.txt
\`\`\``;

const readInstructions = `### Read a range of lines
\`\`\`bash
sed -n "\${START},\${END}p" target.txt
\`\`\`

### Read an image as base64
\`\`\`bash
base64 < target.png
\`\`\`

### Get total line count
\`\`\`bash
wc -l < target.txt
\`\`\``;

const bashIntroHeadingTwo = `## Filesystem actions (via bash)

Note: \${START}, \${END}, \${LINE} are placeholders. Replace with actual line numbers.`;

const toolDiffLi = `- After a successful file-modifying tool (bash with fileSystemAccessType create-update-delete): the CLI auto-outputs a diff. Do NOT repeat the code, file contents, or a diff of the change in your response — summarize in prose only. Verification via a targeted read (e.g. sed -n) is fine, but don't re-echo what the diff already showed`;

const headingOne = `# [lasso] Base system prompt`;

const corePrinciplesHeading = `## [lasso] Core principles`;

const mcpHeadingTwo = `## [lasso] MCP Servers`;

const getMcpLis = (mcpClientNames: string[]) => {
  if (mcpClientNames.length === 0) {
    return `No available MCP servers`;
  }

  return mcpClientNames.map((name) => `- ${name}`).join("\n");
};

export const getBaseAgentPrompt = (mcpClientNames: string[]) => `${headingOne}

${corePrinciplesHeading}

- You are an AI agent being called from a minimal terminal cli called lasso.
- Be concise: 1 sentence when possible, under 25 words unless detail is required. Questions get answers, no padding.
- For debugging: give 1 command at a time, never multiple
- All responses are piped through bat as markdown — always emit valid markdown
${toolDiffLi}

${mcpHeadingTwo}

${getMcpLis(mcpClientNames)}

${bashIntroHeadingTwo}

${readInstructions}

${writeInstructions}`;

export const getSubagentPrompt = (
  access: "read-only" | "read-write",
  mcpClientNames: string[],
) => {
  if (access === "read-only") {
    return `${headingOne}

${corePrinciplesHeading}
- You are a read-only subagent. Although you have access to a bash tool, you must NOT use it to perform any modifications to the file system.

${mcpHeadingTwo}

${getMcpLis(mcpClientNames)}

${bashIntroHeadingTwo}

${readInstructions}`;
  }

  return `${headingOne}

${corePrinciplesHeading}
- You are a subagent with read-write access.

${mcpHeadingTwo}

${getMcpLis(mcpClientNames)}

${bashIntroHeadingTwo}

${readInstructions}

${writeInstructions}`;
};

const sharedLis = `- Summarize into exactly two sections: "## Key facts" and "## Everything else".
- Key facts are details that must survive all future compactions, such as decisions, file paths, task state, and user preferences.
- Write "## Key facts" as a flat bullet list of short, self-contained facts.
- When the maximum length is tight, cut from "## Everything else" and never from "## Key facts."
- Output a plain-text prose summary, not JSON or a code fence.`;

const mergeLis = `- Build "## Key facts" from the union of the key facts in both summaries.
- Keep every existing key fact: you may deduplicate or reword only when needed, but never change their meaning and never delete one.
- If a key fact is superseded by a later one, delete the outdated one.`;

const getMaxLenLi = (targetCharLen: number) =>
  `- Output a maximum of ${String(targetCharLen)} characters.`;

export const getConversationSummaryPrompt = ({
  targetCharLen,
  conversation,
}: {
  targetCharLen: number;
  conversation: string;
}) => {
  return `## [lasso] Compact conversation

- Compact the following conversation.
${sharedLis}
${getMaxLenLi(targetCharLen)}

${conversation}`;
};

export const getMergeSummariesPrompt = ({
  targetCharLen,
  summaries,
}: {
  targetCharLen: number;
  summaries: string;
}) => {
  return `## [lasso] Compact summaries

- Merge the following two summaries into one.
${mergeLis}
${sharedLis}
${getMaxLenLi(targetCharLen)}

${summaries}`;
};
