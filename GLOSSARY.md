# Lasso

Lasso is a terminal-based agent harness that connects a user to an AI model and supporting tools.

## Participants

**Agent**:
The AI model Lasso runs to respond to the user; it receives instructions and can invoke available **Tools**.

**Harness**:
The software around an **Agent** that connects it to the user and supplies instructions and tool access. Lasso is the harness.

## Conversation history

**Session**:
A durable record of one conversation between a user and Lasso. Resuming its history starts a new session with that history as its starting point.

**Conversation**:
The active model-facing message history for a **Session**, including tool calls and results; older messages may be compacted into summaries.

**Transcript**:
A chronological, timestamped record of user inputs and assistant replies, kept for reviewing chat history; it omits tool interactions from the model's conversation context.

**Compaction**:
A process used near the context-window limit to summarize older **Conversation** messages with a separate LLM call while keeping recent messages.

## User input and control

**Slash command**:
A user-triggered instruction prefixed with `/`; it resolves to a built-in action, custom prompt, or **Skill**.

**Steering**:
An active-turn control triggered through its keymap that interrupts the current model call and starts another using the editor's current draft.

**Message queue**:
A sequence of user messages entered together and separated by a configured delimiter; Lasso sends them one per assistant turn without prompting between them.

**Transcription**:
The process of converting a user's recorded audio into text for use as input; distinct from a **Transcript**, which records the conversation.

## Agent guidance

**Context**:
Background guidance the agent receives automatically. Guidance scoped to a nested directory is exposed as a **Skill** instead.

**Skill**:
Focused agent guidance the agent can load when relevant. Some directory-scoped **Context** is exposed this way rather than included automatically.

## Agent capabilities and integrations

**Tool**:
A capability the model can invoke during a response to perform an action or retrieve information.

**Subagent**:
A separate **Agent** run for delegated work, with a defined task and access scope. Its blocking **Tool** call waits for results; multiple subagents may run in parallel.

**Worker**:
A separate **Agent** run launched by another **Agent** that runs asynchronously under the launching Lasso process; launching it does not wait for its completion, and it is cleaned up when that process exits.

**MCP server**:
An external service or process Lasso connects to through MCP, providing tools and resources that Lasso makes available to the agent.

**Resource**:
A piece of information exposed by an **MCP server** for the agent to discover and read, rather than an action to execute.

## Usage limits

**Usage limit**:
A configured dollar cap over a rolling time window, calculated from token usage and per-model pricing; usage from concurrent sessions contributes to the same total.
