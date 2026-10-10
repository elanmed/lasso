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
