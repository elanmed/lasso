# Bug / Code-Quality Findings for `lasso`

Each item includes the file(s) involved and the reasoning behind the finding.

### 1. `usage.ts` — usage-log lock is keyed by PID, so parallel subagents in the _same process_ self-block

`createLockUtils`'s `writeLock()` steals the lock from dead processes by checking `process.kill(pid, 0)`. But if two async calls to `syncNewModelUsageForLimitWindow` race **within the same Node process** (e.g. `createSubagentTool` runs tasks in parallel via `Promise.all`, each calling `appendModelUsage`), the second call sees a lock file written by its _own_ process. `process.kill(currentPid, 0)` trivially succeeds (the process is obviously alive), so `writeLock()` returns `false` — the second call believes the lock is legitimately held and gives up after ~250ms, printing "Failed to acquire a lock" and **silently dropping that subagent's usage from `modelUsageForLimitWindow`**, undermining the `usageLimit` dollar-cap feature exactly in the scenario (parallel subagents) the codebase explicitly supports.

---

### 8. `config.ts` — global/local config files are read twice per startup

`initStateFirst()` calls `readConfigFile(getGlobalConfigPath())` and `readConfigFile(getLocalConfigPath())` just to extract `hideStartupDurations`, and then `initStateFromConfig()` calls `readConfigFile()` on the exact same two paths again to extract everything else. This is redundant I/O on every startup and every `/reload`, and — however unlikely — opens a window where the two reads could observe different file contents if the config file changes between calls.

---

### 9. `context.ts` — root-level `AGENTS.md` can be double-surfaced as both context and a skill

`getContextEntries()` always injects `<cwd>/AGENTS.md` (and the global one) directly into the system prompt. Separately, `getSkills()` walks `git ls-files **/AGENTS.md` and turns _every_ matched `AGENTS.md` (including one at the repo root) into a lazily-loadable "skill" named `__lasso-context-for-<dir>`. There's no exclusion of the root file already covered by `getContextEntries()`, so the same file's content can be both always-injected _and_ separately offered as a discoverable skill.

---

### 10. `input.ts` — `/clear` silently wipes session cost tracking as a side effect

```ts
export function clearCommand() {
  print.infoSubtle(`Context cleared (${getPrettyTokenUsage()})`);
  actions.resetConversation();
  actions.setPromptTokens(getApproxPromptTokens());
  actions.setModelUsageForSession({}); // <-- resets the session $ / token counter to zero
}
```

`/clear` is documented (and named) as clearing the _conversation_, but it also resets `app.modelUsageForSession` to `{}`, permanently zeroing the "$ in session" figure shown elsewhere (e.g. in the fence status line). `modelUsageForLimitWindow` (which drives the actual dollar usage-limit enforcement) is left untouched, so the two usage trackers now diverge for no clearly-stated reason — a user could `/clear` several times and have the displayed session cost keep resetting to near-zero even though real spend continues to accumulate against their limit. Not covered by a test with nonzero prior usage (see also its sibling observation about /clear's side effects on usage tracking).

---

### 11. `usage.ts` — `getSystemInstructionsTokensApprox` name doesn't reflect that it includes tool definitions

```ts
export function getSystemInstructionsTokensApprox() {
  const systemContentTokensApprox = strToApproxTokens(
    promptDeps.getSystemContent(),
  );
  const toolsTokensApprox = strToApproxTokens(getState().app.toolsContentStr);
  return systemContentTokensApprox + toolsTokensApprox;
}
```

"System instructions" and "tools" are sent to the API as two conceptually distinct things (`instructions` vs `tools` parameters in `resolveApiCall`), but this function — and the user-facing warning text in `warnOnLargeSystemInstructions` ("the current set of context, skills, and tools is X% ... Lasso reserves ... for system instructions") — bundles both under the "system instructions" label, which is a naming/documentation inaccuracy.

---

### 12. `api.ts` — `getConversationSummary`'s `messages.slice(summaries.length)` relies on an undocumented invariant

```ts
const compactPrompt = `Compact the following conversation:
${JSON.stringify(getState().app.conversation.messages.slice(getState().app.conversation.summaries.length))}
`;
```

This only produces the correct "messages not yet summarized" slice because, after a compaction, `resetConversation()` + `setSummaries()` + re-appending one assistant message per summary guarantees that the first `summaries.length` messages exactly mirror the summaries. That invariant is never stated in a comment, and nothing enforces it — any future code path that appends to `conversation.summaries` without also appending a matching message (or vice versa) would silently corrupt what gets fed into the next compaction prompt.

---

### 13. `utils.ts` — `getTempFileName` silently produces a non-existent file when `initialContentPath` can't be read

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

### 14. `utils.ts` — `safeStringify` can return `undefined` instead of a string

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

### 16. `api.ts` — `resolveApiCall`'s abort-path token bookkeeping is dead work

```ts
actions.appendToConversation(interruptMessage);
actions.appendToPromptTokens(
  strToApproxTokens(userInput) + strToApproxTokens(interruptContent),
);
actions.setPromptTokensDirty(true);
```

`appendToPromptTokens` computes and stores an approximate delta into `promptTokens.value`, but the very next line marks `promptTokens.dirty = true`. Every actual consumer of prompt-token count (`getCurrentPromptTokens()`) ignores `promptTokens.value` entirely while `dirty` is `true`, falling back to a fresh `getApproxPromptTokens()` computation instead. So the `appendToPromptTokens` call's result is never actually used for anything — it's dead computation that exists only because a test happens to assert the exact (irrelevant) stored value.

---

### 17. `text.ts` — `truncate()` always appends an ellipsis for multi-line input, even when the first line already fits

```ts
if (newlineIdx !== -1) {
  return firstLine.substring(0, maxLen - 1).concat(ellipsis);
}
```

For any string containing a newline, an ellipsis is unconditionally appended to the first line — even if that first line is far shorter than `maxLen` and wasn't actually truncated for width reasons. This conflates "there is more content after this line" with "this line was cut off," which may be intentional but isn't documented as such, and means e.g. `truncate("hi\nrest")` on a very wide terminal still yields `"hi…"` rather than `"hi"`.

---

### 18. `log.ts` — `prependToChatHistory` checks file existence to decide whether to create the _directory_

```ts
export function prependToChatHistory(content: string, role: "user" | "assistant") {
  const path = getState().app.chatHistoryPath;
  if (!fsDeps.existsSync(path)) {
    const mkdirResult = tryCatch(() => fsDeps.mkdirSync(dirname(path), { recursive: true }));
    ...
```

The condition tests whether the _file_ (`path`) exists, then (if not) creates the _directory_ (`dirname(path)`). This only works because, in practice, the file never exists without its directory also existing. The check reads as though it's testing directory existence and is easy to misread; it would be clearer (and more robust to being called with a fresh/unusual path) to check `existsSync(dirname(path))` directly.
