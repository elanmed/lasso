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
