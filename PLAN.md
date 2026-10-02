# Plan: convert stdout tests to mockStdoutWrites

Convert every test file that still uses `mockStdout()` to `mockStdoutWrites()`.

**Do only one file at a time.** After each file: run `./agent-pnpm-run.sh ci`, fix any failures, and only then move to the next bullet. Never edit two files in one pass.

## Guide

- `mockStdoutWrites(opts)` takes the same opts as `mockStdout(opts)`: `{ includeSpinnerFrames?: boolean } = {}`. By default it drops any write containing `\r` (spinner frames, cursor-movement rewrites) because those are too noisy for ordinary assertions. It returns `() => string[]` — the sequence of kept `process.stdout.write` calls. Assert on that array in one call:
  ```ts
  const getWrites = mockStdoutWrites();
  ...
  assert.deepStrictEqual(getWrites(), [
    `${BLUE}Starting a: ${RESET}\n`,
    `${GREEN}0.0ms${RESET}`,
  ]);
  ```
- Only pass `mockStdoutWrites({ includeSpinnerFrames: true })` when the test actually asserts `\r`-bearing writes (spinner frames, cursor up/down rewrites such as `${UP_1}${CLEAR_LINE}${CR}`):
  ```ts
  const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });
  ```
- Rename the capture variable from `getCaptured` to `getWrites`, and `assert.equal`/`assert.strictEqual`/`assert.ok` on the whole string to a single `assert.deepStrictEqual(getWrites(), [...])`.
- One array element per terminal write. A `"\n"` ends an element; if the code writes text and newline together it is one element (`...\n`), if separately it is two.
- Import shared constants from `./test-helpers.ts` instead of literal escapes: `BLUE`, `GREEN`, `RED`, `RESET`, `UP_1`, `UP_2`, `DOWN_1`, `DOWN_2`, `CLEAR_LINE`, `CR`. Interpolating these constants in expectations is allowed (see AGENTS.md).
- For assertions that only check that nothing was printed, use `assert.deepStrictEqual(getWrites(), [])`. With the default filtering this means no non-`\r` writes; if the test must also prove there were no spinner/rewrite writes, use `mockStdoutWrites({ includeSpinnerFrames: true })` and assert `[]`.
- Drop `mockStdout` from the import once no longer referenced. `mockStdout({ includeSpinnerFrames: true })` call sites may stay as-is only if genuinely needed; prefer converting them too.
- Converted already: `src/api.test.ts`, `src/config.test.ts`, `src/context.test.ts`, `src/differ.test.ts`, `src/fence.test.ts`, `src/input.test.ts`, `src/log.test.ts`, `src/mcp.test.ts`, `src/print.test.ts`, and `src/slash-commands.test.ts` use `mockStdoutWrites({ includeSpinnerFrames: true })` where they assert rewrite sequences.
- Preserve existing expectations' values — this is a capture-mechanism change, not a behavior change. If a test fails, the old assertion was probably hiding writes (`\r`) that must now appear in the array.
- Remove `stripAnsi` from assertions you convert; raw writes with color codes are now asserted explicitly.
- `setupTestContext()` mocks `setInterval`/`clearInterval` by default, so the spinner interval never fires mid-test. Only call `mockSetInterval()` yourself when a test needs to read or tick the callbacks manually (the default mock returns no callbacks).

## Files

- [x] `src/api.test.ts` (10 call sites)
- [x] `src/config.test.ts` (7)
- [x] `src/context.test.ts` (3)
- [x] `src/differ.test.ts` (6)
- [x] `src/fence.test.ts` (7)
- [x] `src/input.test.ts` (5)
- [x] `src/log.test.ts` (7)
- [x] `src/print.test.ts` (18)
- [x] `src/slash-commands.test.ts` (2)
- [ ] `src/terminal.test.ts` (11)
- [ ] `src/tools.test.ts` (13)
- [ ] `src/usage.test.ts` (4)

Done: `src/mcp.test.ts` (already converted).

After the last file: run `./agent-pnpm-run.sh cloc` and update README counts if they crossed a nearest-100 boundary.
