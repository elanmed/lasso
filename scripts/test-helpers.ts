import assert from "node:assert";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";

export async function readPort(server: ChildProcess): Promise<number> {
  const stdout = server.stdout;
  assert(stdout !== null);
  return await new Promise((resolve, reject) => {
    let output = "";

    const cleanup = () => {
      stdout.off("data", onData);
      server.off("error", onError);
      server.off("exit", onExit);
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const newline = output.indexOf("\n");
      if (newline === -1) return;

      const port = Number(output.slice(0, newline));
      if (!Number.isInteger(port) || port < 1) {
        cleanup();
        reject(new Error(`server printed an invalid port: ${output}`));
        return;
      }
      cleanup();
      resolve(port);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(`server exited before printing its port: ${String(code)}`),
      );
    };

    stdout.on("data", onData);
    server.once("error", onError);
    server.once("exit", onExit);
  });
}

export async function stop(server: ChildProcess): Promise<void> {
  if (server.exitCode === null) {
    server.kill();
    await once(server, "exit");
  }
}
