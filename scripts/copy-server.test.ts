import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { describe, it, afterEach, mock } from "node:test";
import { readPort, stop } from "./test-helpers.ts";

const serverPath = fileURLToPath(new URL("./copy-server.ts", import.meta.url));

async function send(port: number, chunks: Buffer[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("error", reject);
    socket.once("connect", () => {
      for (const chunk of chunks) socket.write(chunk);
      socket.end();
    });
    socket.once("close", () => resolve());
  });
}

describe("copy-server", () => {
  afterEach(() => {
    mock.restoreAll();
  });
  it("writes client data, including multiple TCP chunks, to command stdin", async () => {
    const directory = mkdtempSync(`${tmpdir()}/copy-server-test-`);
    const outputPath = `${directory}/clipboard`;
    const server = spawn(
      process.execPath,
      [serverPath, `cat > ${outputPath}`],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const chunks = [
      Buffer.from("copy content\n"),
      Buffer.from("with multiple chunks"),
    ];

    try {
      const port = await readPort(server);
      await send(port, chunks);
      assert.deepStrictEqual(readFileSync(outputPath), Buffer.concat(chunks));
    } finally {
      await stop(server);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("continues serving after a clipboard command fails", async () => {
    const server = spawn(process.execPath, [serverPath, "false"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const port = await readPort(server);
      await send(port, [Buffer.from("ignored")]);
      assert.strictEqual(server.exitCode, null);
    } finally {
      await stop(server);
    }
  });
});
