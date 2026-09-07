# lasso

You are running in a container. Make all changes to `/lasso` at the root of the filesystem.

This is a Node.js project. Only Node.js APIs should be used. Use `node` for running and testing, and `pnpm` as the package manager.

## Architecture

For a high-level overview of the main loop, the `null` vs `""` return conventions, and the abort controllers, see `ARCHITECTURE.md`.

## Development

After every change, run linting, types, tests, and formatting with `./agent-pnpm-run`. The agent runner can hide output from commands that exit nonzero; this wrapper captures both output streams, prints the real exit status, and keeps the diagnostics visible:

```
./agent-pnpm-run lint
./agent-pnpm-run types
./agent-pnpm-run test
./agent-pnpm-run format
```

Or all at once:

```
./agent-pnpm-run ci
```

Use `./agent-pnpm-run <script> [args...]` instead of calling `pnpm run` directly.

## Guidelines

- Never add comments
- Minimize diffs — only change what's necessary
- All changes must have test coverage
- Prefer `assert.deepStrictEqual` over multiple individual field assertions — check the whole object in one call
- Never use `content: result.content` in deepStrictEqual assertions — it's a tautology. Inline the actual expected value
- Never use `assert.ok(result.includes(...))` — assert on the whole string with `assert.equal` or `assert.strictEqual`
- Only use `===` and `!==`; never use `==`, `!=`, or truthy/falsy coercions like `if (obj)` or `if (!obj)`. Use `!` only on boolean expressions
- For string assertions with newlines: use template literals when the string contains any newline that is not a single trailing one. If it's just a single trailing newline, use `"...\n"` instead
- For fs, import `fsDeps` directly from `deps.ts`. In tests, use `setupFakeDeps()` from `test-helpers.ts` to mock all fs methods, `processEnv`, and `processStdout` globally. Use `testFs._files` / `testFs._dirs` / `testFs._globResults` to set up fixture state. Import `testFs` and `setupFakeDeps` from `./test-helpers.ts`.
- `processEnv.get` and `processStdout.write` are also in `deps.ts` and mocked by `setupFakeDeps()`. Use `testProcessEnv._set(key, value)` for env vars. Override `processStdout.write` with an additional `mock.method(processStdout, "write", ...)` if you need to capture output.
- Pure utility functions do not need deps — import and call them directly in tests.

### fs mocking example

Production code:

```ts
import { fsDeps } from "./deps.ts";

export function readConfig() {
  if (fsDeps.existsSync("config.json") === false) return null;
  return JSON.parse(fsDeps.readFileSync("config.json").toString());
}
```

Test code:

```ts
import { testFs, setupFakeDeps } from "./test-helpers.ts";

describe("readConfig", () => {
  beforeEach(() => {
    setupFakeDeps();
  });

  it("returns config when file exists", () => {
    testFs._files.set("config.json", '{"key": "value"}');
    const result = readConfig();
    assert.deepStrictEqual(result, { key: "value" });
  });

  it("returns null when file does not exist", () => {
    const result = readConfig();
    assert.strictEqual(result, null);
  });
});
```

### mocking other built-ins

Use `mock.method` from `node:test` — pass the module and method name with a replacement function. Restore is automatic between tests.

```ts
import { mock } from "node:test";
import crypto from "node:crypto";

beforeEach(() => {
  mock.method(crypto, "randomUUID", () => "test-uuid");
});
```
