# Plan: group flat tests into nested describe blocks

The test files are too flat: long runs of `it` blocks sit directly inside the file-level `describe` (or inside one big mid-level `describe`), which makes them hard to read. Add `describe` blocks to group related tests.

This is a pure reorganization: **no `it` title or body may change**, and no new `beforeEach`/`afterEach`.

**Do only one file at a time.** After each file: run `./agent-pnpm-run.sh prettier-format` (fixes indentation) then `./agent-pnpm-run.sh ci`, and only then move to the next bullet. Never edit two files in one pass.

## Rules

- Only add `describe(...)` blocks and move whole `it(...)` blocks into them. Touch nothing inside an `it` — not the title, not the body, not its assertions or comments.
- Do not add `beforeEach`/`afterEach` unless a test genuinely cannot work otherwise (it should be able to). Existing hooks must keep running for exactly the tests they run for today: a test may only move _deeper_ inside the `describe` that owns its hooks (or stay under the same ancestors), never up to the file level or sideways out of a hooked `describe`.
- Keep the file-level `describe` name as-is. Keep describes that already group well; only split the flat runs inside them.
- Group by subject or scenario, taking the cue from the `it` titles: one group per function under test (`resolveApiCall`), per behavior (`resets state`, `prints warnings`), or per scenario (`when the global config exists`).
- Target roughly 4–8 `it` blocks per `describe`. Never create a `describe` holding a single `it` — leave that test where it is.
- Prefer two levels (file → subject → its); add a third level only for real scenarios (`describe("when local config exists")` → `describe("when the model is unknown")`).
- Keep the relative order of tests inside a group; when regrouping, move blocks without reordering them.
- Match existing naming style: bare function names for function tests, `when ...` for scenario branches (see `describe("resolveApiCall")`, `describe("when local config exists")`).
- `describe` is already imported everywhere it is needed; this should not change any import.
- The test count must not change (currently 846) — only the nesting in the reporter output.

## Files

Ordered smallest / flattest first. Counts are `total its` and the biggest flat runs needing groups.

- [x] `src/prompts.test.ts` (5 its, 0 describes — group by prompt: base agent, subagents, summaries)
- [x] `src/paths.test.ts` (6, 0 — group by directory: config, state, data, local)
- [x] `src/debug-log.test.ts` (6, 0 — group: disabled/skipped, writes)
- [ ] `src/mcp.test.ts` (10, 0 — group: init, failures, startup printing)
- [x] `src/config-types.test.ts` (7 — root `it` + `isSameKey` (6))
- [x] `src/slash-commands.test.ts` (10 across 2 root describes — `getAvailableSlashCommands` has 9 flat)
- [x] `src/state.test.ts` (68; 30 flat at root, `append-stdout-tail` (20), `SessionFileSchema` (7))
- [x] `src/usage.test.ts` (52; 18 flat at root, `syncNewModelUsageForLimitWindow` (11))
- [ ] `src/fence.test.ts` (14 — `fencePrint` (7), `getPrettyApiDuration` (7))
- [ ] `src/text.test.ts` (10 — `truncate` (7))
- [ ] `src/log.test.ts` (19)
- [ ] `src/print.test.ts` (24)
- [ ] `src/terminal.test.ts` (22 — `openWithPager` (10), `executeBat` (7))
- [ ] `src/differ.test.ts` (24 — `createToolCallDiffer` (12), `execGitDiff` (10))
- [ ] `src/usage-format.test.ts` (32 — `getPrettyTokenUsage` (13), `getPrettyContextWindowUsage` (8))
- [ ] `src/tools.test.ts` (47 — `toolPrint` (12), `createSubagentTool` (8))
- [ ] `src/context.test.ts` (47 — `getSkillsStr` (13), `parseFrontMatter` (10), `getSkills` (7))
- [ ] `src/api.test.ts` (54 — `resolveApiCall` (21), `maybeCompact` (16), `getMergedSummaries` (9), `getConversationSummary` (8))
- [ ] `src/utils.test.ts` (80 — `createLockUtils` (10), `getTempFileName` (8), `normalizeNewline` (6))
- [ ] `src/config.test.ts` (96 — `when local config exists` (47) including `when the global config ...` (20/19))
- [ ] `src/input.test.ts` (196 — `resolveSlashCommand` (35), `initKeypress` (22), `spawnAndReadEditorContent` (17), `resolveUserInput` (14), `shouldResolveSlashCommand` (13), `parseInputFromEditor` (11), `initSigInt` (8), `resume` (8))

After the last file: run `./agent-pnpm-run.sh cloc` and update README counts if they crossed a nearest-100 boundary.
