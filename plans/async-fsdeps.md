# Plan: convert fsDeps from sync to async

Convert every sync function in `fsDeps` to its async counterpart, one function at a time.
For each converted function, make its consumers async — including consumers of consumers,
chasing the chain transitively until `./agent-pnpm-run ci` is clean.

## Decisions (settled)

- **Rename** every converted function to drop the `Sync` suffix (Node `fs/promises` style).
- **`existsSync` stays sync** and keeps its name. It is excluded from all steps.
- **`gitLsFiles` is converted too** (it wraps `execFileSync`), keeping its name — just async.
- **The debug-log chain is fire-and-forget**: `debugLog` becomes async, but
  `logStateChange` (and `log.ts`'s `debugLog` wrapper) call it with `void` and stay sync —
  `actions.*`, `print.*`, and their whole consumer cascade are untouched.
- **Order** (smallest direct blast radius first):
  1. `appendFileSync` → 2. `gitLsFiles` → 3. `statSync` → 4. `globSync` → 5. `readdirSync`
     → 6. `mkdirSync` → 7. `unlinkSync` → 8. `writeFileSync` → 9. `readFileSync`
- **No commits** unless explicitly told.

## Conventions

- `deps.ts`: import converted functions from `node:fs/promises`; `existsSync` stays imported
  from `node:fs`. `FsDeps = typeof fsDeps` picks up new signatures automatically.
- `globSync` → `glob`: `fs/promises.glob` returns an **AsyncGenerator**, not a promise of an
  array. Wrap it in `fsDeps.glob` so it stays `glob(pattern): Promise<string[]>` — collect
  with `for await`, then return the array.
- `gitLsFiles`: promisify `childProcess.execFile` (`node:util` `promisify`) inside
  `deps.ts`, same split-on-`\0`/filter behavior. Note: `promisify` only types the last
  Node overload, so the promisified `execFile` must be cast to a
  `(file, args, { encoding: "utf8" }) => Promise<{ stdout, stderr }>`-shaped
  `PromiseExecFile` type; `childProcess.execFile.__promisify__` does not exist at
  runtime (type-only artifact). Drop the `stdio` option — invalid for async `execFile`.
- Error handling: `tryCatch(() => fsDeps.X(...))` becomes
  `await tryCatchAsync(fsDeps.X(...))` — note `tryCatchAsync` takes a **Promise**, not a
  callback.
- Test fakes: update `FakeFsDeps` + `makeFakeFsDeps` in `test-helpers.ts` in the **same
  step** as the real function (async return types; renamed keys must match `fsDeps` keys
  since `setupFakeDeps` mocks by key). Test overrides passed to `makeFakeFsDeps` must return
  promises too.
- Chasing consumers per step:
  - Value-returning functions (`listSessionFiles`, `getTempFileName`, `readConfigFileStr`,
    `resumeFromSessionFile`, `getSkills`, `getContextEntries`, `getAvailableSlashCommands`):
    `./agent-pnpm-run types` finds every call site that uses the value.
  - Void-returning functions (`syncSessionFile`, `initLogs`, `clearCommand`,
    differ cleanups, `deleteLock`): `types` will NOT catch ignored promises —
    grep every caller and `await` them; make the enclosing function async; repeat until no
    sync callers remain. `./agent-pnpm-run lint` (`no-floating-promises` is an error in
    `src`) catches leftovers in source.
  - Tests: `no-floating-promises` is **off** in `*.test.ts`, so grep tests for calls to the
    newly-async function and add `await` manually. `await-thenable` is still an error and
    will catch over-eager awaits on functions that are still sync.
- Async call sites that sit in callbacks: prefer making the callback itself async and
  awaiting inside (event handlers, `setInterval` callbacks). `void promise` is for
  callbacks that must remain sync and for the deliberate fire-and-forget `debugLog` calls
  (`logStateChange`, `log.ts` wrapper) — `debugLog` swallows its own errors via
  `tryCatch`/`tryCatchAsync`, so a dropped promise cannot reject.
- After **every step**: run `./agent-pnpm-run ci` (lint, types, test, format, cloc). If a
  cloc count crosses its nearest-100 boundary, update the README figures.
- All changes need test coverage. Extract shared test setup into `test-helpers.ts` as the
  steps progress. Never add comments. Minimize diffs.

## Step 0: baseline

Run `./agent-pnpm-run ci` and confirm it is green before starting.

## Step 1: `appendFileSync` → `appendFile` - DONE

The smallest step: one consumer, and its callers fire-and-forget — no cascade.

- **Direct consumer:** `debug-log.ts` `debugLog(enabled, path, content)` → async
  (`tryCatch(() => fsDeps.appendFileSync(...))` →
  `await tryCatchAsync(fsDeps.appendFile(...))`).
- **Fire-and-forget callers** (stay sync, prefix with `void`):
  - `state.ts` `logStateChange` → `void debugLog(...)`. All `actions.*` members and their
    consumers (`print.ts`, `api.ts`, `input.ts`, `log.ts`, …) stay sync — no cascade.
  - `log.ts` `debugLog(content)` wrapper → `void writeDebugLog(...)`.
- **Hazards:** only tests that assert debug-log file contents:
  - `debug-log.test.ts` — make each `it` callback async and `await debugLog(...)`.
  - `state.test.ts` "reset-state writes debug-log entry" cannot await (the call is
    fire-and-forget); it still passes here because the fake `appendFile` mutates
    synchronously inside `debugLog` before its first `await`. Revisit at step 6, where an
    awaited `mkdir` defers the write.
- **Checkpoint:** `./agent-pnpm-run ci`.

## Step 2: `gitLsFiles` → async (name unchanged) — DONE

Additional dep.ts work landed alongside this step (async conversion of exec):

- `deps.ts` gained a `childProcessDeps` object (`execFile`, `exec`, `spawn`,
  `spawnSync`) next to `fsDeps`/`processDeps`; all `node:child_process` imports were
  removed from `src/*.ts` (terminal, differ, utils, input, tools) in favor of
  `childProcessDeps` from `./deps.ts`. `gitLsFiles` calls
  `childProcessDeps.execFile`.
- `exec` is a **bare** `promisify(childProcess.exec)` typed as `PromiseExec`
  (`Promise<PromiseExecResult> & { child: { stdin: { end: () => void } | null } }`).
  No `stdin.end()` in the wrapper — an earlier wrapper version closed stdin and shielded
  sync throws, but no consumer execs a stdin-reading command, so it was dropped per the
  "consumer does it themselves" principle. Promisified exec already defaults `encoding`
  to utf8, so call sites need no encoding options.
- The one stdin-reading-risk consumer opts in itself: `tools.ts` `executeBashTool`
  does `bashPromise.child.stdin?.end()` before awaiting, so bare `cat`-style bash-tool
  commands resolve instead of hanging.
- `differ.ts` execGitDiff error handling uses `tryCatchAsync(exec(...))`: code 1 with
  delta, or codes ∉ [2, 127, 128] and ≤128 without delta → resolve; code-undefined or
  fatal codes → throw. Because errors are rejections, `mockExecCalls` queue exhaustion
  rejects ("Unexpected exec call") to preserve reload-abort semantics.
- Old `execPromise` (and its `cat` stdin test) deleted from `utils.ts`/`utils.test.ts`
  (test count 863).
- **deps.ts:** `execFile` promisified as above; same output
  contract (`string[]` split on `\0`, filtered).
- **Direct consumer:** `context.ts` `getSkills()` → async.
- **Transitive:** `getSkills` callers — `config.ts` `initStateFromFs` (already async) →
  `initStateRepeatable`/`initState` (already async) → `index.ts` (already async). Verify no
  other callers with grep.
- **Tests:** `context.test.ts`, `config.test.ts` (await `getSkills` results/callers).
- **Checkpoint:** `./agent-pnpm-run ci`.

## Step 3: `statSync` → `stat` - DONE

- **Direct consumers:**
  - `input.ts` `spawnAndReadEditorContent` — already async; just await.
  - `utils.ts` `listSessionFiles()` → async.
- **Transitive from `listSessionFiles`:**
  - `log.ts` `deleteExpiredSessionFiles` → async → `initLogs` → async → `index.ts` (await).
  - `input.ts` `resumeWithNoArgs` and `resume` → async → consumed inside
    `resolveBuiltinSlashCommand` (already async).
- **Tests:** `utils.test.ts`, `log.test.ts`, `input.test.ts` — await the above.
- **Checkpoint:** `./agent-pnpm-run ci`.

## Step 4: `globSync` → `glob` - DONE

- **deps.ts:** async-generator wrapper (see Conventions) so the signature is
  `Promise<string[]>`.
- **Direct consumers:**
  - `context.ts` `getSkills` — already async from step 2; add `await`.
  - `slash-commands.ts` `getAvailableSlashCommands` → async.
- **Transitive:** `getAvailableSlashCommands` → `config.ts` `initStateFromFs` (already
  async). (`getAvailableCommandsStr`/`getCustomSlashCommandsStr` read state only — no fs.)
- **Tests:** `context.test.ts`, `slash-commands.test.ts`, `config.test.ts`.
- **Checkpoint:** `./agent-pnpm-run ci`.

## Step 5: `readdirSync` → `readdir` - DONE

- **Direct consumer:** `utils.ts` `listSessionFiles` — already async from step 3; add
  `await`. No new cascade.
- **Tests:** `utils.test.ts`.
- **Checkpoint:** `./agent-pnpm-run ci`.

## Step 6: `mkdirSync` → `mkdir`

- **Direct consumers:**
  - `debug-log.ts` — already async from step 1.
  - `input.ts` `initLocalConfig`, `initGlobalConfig` → async.
  - `log.ts` `syncSessionFile`, `initSessionFile` → async.
  - `usage.ts` `syncNewModelUsageForLimitWindow` — already async.
- **Transitive:**
  - `initLocalConfig`/`initGlobalConfig` → consumed in `resolveBuiltinSlashCommand`
    (already async).
  - `syncSessionFile` → `api.ts` (already async) and `input.ts` call sites including
    `clearCommand` → `clearCommand` → async → `resolveBuiltinSlashCommand` (async).
  - `initSessionFile` → `initLogs` (already async from step 3) → `index.ts`.
  - `syncSessionFile` is void-returning: grep **all** call sites in `api.ts`, `input.ts`,
    and tests.
- **Hazards:** `debugLog` now `await`s `mkdir` before appending, so the fire-and-forget
  write in `state.test.ts` "reset-state writes debug-log entry" lands only after a
  microtask — either `testFs._dirs.add("/fake-home/.config/lasso/debug")` in that test so
  the `mkdir` branch is skipped, or flush (`await new Promise(setImmediate)`) before
  asserting.
- **Tests:** `input.test.ts`, `log.test.ts`, `usage.test.ts`, `debug-log.test.ts`,
  `state.test.ts`, plus tests calling `syncSessionFile`/`clearCommand`.
- **Checkpoint:** `./agent-pnpm-run ci`.

## Step 7: `unlinkSync` → `unlink`

- **Direct consumers:**
  - `differ.ts` `cleanupTempFileBefore`, `cleanupAllTempFileBefore` → async
    (`diffAndCleanup` already async).
  - `input.ts` `spawnAndReadEditorContent` (async), `reload` (already async).
  - `log.ts` `deleteExpiredSessionFiles` (already async from step 3).
  - `utils.ts` `createLockUtils`: `deleteLock` → async (`createLock` already async).
- **Transitive:**
  - differ cleanups → `api.ts` (async) and `tools.ts` (the `setTempFileBefore` /
    `cleanupTempFileBefore` / `cleanupAllTempFileBefore` sites around lines 467–514 —
    inspect each context, make callbacks async as needed).
  - `deleteLock` → `usage.ts` call sites (already async functions) — add `await`.
- **Tests:** `differ.test.ts`, `input.test.ts`, `log.test.ts`, `utils.test.ts`,
  `usage.test.ts`, `tools.test.ts`.
- **Checkpoint:** `./agent-pnpm-run ci`.

## Step 8: `writeFileSync` → `writeFile`

- **Direct consumers:**
  - `input.ts` (`spawnAndReadEditorContent`, `initLocalConfig`, `initGlobalConfig`) — all
    already async.
  - `log.ts` `syncSessionFile`, `initSessionFile` — already async.
  - `usage.ts` `syncInitialModelUsageForLimitWindow`,
    `syncNewModelUsageForLimitWindow` — already async.
  - `utils.ts` `getTempFileName` → async; `createLockUtils` `writeLockFile`/`overwriteLock`/
    `writeLock` → async (inside already-async `createLock`).
- **Transitive from `getTempFileName`** (the main new cascade):
  - `terminal.ts` `openWithPager` → async → all the `page*`/viewer functions in `input.ts`
    (`pageEditStr`, `pageCommands`, `pageSkills`, `pageAvailableContextFiles`,
    `pageHistory`, `pageLastResponse`, `pageLastMessage`, `pageSummaries`, `pageLastDiff`,
    `printUsage`, …) → their callers (`resolveBuiltinSlashCommand`, keypress/editor
    handlers) → chase to clean.
  - `differ.ts` `setTempFileBefore` → async → `api.ts`, `tools.ts` sites.
  - `input.ts` `spawnAndReadEditorContent`, `reload` — already async.
- **Tests:** `utils.test.ts`, `terminal.test.ts`, `differ.test.ts`, `input.test.ts`,
  `log.test.ts`, `usage.test.ts`, `tools.test.ts`, `api.test.ts`.
- **Checkpoint:** `./agent-pnpm-run ci`.

## Step 9: `readFileSync` → `readFile`

- **Direct consumers:**
  - `config.ts` `readConfigFileStr` → async → `initStateFirst` → async →
    `initStateRepeatable`/`initState` (already async).
  - `context.ts` `getContextEntries` → async, `getSkillJSON` → async (`getSkills` already
    async), plus the read inside `getSkills`.
  - `input.ts` `spawnAndReadEditorContent` (async).
  - `log.ts` `resumeFromSessionFile` → async → `resumeWithNoArgs`/`resume` (already async
    from step 3).
  - `slash-commands.ts` `getAvailableSlashCommands` (already async from step 4).
  - `usage.ts` (already async), `utils.ts` `getTempFileName`/`writeLock` (already async
    from steps 7–8).
- **Transitive:** `getContextEntries` → `config.ts` `initStateFromFs` (async);
  `readConfigFileStr` used elsewhere only in `config.ts` (verify by grep).
- **Tests:** `config.test.ts`, `context.test.ts`, `input.test.ts`, `log.test.ts`,
  `slash-commands.test.ts`, `usage.test.ts`, `utils.test.ts`.
- **Checkpoint:** `./agent-pnpm-run ci`.

## Final verification

1. `grep -rn "fsDeps\..*Sync(" src` — the only hit allowed is `existsSync`.
2. `grep -rn "Sync" src/deps.ts` — only `existsSync` (import + key).
3. Run `./agent-pnpm-run ci`; update README line counts if cloc crossed a boundary.
4. Do not commit unless told.
