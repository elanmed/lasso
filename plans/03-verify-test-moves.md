# Verify tests were moved without being changed

## Prerequisite

Run this audit immediately after completing `plans/02-move-tests.md`, before making any later test edits. Its purpose is to prove that test relocation did not modify test behavior or test content.

## Required baseline

Before moving tests, preserve the exact pre-move `src/app.test.ts` within the allowed project directory as a temporary audit baseline, and record the source revision plus the original number of test cases. Keep the baseline out of the final change and delete it only after the audit passes. If the relocation has already happened without a baseline, recover the pre-move file from the recorded source revision or stop: do not claim byte-level verification without a trustworthy baseline.

## Validation procedure

1. Parse the baseline and all destination `*.test.ts` files using the repository's TypeScript compiler API. Enumerate test declarations (`describe`, `it`, and `test`) with their nested suite path, name, and source span.
2. Compare the baseline test declarations with the combined destination declarations. Require identical suite/case names, nesting, order within each moved suite, and total case count; require every baseline case to map to exactly one destination case.
3. Hash each test declaration's source text, including its callback body, and compare baseline hashes with destination hashes. Every test body must have an identical hash; no added, removed, or changed callbacks are allowed. Ignore only file-level import declarations when comparing complete files.
4. Check any test-level comments and setup declarations associated with moved suites against the baseline. They must be preserved verbatim with their suite; only imports needed to resolve destination modules may differ.
5. Inspect the complete diff. Allowed changes are relocation of unchanged test text, import-only adjustments, and deletion of the now-empty `src/app.test.ts`. Reject formatting changes, renames, expectation changes, reordered cases, or unrelated edits.
6. Run the test command and `./agent-pnpm-run.sh ci`; verify the test count matches the recorded pre-move count. Remove the temporary baseline and audit artifacts only after all checks pass.

## Pass condition

The moved suite and test declaration hashes match the baseline one-for-one, names and counts match, the only textual differences are the necessary imports and file placement, and all tests pass. Otherwise report the mismatch and stop without editing tests to make the audit pass.
