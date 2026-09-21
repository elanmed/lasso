### 1. New file creation never produces a diff, but the system prompt tells the model the CLI always shows one (severity: high)

`src/differ.ts`, `setTempFileBefore`:

```ts
function setTempFileBefore(toolCallId: string, path: string) {
  const tempFileBefore = getTempFileName({ initialContentPath: path });
  if (tempFileBefore === null) return;   // silently no-ops if file doesn't exist yet
  ...
```

When a bash command creates a brand-new file, `getTempFileName({initialContentPath: path})` fails to read the (not-yet-existing) file and returns `null`, so no "before" snapshot is ever registered. Later, `diffAndCleanup` sees `!toolCallIdToTempFileBefore.has(toolCallId)` and just deletes the "after" snapshot without printing anything (confirmed by `differ.test.ts`, "skipped the diff for a newly-created file with no before snapshot").

Meanwhile `src/prompts.ts` (`BASE_SYSTEM_PROMPT`) tells the model:

> "After a successful file-modifying tool ... the CLI auto-outputs a diff. Do NOT repeat the code, file contents, or a diff of the change in your response"

So for the extremely common case of the agent creating a new file, the model is instructed not to show its work, and the CLI shows nothing either — the user has no way to see what was written without manually opening the file.

---

### 2. Unquoted temp-file paths in generated shell command strings (severity: medium, platform-dependent)

Several places build a shell command as a plain string and interpolate a temp-file path **without quoting**, then execute it via a shell (`childProcess.exec`/`spawnSync(..., {shell:true})`):

- `src/differ.ts`, `execGitDiff`:

```ts
const base = `git diff --no-index ${colorFlag} -U3 ${opts.tempFileBeforePath} ${opts.tempFileAfterPath}`;
```

- `src/input.ts`, `spawnAndReadEditorContent`'s default/`EDITOR` fallback:

```ts
return `vi ${tempFile}`;
// ...
return `${editorEnvValue} ${tempFile}`;
```

- `src/terminal.ts`, `openWithPager`'s `LASSO_PAGER_*`/`LASSO_PAGER` substitution:

```ts
return pagerEnvValue.replace("__FILE__", tempFile);
```

All temp files come from `os.tmpdir()` + `getTempFileName`, so if the OS temp directory (or, on Windows, a username) contains a space or shell-special character, these commands will word-split incorrectly and fail. Some sibling code paths in the same files (the `PAGER` fallback, the default `bat`/`less` invocations) **do** quote the path — the inconsistency itself is also worth noting, since it suggests the omission elsewhere wasn't intentional.

---

### 3. Usage-limit tracking can silently drop data under filesystem/lock contention (severity: low-medium)

`src/usage.ts`, `syncNewModelUsageForLimitWindow` / `syncInitialModelUsageForLimitWindow`:

```ts
const created = await lockUtils.createLock();
if (!created) {
  return print.warning(`Failed to acquire a lock for ${getUsageLogLockPath()}`);
}
```

and similarly, if `mkdirSync` for the usage-log directory fails, the function warns and returns without updating in-memory state. In both cases the current API call's token usage is simply **not counted** toward the configured `usageLimit`. Since the entire point of `usageLimit` is to stop the user from overspending, silently dropping usage records on transient FS/lock issues (however rare) undermines the guarantee with no retry and no persistent record that anything was missed.

---

### 4. `bashToolInputSchema`'s "read" and "create-update-delete" descriptions are near-duplicated boilerplate

`src/tools.ts`:

```ts
.describe("Run a bash command that only reads from the file system. Temp files are intermediates: commands writing only to temp files (like from mktemp) also count as read")
...
.describe("Run a bash command that creates, updates, or deletes files at filePath. Temp files are intermediates: commands writing only to temp files (like from mktemp) count as read, never create-update-delete")
```

The temp-file caveat is copy-pasted into _both_ branches of the discriminated union, including the branch it isn't really relevant to (the "create-update-delete" describe text re-explains when something counts as "read" instead of describing this branch). This reads as an editing artifact and is confusing guidance for the model consuming the schema.

---

### 5. `resume()` and custom-slash-command context both bake unintended trailing whitespace into model input

- `src/input.ts`, `resume`:

```ts
return `Continue the conversation recorded in the transcript below. Respond to this message with "Ready to continue chatting."
  Transcript:
  ${readResult.value}
      `;
```

- `src/input.ts`, `resolveCustomSlashCommand`:

```ts
const contentWithCommandContext = `Follow the instructions below along with the provided context:
  ## [lasso] Instructions
  ${matchedCommand.content}
 
  ## [lasso] Context
  ${commandContext}
    `;
```

Both template literals have several spaces of trailing whitespace baked in before the closing backtick purely as a byproduct of source indentation, not intentional formatting. It gets sent verbatim to the model as part of the prompt (and is locked in by matching test expectations, so it will persist unless someone notices). Minor, but it's exactly the kind of thing `.trim()` should clean up.

---

### 6. `warnOnLargePromptOverhead()` is never re-run after config changes that affect it

`src/index.ts` calls `warnOnLargePromptOverhead()` exactly once at startup. Neither `/reload` (`initStateRepeatable`) nor `/model` (`setModelCommand`) re-invoke it, even though both can change the effective context window or overhead (`/reload` can add/remove skills and MCP servers; `/model` switches to a model with a different `contextWindowPerModel` entry). A user who reloads into an over-budget configuration gets no warning until they hit the actual compaction ratio.

---

### 7. `checkBat()` (`bat --version`) is invoked repeatedly per turn instead of being cached

`src/terminal.ts` — `warnOnMissingBat()` at startup, then `executeBat()` calls it again on _every_ agent response, and `openWithPager()` calls it again _every time_ a pager opens without an explicit `PAGER`/`LASSO_PAGER*` env var. Each call spawns a subprocess. Purely a performance nit, not correctness, but easily cached for the life of the process.

---

### 8. `getUnicodeChar`'s `"—"` (em dash) mapping is dead code

`src/text.ts`:

```ts
const map = {
  ["┊"]: "|",
  ["…"]: "~",
  ["━"]: "=",
  ["—"]: "-",
};
```

Nothing in the codebase calls `getUnicodeChar("—")`; only `"┊"`, `"…"`, and `"━"` are actually used (in `toolPrint`, `truncate`, and `fencePrint`/`wrapInFence` respectively).
