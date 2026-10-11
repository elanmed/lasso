# Split `src/app.ts` into modules under 2,000 lines

## Goal

Reduce the 6,867-line `src/app.ts` into the fewest cohesive implementation modules possible, each at most 2,000 lines, to reduce Prettier and language-server work. Keep tests in `src/app.test.ts` for this phase; update its imports to the new module locations, but do not move or change test cases. Test relocation is a separate follow-up in `plans/02-move-tests.md`, followed by the audit in `plans/03-verify-test-moves.md`.

## Module-count target and boundaries

The current file size requires at least four implementation files by line count. Aim for exactly four total source files, including `app.ts`; add a fifth only if measurements show four cannot meet the line limit without breaking cohesion or the acyclic dependency graph. Do not create one module per feature just because it is possible. Rebalance complete declarations and their private helpers across these broad modules to stay below the limit:

- `core.ts`: shared schemas, domain types/defaults, state and actions, config/path primitives, prompt/context/skill formatting, and other low-level shared functionality.
- `agent.ts`: usage accounting, session persistence, model providers, MCP setup, and tool implementations.
- `terminal.ts`: terminal output, readline/input/editor handling, recording/transcription, and pager/display primitives.
- `app.ts`: application/runtime orchestration, config startup/reload, API/compaction flow, slash-command routing, and command handlers; it remains implementation, not a facade.

These are initial ownership guides, not rigid line ranges. Move whole functions and their private dependencies; rebalance ownership where actual imports require it. Keep each file comfortably below 2,000 lines after imports and formatting. If the four-module layout cannot satisfy both the line limit and acyclic imports, document the specific coupling and split only the affected module to create a fifth file.

## Import rules and cycle prevention

- Do not use barrel files or re-export imported declarations. No source file should contain `export { ... } from ...` or `export * from ...`.
- `app.ts` must contain application implementation only; it must not become a compatibility facade. Update `src/index.ts` and tests to import declarations directly from their owning modules.
- Enforce a one-way dependency graph: `core.ts` is the lowest layer; `agent.ts` and `terminal.ts` may import from `core.ts`; `app.ts` may compose the lower-level modules. `core.ts`, `agent.ts`, and `terminal.ts` must not import from `app.ts`.
- Where terminal input needs command behavior, or another lower-level feature needs orchestration, pass the behavior through a callback/dependency instead of importing upward. Move shared functionality down only when it does not create a reverse dependency.
- Before moving each declaration, check all its imports and consumers; after each extraction, inspect the import graph for cycles. Avoid temporary imports through `app.ts` as well as permanent ones.

## Implementation sequence

1. Inventory top-level declarations, private helpers, consumers, and imports; estimate the line count of the four proposed modules and identify cross-boundary cycles before editing.
2. Extract low-level shared declarations and state into `core.ts`; keep its dependencies limited to leaf modules such as `utils.ts` and `deps.ts`.
3. Extract persistence, usage, provider, MCP, and tool functionality into `agent.ts`; have it depend only on `core.ts` and leaf modules.
4. Extract terminal I/O and display functionality into `terminal.ts`; use injected callbacks for command/runtime behavior so it does not import `app.ts`.
5. Keep orchestration and command dispatch in `app.ts`, importing directly from lower-level modules. Update `src/index.ts` and imports in `src/app.test.ts` to point to owning modules. Do not move tests or alter test cases in this phase.
6. Rebalance whole declarations until every implementation module is below 2,000 lines. Create a fifth implementation module only if the four-module layout cannot meet the line limit and acyclic import rules.
7. Review all source imports and exports: no re-exported imports, no internal imports from a barrel, no cycles, and no lost public functionality.

## Verification

- Run `./agent-pnpm-run.sh ci` after extraction; this covers tests, lint, types, and formatting.
- Run `./agent-pnpm-run.sh cloc` and update README source/test line-count figures only if the rounded count crosses its current nearest-100 boundary.
- Check line counts for every implementation module and confirm all are below 2,000 lines.
- Confirm tests remain in `src/app.test.ts` in this phase, with imports updated only as needed, and that no source file re-exports imported declarations.
