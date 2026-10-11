# Move tests into files matching the extracted app modules

## Prerequisite

Run this only after completing `plans/01-split-app.md`. This is a separate follow-up: the source-module extraction must be stable before relocating tests.

## Goal and constraints

Move the test suites currently in `src/app.test.ts` into themed `src/*.test.ts` files corresponding to the new implementation modules. Keep every test case and its behavior unchanged. Do not add, remove, rewrite, reformat, consolidate, or otherwise improve tests in this step. Import declarations may be adjusted only as needed for the new test-file boundaries and module ownership. Keep test helpers in `src/test-helpers.ts`; do not extract new helpers as part of this relocation.

## Destination grouping

Inventory top-level `describe` suites and move each complete suite, with its nested suites and cases, into the matching test file. Prefer these destinations, adjusting only when a suite spans tightly coupled source responsibilities:

- `app-model.test.ts`: config schemas, keys, prompts, and other shared-model behavior.
- `app-state.test.ts`: state and action behavior.
- `app-context.test.ts`: context files, skills, and prompt formatting.
- `app-usage.test.ts`: usage limits, token accounting, and usage formatting.
- `app-session.test.ts`: session persistence, listing, cleanup, and resume behavior.
- `app-tools.test.ts`: providers, MCP behavior, tool schemas/execution, and diffs.
- `app-ui.test.ts`: terminal printing, pagers, input, editor, and transcription behavior.
- `app-commands.test.ts`: slash commands and command/page handlers.
- `app-runtime.test.ts`: API calls, compaction, and startup/runtime behavior.

Do not split an individual test case or nested suite. If a top-level suite covers multiple modules, keep the suite together in one destination rather than duplicating or rewriting it. Remove `src/app.test.ts` only after all its test suites have been moved and the test runner discovers the destination files.

## Import and preservation rules

- Update imports only; keep test declarations, setup, assertions, literals, and expected values unchanged.
- Import tested production declarations from their owning modules where practical; keep shared test utilities imported from `./test-helpers.ts` and dependencies from `./deps.ts`.
- Update relative paths only when required by the destination location. Keep test files in `src/` so existing `./` paths remain valid.
- Preserve suite names, case names, order within each suite, and any test-level comments.
- Do not modify production code or `src/test-helpers.ts` in this plan.

## Sequence

1. Inventory all top-level suites in `src/app.test.ts`, including suite boundaries, test counts, and shared imports; map each suite to one destination.
2. Create destination test files and relocate whole suite text without edits to the suite bodies. Adjust only file-level imports required by the new grouping.
3. Confirm the glob `src/**/*.test.ts` discovers every destination and no tests remain stranded in `app.test.ts`; remove that file only when empty of tests.
4. Review the diff to ensure production files and test helpers are unchanged and test-body changes are limited to no changes at all.
5. Run `./agent-pnpm-run.sh ci` and confirm the full test count is unchanged from the pre-move baseline.

## Acceptance criteria

- All tests from `src/app.test.ts` are present exactly once across the destination files.
- Test bodies, suite/case names, assertions, and expectations are unchanged; only test-file placement and necessary imports differ.
- No test behavior is added, removed, or altered, and no tests are moved into helper modules.
- The configured test command discovers and passes all moved tests.
