import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { appendFile, glob as globAsync, stat } from "node:fs/promises";
import childProcess, {
  type ExecFileOptionsWithStringEncoding,
  type ExecOptionsWithStringEncoding,
} from "node:child_process";
import { promisify } from "node:util";
import { generateText, isLoopFinished } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";

type PromiseExecFile = (
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<{ stdout: string; stderr: string }>;

const execFile = promisify(childProcess.execFile) as unknown as PromiseExecFile;

interface PromiseExecResult {
  stdout: string;
  stderr: string;
}

type PromiseExec = (
  command: string,
  options?: ExecOptionsWithStringEncoding,
) => Promise<PromiseExecResult> & {
  child: { stdin: { end: () => void } | null };
};

const exec: PromiseExec = promisify(childProcess.exec);

export const childProcessDeps = {
  execFile,
  exec,
  spawn: childProcess.spawn,
  spawnSync: childProcess.spawnSync,
};

export type ChildProcessDeps = typeof childProcessDeps;

export const fsDeps = {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  unlinkSync,
  appendFile,
  stat,
  glob,
  gitLsFiles,
};

async function glob(pattern: string) {
  const results: string[] = [];
  for await (const entry of globAsync(pattern)) {
    results.push(entry);
  }
  return results;
}

async function gitLsFiles(regex: string) {
  const out = await childProcessDeps.execFile(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      regex,
    ],
    { encoding: "utf8" },
  );
  return out.stdout.split("\0").filter(Boolean);
}

export const processDeps = {
  env: {
    get: (key: string) => process.env[key],
  },
  stdout: {
    getColumns: (): number | undefined => process.stdout.columns,
    write: (out: string) => {
      process.stdout.write(out);
    },
    isTTY: () => process.stdout.isTTY,
  },
  stderr: {
    write: (out: string) => {
      process.stderr.write(out);
    },
  },
  cwd: () => process.cwd(),
  kill: (pid: number, signal: number) => process.kill(pid, signal),
};

export const aiDeps = {
  generateText,
  isLoopFinished,
};

export const mcpDeps = { createMCPClient };
