import os from "node:os";
import crypto from "node:crypto";
import { mock } from "node:test";
import assert from "node:assert";
import readline from "node:readline/promises";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { stdin } from "node:process";
import { z } from "zod";
import type { ModelMessage, ToolSet } from "ai";
import type { MCPClient } from "@ai-sdk/mcp";
import {
  aiDeps,
  childProcessDeps,
  fsDeps,
  mcpDeps,
  processDeps,
} from "./deps.ts";
import {
  actions,
  getState,
  promptDeps,
  type MCPToolSet,
  type SessionFile,
} from "./state.ts";
import { initKeypress } from "./input.ts";
import type { Key, Mcp, SdkProvider } from "./config-types.ts";
import { getMcpLogIdToLabel } from "./config.ts";
import { createParallelPerformanceLogger } from "./print.ts";
import { baseBatFlags, markdownBatFlags } from "./terminal.ts";
import { shellQuote } from "./utils.ts";

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
  readFile: (
    path: string,
    options?: { encoding?: BufferEncoding | null } | BufferEncoding,
  ) => Promise<Buffer | string>;
  writeFile: (
    path: string,
    content: string,
    options?: { signal?: AbortSignal },
  ) => Promise<void>;
  existsSync: (path: string) => boolean;
  readdir: (path: string) => Promise<string[]>;
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  appendFile: (
    path: string,
    content: string,
    options?: { signal?: AbortSignal },
  ) => Promise<void>;
  stat: (path: string) => Promise<{
    isFile: () => boolean;
    isDirectory: () => boolean;
  }>;
  glob: (pattern: string) => Promise<string[]>;
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
    readFile: (
      path: string,
      options?: { encoding?: BufferEncoding | null } | BufferEncoding,
    ) => {
      const content = _files.get(path);
      if (content === undefined) {
        return Promise.reject(new Error(`ENOENT: ${path}`));
      }
      return Promise.resolve(
        typeof options === "string" ? content : Buffer.from(content),
      );
    },
    writeFile: (path: string, content: string) => {
      _files.set(path, content);
      _mtimes.set(path, ++_mtimeCounter);
      return Promise.resolve();
    },
    existsSync: (path: string) => _files.has(path) || _dirs.has(path),
    readdir: (path: string) => {
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
      return Promise.resolve([...result]);
    },
    mkdir: (path: string) => {
      _dirs.add(path);
      return Promise.resolve();
    },
    unlink: (path: string) => {
      if (!_files.has(path)) {
        return Promise.reject(
          makeErrnoError("ENOENT", `ENOENT: no such file: ${path}`),
        );
      }
      _files.delete(path);
      _mtimes.delete(path);
      return Promise.resolve();
    },
    appendFile: (path: string, content: string) => {
      _files.set(path, (_files.get(path) ?? "") + content);
      _mtimes.set(path, ++_mtimeCounter);
      return Promise.resolve();
    },
    stat: (path: string) =>
      Promise.resolve({
        isFile: () => _files.has(path),
        isDirectory: () => _dirs.has(path),
        mtimeMs: _mtimes.get(path) ?? 0,
      }),
    glob: (pattern: string) => Promise.resolve(_globResults.get(pattern) ?? []),
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

export function mockStdoutWrites(
  opts: { includeSpinnerFrames?: boolean } = {},
) {
  const { includeSpinnerFrames = false } = opts;
  const writes: string[] = [];
  mock.method(processDeps.stdout, "write", (out: string) => {
    if (!includeSpinnerFrames && out.includes("\r")) return;
    writes.push(out);
  });
  return () => writes;
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

export function addSessionFile(timestampMs: number, session: SessionFile) {
  testFs._dirs.add("/fake-home/.local/state/lasso/sessions");
  const path = `/fake-home/.local/state/lasso/sessions/session-${timestampMs.toString()}.json`;
  testFs._files.set(path, JSON.stringify(session));
  return path;
}

const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;]*m/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_ESCAPE_PATTERN, "");
}

export const BLUE = "\x1b[34m";
export const GREEN = "\x1b[32m";
export const RED = "\x1b[31m";
export const RESET = "\x1b[0m";
export const UP_1 = "\x1b[1A";
export const UP_2 = "\x1b[2A";
export const DOWN_1 = "\x1b[1B";
export const DOWN_2 = "\x1b[2B";
export const CLEAR_LINE = "\x1b[2K";
export const CR = "\r";
export const YELLOW = "\x1b[33m";
export const GREY = "\x1b[90m";
export const BOLD = "\x1b[1m";
export const BOLD_RESET = "\x1b[22m";
export const PURPLE = "\x1b[35m";

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
  process.env["TZ"] = "UTC";
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
  mock.method(promptDeps, "getToolsContentStr", () => "");
  mock.method(processDeps.stdout, "write", () => true);
  mock.method(processDeps.stdout, "isTTY", () => true);
  mock.method(processDeps.stderr, "write", () => true);
  mock.method(childProcessDeps, "execFile", () => "");
  mock.method(childProcessDeps, "spawn", () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit"));
    return child as unknown as ChildProcess;
  });
  mock.method(childProcessDeps, "spawnSync", () => ({
    status: 0,
    stdout: "",
    stderr: "",
  }));
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
  mock.method(process.hrtime, "bigint", () => BigInt(0));
  mock.method(
    globalThis,
    "setInterval",
    () => 0 as unknown as ReturnType<typeof setInterval>,
  );
  mock.method(globalThis, "clearInterval", () => undefined);
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

export function makeMockUsage(
  overrides: {
    inputTokens?: number;
    outputTokens?: number | undefined;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  } = {},
) {
  const usage: {
    inputTokens: number;
    outputTokens: number | undefined;
    inputTokenDetails: { cacheReadTokens: number; cacheWriteTokens: number };
  } = {
    inputTokens: 0,
    outputTokens: 25_000,
    inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
  if (overrides.inputTokens !== undefined) {
    usage.inputTokens = overrides.inputTokens;
  }
  if ("outputTokens" in overrides) {
    usage.outputTokens = overrides.outputTokens;
  }
  if (overrides.cacheReadTokens !== undefined) {
    usage.inputTokenDetails.cacheReadTokens = overrides.cacheReadTokens;
  }
  if (overrides.cacheWriteTokens !== undefined) {
    usage.inputTokenDetails.cacheWriteTokens = overrides.cacheWriteTokens;
  }
  return usage;
}

export function mockProcessExit() {
  return mock.method(process, "exit", () => {
    throw new Error("process.exit called");
  });
}

export function makeAbortError(message = "aborted") {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

export function mockGenerateTextResults(results: unknown[]) {
  let callCount = 0;
  const m = mock.method(aiDeps, "generateText", () => {
    const result = results[callCount];
    callCount = callCount + 1;
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(makeGenerateTextResult(result as never));
  });
  return {
    callCount() {
      return callCount;
    },
    mock: m,
  };
}

export function getCapturedMessages(
  options: Record<string, unknown> | undefined,
) {
  const messages = options?.["messages"];
  assert.ok(Array.isArray(messages), "Expected messages in generateText call");
  return messages as ModelMessage[];
}

export function mockExec(opts: {
  stdout: string;
  error?: Error;
  once?: boolean;
}) {
  const { stdout, error, once } = opts;
  const impl = () => {
    if (error !== undefined) return Promise.reject(error);
    return Promise.resolve({ stdout, stderr: "" });
  };
  const m = mock.method(childProcessDeps, "exec", impl);
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
  mock.method(childProcessDeps, "exec", (cmd: string) => {
    commands?.push(cmd);
    onCall?.(cmd);
    const call = queue.shift();
    if (call === undefined) {
      return Promise.reject(new Error("Unexpected exec call"));
    }
    const { stdout, error } = call;
    if (error !== undefined) return Promise.reject(error);
    return Promise.resolve({ stdout, stderr: "" });
  });
}

export function mockExecRecordingOptions() {
  const optionsCalls: unknown[] = [];
  mock.method(childProcessDeps, "exec", (_cmd: string, options: unknown) => {
    optionsCalls.push(options);
    return Object.assign(Promise.resolve({ stdout: "", stderr: "" }), {
      child: { stdin: undefined },
    });
  });
  return optionsCalls;
}

export function mockGenerateText(implementation: unknown) {
  mock.method(aiDeps, "generateText", implementation as never);
}

export function getCapturedTool(
  options: Record<string, unknown> | undefined,
  name: string,
): ToolSet[string] {
  assert.ok(options !== undefined, `Expected generateText call for ${name}`);
  const tools = options["tools"] as ToolSet | undefined;
  assert.ok(tools !== undefined, `Expected tools in generateText options`);
  const tool = tools[name];
  assert.ok(
    tool !== undefined,
    `Expected tool ${name} in generateText options`,
  );
  return tool;
}

export function mockClipboardPaste(stdout: string) {
  mock.method(os, "platform", () => "linux");
  mockExec({ stdout });
}

export function mockClipboardPasteFailure(error: Error) {
  mock.method(os, "platform", () => "linux");
  mockExec({ stdout: "", error });
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
    childProcessDeps,
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
  mock.method(childProcessDeps, "spawnSync", (cmd: string) => {
    spawned.push(cmd);
  });
  return { spawned };
}

export function mockEditorSpawn(
  onSpawn?: (cmd: string, child: EventEmitter) => void,
) {
  const spawned: string[] = [];
  mock.method(childProcessDeps, "spawn", (cmd: string) => {
    spawned.push(cmd);
    const child = new EventEmitter();
    queueMicrotask(() => {
      onSpawn?.(cmd, child);
      child.emit("exit");
    });
    return child as unknown as ChildProcess;
  });
  return { spawned };
}

export function mockRecording({
  chunk = "fake recording",
  spawnError,
}: { chunk?: string; spawnError?: Error } = {}) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const killSignals: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    kill: (signal?: string) => {
      killSignals.push(signal ?? "");
      stdout.emit("data", Buffer.from(chunk));
      const lastCall = spawnCalls[spawnCalls.length - 1];
      const outputArg = lastCall?.args[lastCall.args.length - 1];
      if (typeof outputArg === "string") {
        testFs._files.set(outputArg, chunk);
      }
      child.emit("close", 0, signal ?? null);
    },
  }) as unknown as ChildProcess;
  const spawnCalls: {
    file: string;
    args: string[];
    options: unknown;
  }[] = [];
  mock.method(
    childProcessDeps,
    "spawn",
    (file: string, args: string[], options: unknown) => {
      spawnCalls.push({ file, args, options });
      process.nextTick(() =>
        spawnError === undefined
          ? child.emit("spawn")
          : child.emit("error", spawnError),
      );
      return child;
    },
  );
  return { child, stdout, stderr, spawnCalls, killSignals };
}

export function mockTranscription(text: string) {
  const transcribeCalls: {
    audio: Buffer;
    model: unknown;
    abortSignal?: AbortSignal;
  }[] = [];
  mock.method(aiDeps, "transcribe", (args: unknown) => {
    transcribeCalls.push(args as { audio: Buffer; model: unknown });
    return Promise.resolve({ text });
  });
  return { transcribeCalls };
}

export function first<T>(array: T[]): T {
  const [item] = array;
  assert(item !== undefined);
  return item;
}

export function batPagerCmd(
  tempFile: string,
  contentType: "diff" | "markdown" = "markdown",
) {
  const batFlags =
    contentType === "diff"
      ? baseBatFlags()
      : baseBatFlags().concat(markdownBatFlags);
  return `bat ${batFlags.join(" ")} --paging=always ${shellQuote(tempFile)}`;
}

export function setupKeypressTests() {
  const { rl, writes } = makeFakeRlWithWrites();
  actions.setRl(rl);
  actions.setQuestionAbortController(new AbortController());
  initKeypress(rl);

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

export function makeErrnoError(
  code: string,
  message = code,
): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

export async function drainTimerCallbacks(
  callbacks: (() => void)[],
  { keep = 0 }: { keep?: number } = {},
) {
  await new Promise<void>((resolve) => setImmediate(resolve));
  while (callbacks.length > keep) {
    const callback = callbacks.shift();
    assert(callback !== undefined);
    callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export function makeFakeMcpClient({
  tools,
  close,
  listResources,
  readResource,
}: {
  tools?: () => Promise<unknown>;
  close?: () => void;
  listResources?: (options?: {
    params?: { cursor: string };
  }) => Promise<unknown>;
  readResource?: (args: { uri: string }) => Promise<unknown>;
} = {}) {
  return {
    tools: tools ?? (() => Promise.resolve({})),
    close: close ?? (() => undefined),
    listResources: listResources ?? (() => Promise.resolve({})),
    readResource: readResource ?? (() => Promise.resolve({})),
  } as unknown as MCPClient;
}

export function setMcpClients({
  clients,
  tools = {},
}: {
  clients: Record<string, unknown>;
  tools?: Record<string, unknown>;
}) {
  actions.setMcp(clients as Record<string, MCPClient>, tools as MCPToolSet);
}

export function makeFakeMcpToolSet(tools: Record<string, unknown>) {
  return tools as unknown as MCPToolSet;
}

export function makeInvalidString(): string {
  return null as unknown as string;
}

export function mockGitLsFilesRejection() {
  mock.method(
    fsDeps,
    "gitLsFiles",
    () => Promise.reject(new Error("git failed")) as unknown as string[],
  );
}

export function setMcps(...names: string[]) {
  const mcps: Record<string, Mcp> = {};
  for (const name of names) {
    mcps[name] = { type: "http", url: "not-a-url" };
  }
  actions.setMcps(mcps);
}

export function mockMcpClients(...clients: (MCPClient | Error)[]) {
  let index = 0;
  return mock.method(mcpDeps, "createMCPClient", () => {
    const client = clients[index];
    index += 1;
    if (client === undefined || client instanceof Error) {
      return Promise.reject(
        client ?? new Error("unexpected createMCPClient call"),
      );
    }
    return Promise.resolve(client);
  });
}

export function makeStartupPerformanceLogger() {
  return createParallelPerformanceLogger({
    logDuration: !getState().config.suppressStartupDurations,
    logIdToLabel: getMcpLogIdToLabel(),
  });
}
