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

---

### 3. `utils.ts` — `getTempFileName` silently produces a non-existent file when `initialContentPath` can't be read

```ts
if (initialContentPath !== undefined) {
  const readResult = tryCatch(() =>
    fsDeps.readFileSync(initialContentPath).toString(),
  );
  if (readResult.ok) {
    tryCatch(() => fsDeps.writeFileSync(tempFile, readResult.value));
  }
  // else: nothing is written — tempFile is returned but doesn't exist on disk
} else if (initialContentStr !== undefined) {
  tryCatch(() => fsDeps.writeFileSync(tempFile, initialContentStr));
} else {
  tryCatch(() => fsDeps.writeFileSync(tempFile, "")); // <-- the "no args" case DOES write a placeholder
}
```

The "no args" branch is careful to always create an (empty) file at the returned path, but the "`initialContentPath` given but unreadable" branch is not — it leaves the returned path pointing at nothing. This inconsistency is the root cause of the new-file crash.

---

### 4. `utils.ts` — `safeStringify` can return `undefined` instead of a string

```ts
export function safeStringify(val: unknown) {
  if (val === undefined) return "";
  const stringifyResult = tryCatch(() => JSON.stringify(val));
  if (stringifyResult.ok) return stringifyResult.value;
  return getMessageFromError(stringifyResult.error);
}
```

`JSON.stringify` doesn't throw for values like a bare function or `Symbol` at the top level — it returns `undefined` without an error. In that case `stringifyResult.ok` is `true` and `stringifyResult.value` is `undefined`, so `safeStringify` returns `undefined` rather than a string, silently breaking the implicit "this always returns a string" contract its callers (`safeStringify(toolCall.input)`, `safeStringify(getTools())`) rely on.

---

### 5. `api.ts` — `resolveApiCall`'s abort-path token bookkeeping is dead work

```ts
actions.appendToConversation(interruptMessage);
actions.appendToPromptTokens(
  strToApproxTokens(userInput) + strToApproxTokens(interruptContent),
);
actions.setPromptTokensDirty(true);
```

`appendToPromptTokens` computes and stores an approximate delta into `promptTokens.value`, but the very next line marks `promptTokens.dirty = true`. Every actual consumer of prompt-token count (`getCurrentPromptTokens()`) ignores `promptTokens.value` entirely while `dirty` is `true`, falling back to a fresh `getApproxPromptTokens()` computation instead. So the `appendToPromptTokens` call's result is never actually used for anything — it's dead computation that exists only because a test happens to assert the exact (irrelevant) stored value.

---

### 6. `text.ts` — `truncate()` always appends an ellipsis for multi-line input, even when the first line already fits

```ts
if (newlineIdx !== -1) {
  return firstLine.substring(0, maxLen - 1).concat(ellipsis);
}
```

For any string containing a newline, an ellipsis is unconditionally appended to the first line — even if that first line is far shorter than `maxLen` and wasn't actually truncated for width reasons. This conflates "there is more content after this line" with "this line was cut off," which may be intentional but isn't documented as such, and means e.g. `truncate("hi\nrest")` on a very wide terminal still yields `"hi…"` rather than `"hi"`.
