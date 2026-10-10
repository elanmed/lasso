# Lasso Bug Hunt Report

Scope: `src/` of lasso v0.11.3 (Node >= 22, `ai` ^7, Linux and macOS only). Test files were read as supporting evidence, not as the spec. Locations use file and function names because line numbers were not available.

Overall, the codebase is in good shape, with consistent error handling and thorough tests. The bugs below are mostly at the seams between modules.

## Confirmed bugs

### 3. Diff output is discarded when `git diff` exits 1

- Location: `differ.ts`, end of `execGitDiff`
- Severity: medium
- What is wrong: `git diff --no-index` exits 1 when files differ. The promisified `exec` rejects, and the diff is on `error.stdout`. The code treats that exit code as non-fatal but returns empty strings. Without `delta`, no diff is ever printed or recorded for `/lastdiff`. The test mocks never put `stdout` on the error, so they do not catch it. It is unconfirmed whether `delta` ever exits 1.
- How to trigger: Uninstall `delta`, have the model edit a file, and observe no "File change" block.
- Suggested fix:

```diff
-  return result.ok ? result.value : { stdout: "", stderr: "" };
+  if (result.ok) return result.value;
+  const { stdout = "", stderr = "" } = result.error as {
+    stdout?: string;
+    stderr?: string;
+  };
+  return { stdout, stderr };
```

### 5. Compaction crashes the process when the context window is under 40,000 tokens

- Location: `api.ts`, `getMergedSummaries`
- Severity: medium
- What is wrong: `getMaxNumberSummaries` is `floor(0.25 * window / 5000)`, which is 1 for a 32k window and 0 under 20k. Once `summaries.length >= max`, the pair-search loop never runs, `summaries[-1]` is `undefined`, and `assertAtBuildtime` throws. The error is not caught in `maybeCompact`, so `main` exits.
- How to trigger: Set `contextWindowPerModel` to 32000 and chat until the second compaction.
- Suggested fix:

```diff
-  if (summaries.length < maxNumberSummaries) {
+  const minimumSummariesToMerge = 2;
+  if (summaries.length < Math.max(maxNumberSummaries, minimumSummariesToMerge)) {
```

### 6. `/resume` with no args can pick an empty session and give up

- Location: `log.ts` `initSessionFile`, `input.ts` `resumeWithNoArgs`
- Severity: medium
- What is wrong: Startup writes a zero-byte session file. Open lasso, quit without typing, and that file becomes the newest. The next `/resume` takes `sortedSessionFiles[0]`, fails to parse it, and returns null without trying older sessions.
- How to trigger: Start lasso, press Ctrl-C twice and confirm exit, start again, run `/resume`.
- Suggested fix: Stop creating the file until the first sync.

```diff
-  const writeResult = await tryCatchAsync(
-    fsDeps.writeFile(sessionFilePath, ""),
-  );
-  if (!writeResult.ok) {
-    print.error(`Failed to write the session file to ${sessionFilePath}`);
-  }
```

Existing empty files can be removed with this command:

```
find ~/.local/state/lasso/sessions -size 0 -delete
```

### 7. Subagent usage is recorded under the wrong model

- Location: `usage.ts` `appendModelUsage` and `state.ts` `appendToModelUsageForSession`
- Severity: medium
- What is wrong: `appendModelUsage(usage, model)` passes `model` to the limit-window log, but the session log uses `state.config.model`. Subagent tokens on another model are priced with the main model's rates in `/usage` and the fence line. `isUsageLimitDisabled()` also checks pricing for the current model, not the `model` argument.
- How to trigger: Set `subagentModels` to a model with different pricing, run a subagent, then `/usage`.
- Suggested fix:

```diff
-  appendToModelUsageForSession(usage: ModelUsage) {
-    const model = state.config.model;
+  appendToModelUsageForSession(usage: ModelUsage, model = state.config.model) {
```

```diff
-  actions.appendToModelUsageForSession(defaultedUsage);
+  actions.appendToModelUsageForSession(defaultedUsage, model);
```

### 8. Pager temp files are never deleted

- Location: `terminal.ts`, `openWithPager`
- Severity: low
- What is wrong: Every `/history`, `/lastresponse` and `/config` leaves a file in the temp dir containing conversation text, readable with default umask. The pager tests currently read the file after the call and will need updating.
- How to trigger: Run `/history` and list `/tmp/lasso-*`.
- Suggested fix:

```diff
-import { childProcessDeps, processDeps } from "./deps.ts";
+import { childProcessDeps, fsDeps, processDeps } from "./deps.ts";
```

```diff
   childProcessDeps.spawnSync(pagerCommand, {
     shell: true,
     stdio: "inherit",
   });
+  await tryCatchAsync(fsDeps.unlink(tempFile));
```

### 9. An empty or comment-only settings file is a fatal config error

- Location: `config.ts`, `parseConfigFileStr`
- Severity: low
- What is wrong: `YAML.parse("")` returns `null`, which `z.strictObject` rejects, and the resulting error blocks all input.
- How to trigger: `touch .lasso/settings.yaml`, start lasso, send a message.
- Suggested fix:

```diff
-  const configResult = ConfigSchema.safeParse(parseResult.value);
+  const configResult = ConfigSchema.safeParse(parseResult.value ?? {});
```

### 10. Failed diff leaks both temp files

- Location: `differ.ts`, `diffAndCleanup`
- Severity: low
- What is wrong: When `execGitDiff` fails, the function prints and returns without unlinking the after file or the before file.
- How to trigger: Make `git diff` exit with code 128, for example with a corrupt git install.
- Suggested fix:

```diff
       print.error(
         `An error occurred when getting the diff for ${path}: ${getMessageFromError(diffResult.error)}`,
       );
+      await tryCatchAsync(fsDeps.unlink(tempFileAfterPath));
+      await cleanupTempFileBefore(toolCallId);
       return;
```

### 11. Missing or broken `sox` goes unnoticed until transcription fails

- Location: `input.ts`, `recordAndTranscribeInput`
- Severity: low
- What is wrong: `await recordingPromise` discards its result. If `spawn` fails, `once` rejects on the `error` event and that result is dropped. The temp wav was already created empty, so the empty file goes to the transcription API and the user gets a confusing API error.
- How to trigger: Run `/record` with `sox` not installed.
- Suggested fix:

```diff
-  await recordingPromise;
+  const recordingResult = await recordingPromise;
   actions.setRecordProcessAbortController(null);
+  if (!recordingResult.ok) {
+    print.error(
+      `Recording failed: ${getMessageFromError(recordingResult.error)}`,
+      { whileMuted: !isTyped },
+    );
+    await cleanup();
+    return null;
+  }
```

### 13. Startup timing display can corrupt

- Location: `config.ts` `initState`, `context.ts` `getSkillJSON`, `mcp.ts` `getMcpClients`
- Severity: low
- What is wrong: The parallel logger moves the cursor up by a fixed row count. `getSkillJSON` calls `print.error` mid-startup, and MCP failure messages print after the MCP promises settle, which can be before the skills or commands rows finish. Either adds a row and later `end()` calls overwrite the wrong line.
- How to trigger: Add a malformed `SKILL.md` and start with timings enabled.
- Suggested fix: Route those messages through `actions.appendConfigWarningMessage`, for example:

```diff
-    print.error(`Failed to read the skill at ${skillMdPath}`);
+    actions.appendConfigWarningMessage(
+      `Failed to read the skill at \`${skillMdPath}\`, ignoring.`,
+    );
```

## Needs verification

1. Cost tracking likely uses last-step usage only. `appendModelUsage(usage)` reads `usage` from `generateText`. In recent `ai` versions this is believed to be the last step, with `totalUsage` summing all steps. In a tool loop that would undercount spend by roughly the step count. Check by logging `totalUsage` next to `usage` on a multi-tool turn.
2. Bash tool timeout may look like a user interrupt. Node's `exec` rejects with `AbortError` for any abort reason, so `executeBashTool` rethrows it when the 2-minute `bashMs` timeout fires. If the SDK propagates it, `resolveApiCall` records "[Interrupted...]". Check by having the model run `sleep 200`.
3. MCP stdio `stderr: "pipe"` is never read. A chatty server could fill the 64KB pipe and block. Check by running a server that logs heavily to stderr. Switching to `"ignore"` is the likely fix.
4. Local `.lasso/settings.yaml` is trusted automatically. A cloned repo can define a stdio MCP command that runs at startup, or set `baseURL` so `LASSO_API_KEY` is sent elsewhere. Confirm whether that is intended.
5. Base64 image data in tool results. `getApproxTokensFromMessages` only filters top-level `image` and `file` parts, but `read_image` results are nested in `tool-result` output. If the SDK stores that shape, approximate counts balloon when the token cache is dirty, and compaction JSON-stringifies the base64 into the summary prompt. Check by reading an image, then `/resume` and `/tokens`.
6. Test and code drift. The `/reload` tests in `input.test.ts` expect `- Warning: using a default context window...` before "Reading context files". Current code emits "A default context window..." from `warnOnMissingConfig` at the end. Run `pnpm test` to see.
7. Lock stealing race. `overwriteLockFile` unlinks without re-checking the content, so two processes that both see a dead PID can each delete the other's fresh lock. Low likelihood.
8. MCP tool name collisions. `{...harnessTools, ...mcp.tools}` lets an MCP tool named `bash` replace the built-in, and same-named tools across servers overwrite silently.
9. `happy-dom` `Window` in `executeWebFetchHtmlTool` is never closed. Check memory growth after many fetches.
10. `wrapToOpenNonBlockingProcess` has no `try/finally`. Any throw inside the callback leaves `isNonBlockingProcessOngoing` true and stdin paused, which hangs the loop. No concrete trigger found today.

## Modules that look sound

`state.ts`, `paths.ts`, `model.ts`, `fence.ts`, `text.ts`, `prompts.ts`, `usage-format.ts`, `slash-commands.ts`, `log.ts` (aside from item 6) and `deps.ts`.

## Open questions

1. Should the sample config in item 1 be treated as an accepted gap, or is there a preferred `sdkProvider` default?
2. Does `totalUsage` differ from `usage` on a multi-tool turn (verification item 1)? That one affects real money.
