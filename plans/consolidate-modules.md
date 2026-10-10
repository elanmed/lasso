# Consolidating source modules

## Question

Can the ~26 non-test source files in `src/` be merged into five files: `index.ts`, `app.ts`, `deps.ts`, `utils.ts`, and `input.ts`?

**Verdict: feasible.** Only one cycle cluster exists, and everything in it can live in one file. Every other module can be placed so that no file imports a file that imports it back.

## Current state

### Why the file count is high

`eslint.config.mjs` enables `import/no-cycle` as an error. Any file-level cycle fails `pnpm run lint`, so the codebase was split to keep the import graph acyclic. Cycles _inside_ one file are not reported, so merging a cyclic cluster into a single file removes the problem.

### Strongly connected components

I computed SCCs over the non-test `src/*.ts` import graph:

| Size | Modules                                                                      |
| ---- | ---------------------------------------------------------------------------- |
| 6    | `context.ts`, `debug-log.ts`, `print.ts`, `state.ts`, `usage.ts`, `utils.ts` |
| 1    | each of the other 20 modules on its own                                      |

The only cycle cluster is the six-module core. Everything else is already layered.

Line counts (source, excluding tests), from `wc -l`:

| Module              | Lines |
| ------------------- | ----: |
| `input.ts`          |  1990 |
| `state.ts`          |   904 |
| `tools.ts`          |   703 |
| `api.ts`            |   445 |
| `utils.ts`          |   418 |
| `config.ts`         |   407 |
| `usage.ts`          |   319 |
| `config-types.ts`   |   229 |
| `print.ts`          |   215 |
| `context.ts`        |   206 |
| `prompts.ts`        |   171 |
| `differ.ts`         |   171 |
| `log.ts`            |   131 |
| `terminal.ts`       |   121 |
| `deps.ts`           |   115 |
| `usage-format.ts`   |   108 |
| `mcp.ts`            |   105 |
| `slash-commands.ts` |   102 |
| `model.ts`          |    96 |
| `fence.ts`          |    80 |
| `index.ts`          |    76 |
| `paths.ts`          |    69 |
| `text.ts`           |    36 |
| `debug-log.ts`      |    25 |
| `assert.ts`         |     9 |
| `missing.ts`        |     6 |

Total source is about 7,250 lines, which matches the README's "~7,000 lines".

## Proposed layout

Only `api.ts` and `input.ts` sit above the rest. `api.ts` imports `input.ts`, and nothing else imports either of them. The `index.ts` entry point imports `api.ts` and `input.ts`, plus several modules that move into `utils.ts`.

```text
index.ts     entry point (stays)
├─ app.ts    api, renamed from api.ts
│  └─ input.ts   input (stays, imports only utils.ts and deps.ts)
├─ utils.ts  everything else: assert, missing, config-types, prompts, paths,
│            state, print, context, usage, debug-log, utils, text, fence,
│            usage-format, differ, model, log, mcp, terminal,
│            slash-commands, tools, config
└─ deps.ts   leaf, no src imports (stays separate, see below)
```

| File       | Contents                                                                                                                                                                                                                               | Approx. lines |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------: |
| `index.ts` | entry point, imports `app.ts`, `input.ts`, `utils.ts`, `deps.ts`                                                                                                                                                                       |            76 |
| `app.ts`   | `api` (renamed from `api.ts`)                                                                                                                                                                                                          |           445 |
| `input.ts` | `input` (unchanged file, imports repointed)                                                                                                                                                                                            |          1990 |
| `utils.ts` | `assert`, `missing`, `config-types`, `prompts`, `paths`, `state`, `print`, `context`, `usage`, `debug-log`, `utils`, `text`, `fence`, `usage-format`, `differ`, `model`, `log`, `mcp`, `terminal`, `slash-commands`, `tools`, `config` |        ~4,600 |
| `deps.ts`  | unchanged, leaf                                                                                                                                                                                                                        |           115 |

### Why this split is acyclic

I checked the import list of every module by hand:

- No module in `utils.ts` imports `api`, `input`, or `index`. Inside `utils.ts`, the six-module cycle and the other modules are one file, so the cycles are allowed.
- `input.ts` imports `assert`, `config`, `config-types`, `context`, `deps`, `differ`, `fence`, `log`, `model`, `paths`, `print`, `slash-commands`, `state`, `terminal`, `text`, `tools`, `usage`, `usage-format`, and `utils`. All of these are in `utils.ts` or `deps.ts`, so `input.ts` imports only those two files.
- `api.ts` imports `input` and several modules that are all in `utils.ts`. Nothing imports `api`, except `index.ts`.
- `index.ts` is the top of the graph. Nothing imports it.

`config.ts` moves into `utils.ts`. It imports `config-types`, `context`, `deps`, `log`, `mcp`, `missing`, `paths`, `print`, `slash-commands`, `state`, `tools`, `usage`, and `utils`, all of which are in the same file or in `deps.ts`.

### Why `deps.ts` stays separate

`setupFakeDeps()` and the `fsDeps`/`processEnv`/`processStdout` mocks depend on importing `deps.ts` by path. Keeping it as its own leaf file preserves the test-mocking model in `AGENTS.md` unchanged. Moving it into `utils.ts` would change the mocked path for every test that uses it.

### Naming

`utils.ts` will be the large core file, not a grab-bag of generic helpers. Its name follows the request, not the contents. If that is a concern, the file could be renamed to something like `core.ts` later. This change is independent of the layout.

## Risks and things to check

1. **Module-level initialization order.** Merged files can run top-level `const` initializers in a different order, which can cause TDZ errors when one initializer reads another. This risk is larger now, because about 20 modules share one file. Check each merged module for top-level side effects or constants that use other modules' values.
2. **Name collisions.** About 20 modules become one file. Helpers with the same name (for example a private `escape` or `format` function) will conflict. Rename or make them private before merging.
3. **Exports and mocks in tests.** Tests that `mock.method` on an exported function from a module that moves will need updated import paths. Check every `*.test.ts` that imports a moved module.
4. **Diff size and history.** This is a large diff that moves a lot of code. `git log --follow` will not track most of it. Do it as a separate commit series, one batch at a time, so each commit still passes `./agent-pnpm-run.sh ci`.
5. **File size.** `utils.ts` will be about 4,600 lines, and `input.ts` stays about 1,990. Editing a 4,600-line file with `sed`-based edits works, but review and search are harder than with the current split.
6. **Test files.** `src/*.test.ts` has 22 files. Decided: keep test files separate for now. Their imports are repointed to the merged modules, and the test files keep their current names. Consolidating tests would make `input.test.ts` (4,821 lines) even larger. It also conflicts with the `AGENTS.md` rule that tests move with their functions, so that rule is deferred until test consolidation is decided.
7. **Build and tooling.** `scripts/compile.sh` builds from `src/index.ts`, so bundling should not change. Check it after the move.
8. **Docs.** After the move, update the README line counts (`./agent-pnpm-run.sh cloc`). Check whether any docs mention specific file names.
9. **`import/order` lint.** Re-run lint after each batch. The order rule may flag imports that move within a merged file.

## Suggested steps

1. Pick the final name for `utils.ts` (the current name, or something else such as `core.ts`).
2. Move the leaves (`assert`, `missing`, `config-types`, `prompts`, `paths`) into `utils.ts`, then run `ci`.
3. Move the six-module cycle (`state`, `print`, `context`, `usage`, `debug-log`, `utils`) and `text` into `utils.ts`, then run `ci`.
4. Move `fence`, `usage-format`, `differ`, `model`, `log`, `mcp`, `terminal`, `slash-commands`, `tools`, and `config` into `utils.ts`, running `ci` after each group.
5. Rename `api.ts` to `app.ts`, and repoint `index.ts` and `input.ts` to the new files. Check that `test-helpers.ts` still compiles and that the bundle still builds.
6. Repoint test imports to the merged modules. Do not move test files. Run `ci` to confirm the tests still pass.
7. Run `./agent-pnpm-run.sh cloc` and update the README counts if needed.

## Out of scope

- Changing behavior or public APIs.
- Consolidating or moving test files (see risk 6).
- Changing `deps.ts` or the test mocking model.
