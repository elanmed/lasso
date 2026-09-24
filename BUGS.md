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

### 6. `warnOnLargePromptOverhead()` is never re-run after config changes that affect it

`src/index.ts` calls `warnOnLargePromptOverhead()` exactly once at startup. Neither `/reload` (`initStateRepeatable`) nor `/model` (`setModelCommand`) re-invoke it, even though both can change the effective context window or overhead (`/reload` can add/remove skills and MCP servers; `/model` switches to a model with a different `contextWindowPerModel` entry). A user who reloads into an over-budget configuration gets no warning until they hit the actual compaction ratio.

---

### 7. `checkBat()` (`bat --version`) is invoked repeatedly per turn instead of being cached

`src/terminal.ts` — `warnOnMissingBat()` at startup, then `executeBat()` calls it again on _every_ agent response, and `openWithPager()` calls it again _every time_ a pager opens without an explicit `PAGER`/`LASSO_PAGER*` env var. Each call spawns a subprocess. Purely a performance nit, not correctness, but easily cached for the life of the process.
