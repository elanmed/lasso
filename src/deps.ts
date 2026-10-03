import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  unlinkSync,
  appendFileSync,
  statSync,
  globSync,
} from "node:fs";
import childProcess, {
  type ExecFileOptionsWithStringEncoding,
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

export const childProcessDeps = {
  execFile,
  exec: childProcess.exec,
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
  appendFileSync,
  statSync,
  globSync,
  gitLsFiles,
};

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
