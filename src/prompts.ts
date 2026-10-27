import { type MCPClient } from "@ai-sdk/mcp";

type MCPClients = Record<string, MCPClient>;

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
\`\`\``;

const bashIntroHeadingTwo = `## Filesystem actions via bash

The following instructions show how to use plain bash to perform basic file operations. These instructions are suggestions - use them at your discretion. For example, you may prefer to write an inline Python or Node.js script, especially when editing multiple files at once.

Note: \${START}, \${END}, \${LINE} are placeholders. Replace with actual line numbers.`;

const toolDiffLi = `- After a successful file-modifying tool (bash with fileSystemAccessType create-update-delete): the CLI auto-outputs a diff. Do NOT repeat the code, file contents, or a diff of the change in your response — summarize in prose only. Verification via a targeted read (e.g. sed -n) is fine, but don't re-echo what the diff already showed`;

const headingOne = `# [lasso] Base system prompt`;

const corePrinciplesHeading = `## [lasso] Core principles`;

const mcpHeadingTwo = `## [lasso] MCP Servers`;

const getMcpLis = (mcpClients: MCPClients) => {
  if (Object.keys(mcpClients).length === 0) {
    return `No available MCP servers`;
  }

  return Object.entries(mcpClients)
    .map(([name, client]) => {
      const line = `- ${name}`;
      const lines = [line];
      if (client.instructions !== undefined) {
        lines.push(`  Instructions: ${client.instructions}`);
      }
      return lines.join("\n");
    })
    .join("\n");
};

const webSearchHeadingTwo = `## [lasso] Web search`;

const webSearchLis = `- When using the \`web_fetch_html\` or \`web_fetch_json\` tools for web search, note that Google, Bing, and most other search engines block automated requests.
- Instead, use the following agent-friendly search engines via constructed urls:
  - \`https://html.duckduckgo.com/html/?q=<url-encoded query>\` (use with \`web_fetch_html\`)
  - \`https://search.marginalia.nu/search?query=<url-encoded query>\` (use with \`web_fetch_html\`)
  - \`https://en.wikipedia.org/w/index.php?search=<url-encoded query>\` (use with \`web_fetch_html\`)`;

export const getBaseAgentPrompt = (mcpClients: MCPClients) => `${headingOne}

${corePrinciplesHeading}

- You are an AI agent being called from a minimal terminal cli called lasso.
- Be concise: 1 sentence when possible, under 25 words unless detail is required. Questions get answers, no padding.
- For debugging: give 1 command at a time, never multiple
- All responses are piped through bat as markdown — always emit valid markdown
${toolDiffLi}

${webSearchHeadingTwo}

${webSearchLis}

${mcpHeadingTwo}

${getMcpLis(mcpClients)}

${bashIntroHeadingTwo}

${readInstructions}

${writeInstructions}`;

export const getSubagentPrompt = (
  access: "read-only" | "read-write",
  mcpClients: MCPClients,
) => {
  if (access === "read-only") {
    return `${headingOne}

${corePrinciplesHeading}

- You are a read-only subagent. Although you have access to a bash tool, you must NOT use it to perform any modifications to the file system.

${webSearchHeadingTwo}

${webSearchLis}

${mcpHeadingTwo}

${getMcpLis(mcpClients)}

${bashIntroHeadingTwo}

${readInstructions}`;
  }

  return `${headingOne}

${corePrinciplesHeading}

- You are a subagent with read-write access.

${webSearchHeadingTwo}

${webSearchLis}

${mcpHeadingTwo}

${getMcpLis(mcpClients)}

${bashIntroHeadingTwo}

${readInstructions}

${writeInstructions}`;
};

const sharedLis = `- Summarize into exactly two sections: "## Key facts" and "## Everything else".
- Key facts are details that must survive all future compactions, such as decisions, file paths, task state, and user preferences.
- Write "## Key facts" as a flat bullet list of short, self-contained facts.
- When the maximum length is tight, cut from "## Everything else" and never from "## Key facts."
- Output a plain-text prose summary, not JSON or a code fence.`;

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
- Build "## Key facts" from the union of the key facts in both summaries.
- Keep every existing key fact: you may deduplicate or reword only when needed, but never change their meaning and never delete one.
- If a key fact is superseded by a later one, delete the outdated one.
${sharedLis}
${getMaxLenLi(targetCharLen)}

${summaries}`;
};
