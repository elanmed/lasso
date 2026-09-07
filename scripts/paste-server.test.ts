import assert from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { describe, it } from "node:test";
import { readPort, stop } from "./test-helpers.ts";

const serverPath = fileURLToPath(new URL("./paste-server.ts", import.meta.url));

async function request(port: number): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("connect", () => socket.end());
    socket.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

describe("paste-server", () => {
  it("sends the clipboard command output to the client for repeated requests", async () => {
    const server = spawn(
      process.execPath,
      [serverPath, "printf 'paste content'"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      const port = await readPort(server);
      const expected = Buffer.from("paste content");
      assert.deepStrictEqual(await request(port), expected);
      assert.deepStrictEqual(await request(port), expected);
    } finally {
      await stop(server);
    }
  });

  it("returns an empty response when the clipboard command fails", async () => {
    const server = spawn(process.execPath, [serverPath, "false"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const port = await readPort(server);
      assert.deepStrictEqual(await request(port), Buffer.alloc(0));
      assert.strictEqual(server.exitCode, null);
    } finally {
      await stop(server);
    }
  });
});
