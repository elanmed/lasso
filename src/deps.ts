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
import { generateText, isLoopFinished } from "ai";
import childProcess from "node:child_process";

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

function gitLsFiles(regex: string) {
  return childProcess
    .execFileSync(
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
    )
    .split("\0")
    .filter(Boolean);
}

export type FsDeps = typeof fsDeps;

export const processDeps = {
  env: {
    get: (key: string) => process.env[key],
  },
  stdout: {
    getColumns: (): number | undefined => process.stdout.columns,
    write: (out: string) => {
      process.stdout.write(out);
    },
  },
  cwd: () => process.cwd(),
  kill: (pid: number, signal: number) => process.kill(pid, signal),
};

export const aiDeps = {
  generateText,
  isLoopFinished,
};

export const MISSING = "__MISSING__";
