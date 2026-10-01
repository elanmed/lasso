# Plan: convert stdout tests to mockStdoutWrites

Convert every test file that still uses `mockStdout()` to `mockStdoutWrites()`.

**Do only one file at a time.** After each file: run `./agent-pnpm-run.sh ci`, fix any failures, and only then move to the next bullet. Never edit two files in one pass.

## Guide

- `mockStdout()` concatenates every write into one string and silently drops any write containing `\r` (unless `includeSpinnerFrames: true`), so cursor-movement sequences are invisible to assertions.
- `mockStdoutWrites()` returns `() => string[]` — the raw sequence of `process.stdout.write` calls, unfiltered. Assert on that array in one call:
  ```ts
  const getWrites = mockStdoutWrites();
  ...
  assert.deepStrictEqual(getWrites(), [
    `${BLUE}Starting a: ${RESET}\n`,
    `${UP_1}${CLEAR_LINE}${CR}`,
    `${GREEN}0.0ms${RESET}`,
    `${DOWN_1}${CR}`,
  ]);
  ```
- Rename the capture variable from `getCaptured` to `getWrites`, and `assert.equal`/`assert.strictEqual`/`assert.ok` on the whole string to a single `assert.deepStrictEqual(getWrites(), [...])`.
- One array element per terminal write. A `"\n"` ends an element; if the code writes text and newline together it is one element (`...\n`), if separately it is two.
- Import shared constants from `./test-helpers.ts` instead of literal escapes: `BLUE`, `GREEN`, `RED`, `RESET`, `UP_1`, `UP_2`, `DOWN_1`, `DOWN_2`, `CLEAR_LINE`, `CR`. Interpolating these constants in expectations is allowed (see AGENTS.md).
- For assertions that only check that nothing was printed, use `assert.deepStrictEqual(getWrites(), [])`.
- Drop `mockStdout` from the import once no longer referenced. `mockStdout({ includeSpinnerFrames: true })` call sites may stay as-is only if genuinely needed; prefer converting them too.
- Preserve existing expectations' values — this is a capture-mechanism change, not a behavior change. If a test fails, the old assertion was probably hiding writes (`\r`) that must now appear in the array.
- Remove `stripAnsi` from assertions you convert; raw writes with color codes are now asserted explicitly.

## Files

- [ ] `src/api.test.ts` (10 call sites)
- [ ] `src/config.test.ts` (7)
- [ ] `src/context.test.ts` (3)
- [ ] `src/differ.test.ts` (6)
- [ ] `src/fence.test.ts` (7)
- [ ] `src/input.test.ts` (5)
- [ ] `src/log.test.ts` (7)
- [ ] `src/print.test.ts` (18)
- [ ] `src/slash-commands.test.ts` (2)
- [ ] `src/terminal.test.ts` (11)
- [ ] `src/tools.test.ts` (13)
- [ ] `src/usage.test.ts` (4)

Done: `src/mcp.test.ts` (already converted).

After the last file: run `./agent-pnpm-run.sh cloc` and update README counts if they crossed a nearest-100 boundary.
