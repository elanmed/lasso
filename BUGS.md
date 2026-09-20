# Bug / Code-Quality Findings for `lasso`

Each item includes the file(s) involved and the reasoning behind the finding.

### 1. `usage.ts` — usage-log lock is keyed by PID, so parallel subagents in the _same process_ self-block

`createLockUtils`'s `writeLock()` steals the lock from dead processes by checking `process.kill(pid, 0)`. But if two async calls to `syncNewModelUsageForLimitWindow` race **within the same Node process** (e.g. `createSubagentTool` runs tasks in parallel via `Promise.all`, each calling `appendModelUsage`), the second call sees a lock file written by its _own_ process. `process.kill(currentPid, 0)` trivially succeeds (the process is obviously alive), so `writeLock()` returns `false` — the second call believes the lock is legitimately held and gives up after ~250ms, printing "Failed to acquire a lock" and **silently dropping that subagent's usage from `modelUsageForLimitWindow`**, undermining the `usageLimit` dollar-cap feature exactly in the scenario (parallel subagents) the codebase explicitly supports.

---

### 2. `api.ts` — `getConversationSummary`'s `messages.slice(summaries.length)` relies on an undocumented invariant

```ts
const compactPrompt = `Compact the following conversation:
${JSON.stringify(getState().app.conversation.messages.slice(getState().app.conversation.summaries.length))}
`;
```

This only produces the correct "messages not yet summarized" slice because, after a compaction, `resetConversation()` + `setSummaries()` + re-appending one assistant message per summary guarantees that the first `summaries.length` messages exactly mirror the summaries. That invariant is never stated in a comment, and nothing enforces it — any future code path that appends to `conversation.summaries` without also appending a matching message (or vice versa) would silently corrupt what gets fed into the next compaction prompt.
