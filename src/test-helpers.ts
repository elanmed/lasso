import os from "node:os";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import { mock } from "node:test";
import { aiDeps, fsDeps, processDeps } from "./deps.ts";
import { promptDeps, actions } from "./state.ts";
import { initKeypress } from "./input.ts";
import type { Key, SdkProvider } from "./config-types.ts";
import readline from "node:readline/promises";
import { stdin } from "node:process";
import { baseBatFlags, markdownBatFlags } from "./terminal.ts";
import { z } from "zod/v4";
import type { ToolSet } from "ai";

export function makeMcpTool() {
  return {
    inputSchema: z.object({}),
    execute: () => ({ content: [] }),
  };
}

export interface FakeFsDeps {
  _files: Map<string, string>;
  _dirs: Set<string>;
  _globResults: Map<string, string[]>;
  _gitLsFilesResults: Map<string, string[]>;
  _restore: () => void;
  readFileSync: (path: string) => Buffer;
  writeFileSync: (
    path: string,
    content: string,
    options?: { signal?: AbortSignal },
  ) => void;
  existsSync: (path: string) => boolean;
  readdirSync: (path: string) => string[];
  mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
  unlinkSync: (path: string) => void;
  appendFileSync: (
    path: string,
    content: string,
    options?: { signal?: AbortSignal },
  ) => void;
  statSync: (path: string) => {
    isFile: () => boolean;
    isDirectory: () => boolean;
  };
  globSync: (pattern: string) => string[];
  gitLsFiles: (pattern: string) => string[];
}

const EXCLUDED_KEYS = [
  "_files",
  "_dirs",
  "_globResults",
  "_gitLsFilesResults",
  "_restore",
];

export function makeFakeFsDeps(
  overrides: Partial<FakeFsDeps> = {},
): FakeFsDeps {
  const _files = new Map<string, string>();
  const _dirs = new Set<string>();
  const _globResults = new Map<string, string[]>();
  const _gitLsFilesResults = new Map<string, string[]>();
  const _mtimes = new Map<string, number>();

  let _mtimeCounter = 0;

  return {
    _files,
    _dirs,
    _globResults,
    _gitLsFilesResults,
    readFileSync: (path: string) => {
      const content = _files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return Buffer.from(content);
    },
    writeFileSync: (path: string, content: string) => {
      _files.set(path, content);
      _mtimes.set(path, ++_mtimeCounter);
    },
    existsSync: (path: string) => _files.has(path) || _dirs.has(path),
    readdirSync: (path: string) => {
      const prefix = path + "/";
      const result = new Set<string>();
      for (const filePath of _files.keys()) {
        if (filePath.startsWith(prefix)) {
          const name = filePath.slice(prefix.length).split("/")[0];
          if (name !== undefined) result.add(name);
        }
      }
      for (const dirPath of _dirs) {
        if (dirPath.startsWith(prefix)) {
          const name = dirPath.slice(prefix.length).split("/")[0];
          if (name !== undefined) result.add(name);
        }
      }
      return [...result];
    },
    mkdirSync: (path: string) => _dirs.add(path),
    unlinkSync: (path: string) => {
      _files.delete(path);
      _mtimes.delete(path);
    },
    appendFileSync: (path: string, content: string) => {
      _files.set(path, (_files.get(path) ?? "") + content);
      _mtimes.set(path, ++_mtimeCounter);
    },
    statSync: (path: string) => ({
      isFile: () => _files.has(path),
      isDirectory: () => _dirs.has(path),
      mtimeMs: _mtimes.get(path) ?? 0,
    }),
    globSync: (pattern: string) => _globResults.get(pattern) ?? [],
    gitLsFiles: (pattern: string) => _gitLsFilesResults.get(pattern) ?? [],
    _restore: () => {
      _files.clear();
      _dirs.clear();
      _globResults.clear();
      _gitLsFilesResults.clear();
      _mtimes.clear();
      _mtimeCounter = 0;
    },
    ...overrides,
  };
}

export function mockStdout(opts: { includeSpinnerFrames?: boolean } = {}) {
  const { includeSpinnerFrames = false } = opts;
  let captured = "";
  mock.method(processDeps.stdout, "write", (out: string) => {
    if (!includeSpinnerFrames && out.includes("\r")) return;
    captured += out;
  });
  return () => captured;
}

export function mockStderr() {
  let captured = "";
  mock.method(processDeps.stderr, "write", (out: string) => {
    captured += out;
  });
  return () => captured;
}

export function makeFakeProcessEnv() {
  const map = new Map<string, string>();

  return {
    get(key: string) {
      return map.get(key);
    },
    _set(key: string, value: string) {
      return map.set(key, value);
    },
    _clear() {
      map.clear();
    },
  };
}

export function makeFakeCwd() {
  let cwd = "/test-cwd";
  return {
    _cwd: cwd,
    _set(val: string) {
      cwd = val;
    },
    get() {
      return cwd;
    },
  };
}

export const testFs = makeFakeFsDeps();
export const testProcessEnv = makeFakeProcessEnv();
export const testCwd = makeFakeCwd();

const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;]*m/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_ESCAPE_PATTERN, "");
}

export function makeFakeRl(overrides: object = {}) {
  return {
    write: () => null,
    prompt: () => null,
    line: "",
    close: () => null,
    question: () => Promise.resolve(""),
    ...overrides,
  } as unknown as readline.Interface;
}

export function makeFakeRlWithWrites(overrides: object = {}) {
  const writes: { chunk: unknown; key: unknown }[] = [];
  const rl = makeFakeRl({
    write: (chunk: unknown, key?: unknown) => {
      writes.push({ chunk, key });
    },
    ...overrides,
  });
  return { rl, writes };
}

export function setupTestContext({
  now = 0,
  apiKey = "api-key",
  sdkProvider = "anthropic" as const,
  model = "main-model",
}: {
  now?: number;
  apiKey?: string | null;
  sdkProvider?: SdkProvider | null;
  model?: string | null;
} = {}) {
  testFs._restore();
  for (const key of Object.keys(testFs)) {
    if (!EXCLUDED_KEYS.includes(key)) {
      mock.method(
        fsDeps,
        key as keyof typeof fsDeps,
        testFs[key as keyof typeof testFs] as never,
      );
    }
  }

  testProcessEnv._clear();
  mock.method(processDeps.env, "get", (key: string) => testProcessEnv.get(key));
  mock.method(processDeps, "cwd", () => testCwd.get());
  mock.method(promptDeps, "getSystemContent", () => "");
  mock.method(processDeps.stdout, "write", () => true);
  mock.method(processDeps.stderr, "write", () => true);
  mock.method(os, "homedir", () => "/fake-home");
  mock.method(os, "tmpdir", () => "/tmp");
  mock.method(
    crypto,
    "randomBytes",
    () =>
      ({
        toString: () => "test-uuid",
      }) as Buffer,
  );
  mock.method(Date, "now", () => now);
  actions.resetState();
  if (apiKey !== null) {
    testProcessEnv._set("LASSO_API_KEY", apiKey);
  }
  if (sdkProvider !== null) {
    actions.setSdkProvider(sdkProvider);
  }
  if (model !== null) {
    actions.setModel(model);
  }
}

export function makeGenerateTextResult(
  overrides: Record<string, unknown> = {},
) {
  return {
    text: "response text",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    responseMessages: [],
    ...overrides,
  };
}

type ExecCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

export function mockExec(opts: {
  stdout: string;
  error?: Error;
  once?: boolean;
}) {
  const { stdout, error, once } = opts;
  const impl = (_cmd: string, _opts: unknown, cb: ExecCallback) => {
    cb(error ?? null, stdout, "");
  };
  const m = mock.method(childProcess, "exec", impl);
  if (once === true) {
    m.mock.mockImplementationOnce(impl);
  }
}

export function mockExecCalls(
  calls: { stdout: string; error?: Error }[],
  commands?: string[],
  onCall?: (cmd: string) => void,
) {
  const queue = [...calls];
  mock.method(
    childProcess,
    "exec",
    (cmd: string, _opts: unknown, cb: ExecCallback) => {
      commands?.push(cmd);
      onCall?.(cmd);
      const call = queue.shift();
      if (call === undefined) throw new Error("Unexpected exec call");
      const { stdout, error } = call;
      cb(error ?? null, stdout, "");
    },
  );
}

export function mockGenerateText(implementation: unknown) {
  mock.method(aiDeps, "generateText", implementation as never);
}

export function getCapturedTool(
  options: Record<string, unknown> | undefined,
  name: string,
): ToolSet[string] {
  if (options === undefined) {
    throw new Error(`Expected generateText call for tool ${name}`);
  }
  const tools = options["tools"] as ToolSet | undefined;
  const tool = tools?.[name];
  if (tool === undefined) {
    throw new Error(`Expected tool ${name} in generateText options`);
  }
  return tool;
}

export function mockClipboardPaste(stdout: string) {
  mock.method(os, "platform", () => "linux");
  mockExec({ stdout });
}
export interface SpawnSyncResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
}

export function mockSpawnSync(
  opts: {
    result?: SpawnSyncResult;
    error?: Error;
    echoInput?: boolean;
  } = {},
) {
  const { result, error, echoInput } = opts;
  mock.method(
    childProcess,
    "spawnSync",
    (_cmd: string, _args: readonly string[], options: { input?: string }) => {
      if (error !== undefined) {
        throw error;
      }
      if (echoInput === true) {
        return {
          status: 0,
          stdout: options.input ?? "",
          stderr: "",
        };
      }
      return result;
    },
  );
}

export function mockPagerSpawn() {
  const spawned: string[] = [];
  mock.method(childProcess, "spawnSync", (cmd: string) => {
    spawned.push(cmd);
  });
  return { spawned };
}

export function mockBatAvailable(available: boolean) {
  if (available) {
    mockExec({ stdout: "" });
  } else {
    mockExec({ stdout: "", error: new Error("bat not found") });
  }
}

export function batPagerCmd(
  tempFile: string,
  contentType: "diff" | "markdown" = "markdown",
) {
  const batFlags =
    contentType === "diff"
      ? baseBatFlags
      : baseBatFlags.concat(markdownBatFlags);
  return `bat ${batFlags.join(" ")} --paging=always "${tempFile}"`;
}

export function setupKeypressTests() {
  const { rl, writes } = makeFakeRlWithWrites();
  actions.setRl(rl);
  actions.setQuestionAbortController(new AbortController());
  initKeypress();

  const emitKey = (key: Key) => {
    actions.resetStdout();
    writes.length = 0;
    stdin.emit("keypress", key.name, key);
  };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const cleanup = () => stdin.removeAllListeners("keypress");

  return { rl, writes, emitKey, flush, cleanup };
}

export function mockSetInterval() {
  const callbacks: (() => void)[] = [];
  mock.method(globalThis, "setInterval", (cb: () => void) => {
    callbacks.push(cb);
    return callbacks.length as unknown as ReturnType<typeof setInterval>;
  });
  return callbacks;
}

export function mockSetTimeout() {
  const callbacks: (() => void)[] = [];
  mock.method(globalThis, "setTimeout", (cb: () => void) => {
    callbacks.push(cb);
    return callbacks.length as unknown as ReturnType<typeof setTimeout>;
  });
  return callbacks;
}

export function mockClearInterval(callbacks: (() => void)[]) {
  mock.method(globalThis, "clearInterval", () => {
    callbacks.length = 0;
  });
}
