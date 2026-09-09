import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport as StdioClientTransport } from "@ai-sdk/mcp/mcp-stdio";
import { getState } from "./state";

async function getMcpClients() {
  const mcpClients: MCPClient[] = [];
  for (const [name, config] of Object.entries(getState().config.mcps)) {
    const configType = config.type;
    switch (configType) {
      case "http":
      case "sse": {
        const client = await createMCPClient({
          transport: {
            type: config.type,
            url: config.url,
            headers: config.headers,
            protocolVersion: config.protocolVersion,
            redirect: "error",
          },
        });
        mcpClients.push(client);
        break;
      }
      case "stdio": {
        const client = await createMCPClient({
          transport: new StdioClientTransport({
            command: config.command,
            args: config.args,
          }),
        });
        mcpClients.push(client);

        break;
      }
      default: {
        configType satisfies never;
      }
    }
  }
  return mcpClients;
}
