import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getBaseAgentPrompt,
  getConversationSummaryPrompt,
  getMergeSummariesPrompt,
  getSubagentPrompt,
} from "./prompts.ts";
import { makeFakeMcpClient } from "./test-helpers.ts";

describe("prompts", () => {
  const baseAgentPromptExpectation = (mcpServersLis: string) =>
    [
      "# [lasso] Base system prompt",
      "",
      "## [lasso] Core principles",
      "",
      "- You are an AI agent being called from a minimal terminal cli called lasso.",
      "- Be concise: 1 sentence when possible, under 25 words unless detail is required. Questions get answers, no padding.",
      "- For debugging: give 1 command at a time, never multiple",
      "- All responses are piped through bat as markdown — always emit valid markdown",
      "- After a successful file-modifying tool (bash with fileSystemAccessType create-update-delete): the CLI auto-outputs a diff. Do NOT repeat the code, file contents, or a diff of the change in your response — summarize in prose only. Verification via a targeted read (e.g. sed -n) is fine, but don't re-echo what the diff already showed",
      "",
      "## [lasso] Web search",
      "",
      "- When using the `web_fetch_html` or `web_fetch_json` tools for web search, note that Google, Bing, and most other search engines block automated requests.",
      "- Instead, use the following agent-friendly search engines via constructed urls:",
      "  - `https://html.duckduckgo.com/html/?q=<url-encoded query>` (use with `web_fetch_html`)",
      "  - `https://search.marginalia.nu/search?query=<url-encoded query>` (use with `web_fetch_html`)",
      "  - `https://en.wikipedia.org/w/index.php?search=<url-encoded query>` (use with `web_fetch_html`)",
      "",
      "## [lasso] MCP Servers",
      "",
      mcpServersLis,
      "",
      "## Filesystem actions via bash",
      "",
      "The following instructions show how to use plain bash to perform basic file operations. These instructions are suggestions - use them at your discretion. For example, you may prefer to write an inline Python or Node.js script, especially when editing multiple files at once.",
      "",
      "Note: ${START}, ${END}, ${LINE} are placeholders. Replace with actual line numbers.",
      "",
      "### Read a range of lines",
      "```bash",
      'sed -n "${START},${END}p" target.txt',
      "```",
      "",
      "### Write content to an empty file",
      "```bash",
      "cat > target.txt << 'EOF'",
      "Your content here",
      'with "quotes" and $variables left literal',
      "EOF",
      "```",
      "",
      "### Insert content starting after a line",
      "```bash",
      "INSERTFILE=$(mktemp)",
      "cat > \"$INSERTFILE\" << 'EOF'",
      "Content to insert",
      "EOF",
      "TMPFILE=$(mktemp)",
      'sed -e "${LINE}r $INSERTFILE" target.txt > "$TMPFILE" && mv "$TMPFILE" target.txt',
      'rm "$INSERTFILE"',
      "```",
      "",
      "### Replace a range of lines",
      "```bash",
      "INSERTFILE=$(mktemp)",
      "cat > \"$INSERTFILE\" << 'EOF'",
      "Replacement content",
      "EOF",
      "TMPFILE=$(mktemp)",
      'sed -e "${END}r $INSERTFILE" -e "${START},${END}d" target.txt > "$TMPFILE" && mv "$TMPFILE" target.txt',
      'rm "$INSERTFILE"',
      "```",
      "",
      "### Delete a range of lines",
      "```bash",
      "TMPFILE=$(mktemp)",
      'sed -e "${START},${END}d" target.txt > "$TMPFILE" && mv "$TMPFILE" target.txt',
      "```",
    ].join("\n");

  const readOnlySubagentPromptExpectation = (mcpServersLis: string) =>
    [
      "# [lasso] Base system prompt",
      "",
      "## [lasso] Core principles",
      "",
      "- You are a read-only subagent. Although you have access to a bash tool, you must NOT use it to perform any modifications to the file system.",
      "",
      "## [lasso] Web search",
      "",
      "- When using the `web_fetch_html` or `web_fetch_json` tools for web search, note that Google, Bing, and most other search engines block automated requests.",
      "- Instead, use the following agent-friendly search engines via constructed urls:",
      "  - `https://html.duckduckgo.com/html/?q=<url-encoded query>` (use with `web_fetch_html`)",
      "  - `https://search.marginalia.nu/search?query=<url-encoded query>` (use with `web_fetch_html`)",
      "  - `https://en.wikipedia.org/w/index.php?search=<url-encoded query>` (use with `web_fetch_html`)",
      "",
      "## [lasso] MCP Servers",
      "",
      mcpServersLis,
      "",
      "## Filesystem actions via bash",
      "",
      "The following instructions show how to use plain bash to perform basic file operations. These instructions are suggestions - use them at your discretion. For example, you may prefer to write an inline Python or Node.js script, especially when editing multiple files at once.",
      "",
      "Note: ${START}, ${END}, ${LINE} are placeholders. Replace with actual line numbers.",
      "",
      "### Read a range of lines",
      "```bash",
      'sed -n "${START},${END}p" target.txt',
      "```",
    ].join("\n");
  const readWriteSubagentPromptExpectation = (mcpServersLis: string) =>
    [
      "# [lasso] Base system prompt",
      "",
      "## [lasso] Core principles",
      "",
      "- You are a subagent with read-write access.",
      "",
      "## [lasso] Web search",
      "",
      "- When using the `web_fetch_html` or `web_fetch_json` tools for web search, note that Google, Bing, and most other search engines block automated requests.",
      "- Instead, use the following agent-friendly search engines via constructed urls:",
      "  - `https://html.duckduckgo.com/html/?q=<url-encoded query>` (use with `web_fetch_html`)",
      "  - `https://search.marginalia.nu/search?query=<url-encoded query>` (use with `web_fetch_html`)",
      "  - `https://en.wikipedia.org/w/index.php?search=<url-encoded query>` (use with `web_fetch_html`)",
      "",
      "## [lasso] MCP Servers",
      "",
      mcpServersLis,
      "",
      "## Filesystem actions via bash",
      "",
      "The following instructions show how to use plain bash to perform basic file operations. These instructions are suggestions - use them at your discretion. For example, you may prefer to write an inline Python or Node.js script, especially when editing multiple files at once.",
      "",
      "Note: ${START}, ${END}, ${LINE} are placeholders. Replace with actual line numbers.",
      "",
      "### Read a range of lines",
      "```bash",
      'sed -n "${START},${END}p" target.txt',
      "```",
      "",
      "### Write content to an empty file",
      "```bash",
      "cat > target.txt << 'EOF'",
      "Your content here",
      'with "quotes" and $variables left literal',
      "EOF",
      "```",
      "",
      "### Insert content starting after a line",
      "```bash",
      "INSERTFILE=$(mktemp)",
      "cat > \"$INSERTFILE\" << 'EOF'",
      "Content to insert",
      "EOF",
      "TMPFILE=$(mktemp)",
      'sed -e "${LINE}r $INSERTFILE" target.txt > "$TMPFILE" && mv "$TMPFILE" target.txt',
      'rm "$INSERTFILE"',
      "```",
      "",
      "### Replace a range of lines",
      "```bash",
      "INSERTFILE=$(mktemp)",
      "cat > \"$INSERTFILE\" << 'EOF'",
      "Replacement content",
      "EOF",
      "TMPFILE=$(mktemp)",
      'sed -e "${END}r $INSERTFILE" -e "${START},${END}d" target.txt > "$TMPFILE" && mv "$TMPFILE" target.txt',
      'rm "$INSERTFILE"',
      "```",
      "",
      "### Delete a range of lines",
      "```bash",
      "TMPFILE=$(mktemp)",
      'sed -e "${START},${END}d" target.txt > "$TMPFILE" && mv "$TMPFILE" target.txt',
      "```",
    ].join("\n");

  describe("system prompts", () => {
    it("formats the base agent prompt exactly", () => {
      assert.strictEqual(
        getBaseAgentPrompt({}),
        baseAgentPromptExpectation("No available MCP servers"),
      );
    });

    describe("mcp servers", () => {
      it("formats the base agent prompt with mcp server bullets", () => {
        assert.strictEqual(
          getBaseAgentPrompt({
            alpha: makeFakeMcpClient(),
            beta: makeFakeMcpClient(),
          }),
          baseAgentPromptExpectation("- alpha\n- beta"),
        );
      });

      it("lists server instructions in the base agent prompt", () => {
        assert.strictEqual(
          getBaseAgentPrompt({
            alpha: makeFakeMcpClient({
              instructions: "Call the alpha tool for edits.",
            }),
          }),
          baseAgentPromptExpectation(
            "- alpha\n  Instructions: Call the alpha tool for edits.",
          ),
        );
      });

      it("formats the read-only subagent prompt with mcp server bullets", () => {
        assert.strictEqual(
          getSubagentPrompt("read-only", { alpha: makeFakeMcpClient() }),
          readOnlySubagentPromptExpectation("- alpha"),
        );
      });

      it("lists server instructions in the read-only subagent prompt", () => {
        assert.strictEqual(
          getSubagentPrompt("read-only", {
            alpha: makeFakeMcpClient({
              instructions: "Call the alpha tool for edits.",
            }),
          }),
          readOnlySubagentPromptExpectation(
            "- alpha\n  Instructions: Call the alpha tool for edits.",
          ),
        );
      });

      it("formats the read-write subagent prompt with mcp server bullets", () => {
        assert.strictEqual(
          getSubagentPrompt("read-write", { alpha: makeFakeMcpClient() }),
          readWriteSubagentPromptExpectation("- alpha"),
        );
      });

      it("lists server instructions in the read-write subagent prompt", () => {
        assert.strictEqual(
          getSubagentPrompt("read-write", {
            alpha: makeFakeMcpClient({
              instructions: "Call the alpha tool for edits.",
            }),
          }),
          readWriteSubagentPromptExpectation(
            "- alpha\n  Instructions: Call the alpha tool for edits.",
          ),
        );
      });

      it("uses No available MCP servers as the list when there are none", () => {
        assert.strictEqual(
          getBaseAgentPrompt({}),
          baseAgentPromptExpectation("No available MCP servers"),
        );
      });
    });
  });

  it("formats a read-only subagent prompt exactly", () => {
    assert.strictEqual(
      getSubagentPrompt("read-only", {}),
      readOnlySubagentPromptExpectation("No available MCP servers"),
    );
  });

  it("formats a read-write subagent prompt exactly", () => {
    assert.strictEqual(
      getSubagentPrompt("read-write", {}),
      readWriteSubagentPromptExpectation("No available MCP servers"),
    );
  });

  describe("compaction prompts", () => {
    it("formats the conversation summary prompt exactly", () => {
      assert.strictEqual(
        getConversationSummaryPrompt({
          targetCharLen: 1000,
          conversation: `## user

hello`,
        }),
        [
          "## [lasso] Compact conversation",
          "",
          "- Compact the following conversation.",
          '- Summarize into exactly two sections: "## Key facts" and "## Everything else".',
          "- Key facts are details that must survive all future compactions, such as decisions, file paths, task state, and user preferences.",
          '- Write "## Key facts" as a flat bullet list of short, self-contained facts.',
          '- When the maximum length is tight, cut from "## Everything else" and never from "## Key facts."',
          "- Output a plain-text prose summary, not JSON or a code fence.",
          "- Output a maximum of 1000 characters.",
          "",
          "## user",
          "",
          "hello",
        ].join("\n"),
      );
    });

    it("formats the merge summaries prompt exactly", () => {
      assert.strictEqual(
        getMergeSummariesPrompt({
          targetCharLen: 500,
          summaries: `first

second`,
        }),
        [
          "## [lasso] Compact summaries",
          "",
          "- Merge the following two summaries into one.",
          '- Build "## Key facts" from the union of the key facts in both summaries.',
          "- Keep every existing key fact: you may deduplicate or reword only when needed, but never change their meaning and never delete one.",
          "- If a key fact is superseded by a later one, delete the outdated one.",
          '- Summarize into exactly two sections: "## Key facts" and "## Everything else".',
          "- Key facts are details that must survive all future compactions, such as decisions, file paths, task state, and user preferences.",
          '- Write "## Key facts" as a flat bullet list of short, self-contained facts.',
          '- When the maximum length is tight, cut from "## Everything else" and never from "## Key facts."',
          "- Output a plain-text prose summary, not JSON or a code fence.",
          "- Output a maximum of 500 characters.",
          "",
          "first",
          "",
          "second",
        ].join("\n"),
      );
    });
  });
});
