import net from "node:net";
import { execSync } from "node:child_process";

const args = process.argv.slice(2);

if (args.length !== 1) {
  throw new Error("usage: --copy-cmd [cmd]");
}
const [command] = args;
if (command === undefined) {
  throw new Error("missing command");
}

const stdin = "pipe";
const stdout = "ignore";
const stderr = "ignore";

const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  const chunks: Buffer[] = [];
  socket.on("error", (error) => {
    console.error("socket error:", error);
  });
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.on("end", () => {
    try {
      execSync(command, {
        input: Buffer.concat(chunks),
        stdio: [stdin, stdout, stderr],
      });
    } catch (error) {
      console.error("clipboard process error:", error);
    }
    socket.end();
  });
});

server.listen(0, "0.0.0.0", () => {
  const address = server.address();
  if (address === null) return;
  if (typeof address === "string") return;
  console.log(String(address.port));
});

server.on("error", (error) => {
  console.error("server error:", error);
});
