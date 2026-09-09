import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
// eslint-disable-next-line import/no-unresolved
import { Experimental_StdioMCPTransport as StdioClientTransport } from "@ai-sdk/mcp/mcp-stdio";
import { actions, getState, type MCPToolSet } from "./state.ts";

async function getMcpClients() {
  const mcpClients: Record<string, MCPClient> = {};
  for (const [name, config] of Object.entries(getState().config.mcps)) {
    const configType = config.type;
    switch (configType) {
      case "http":
      case "sse": {
        const headers = (() => {
          if (config.headers === undefined) return {};
          return { headers: config.headers };
        })();

        const client = await createMCPClient({
          transport: {
            type: config.type,
            url: config.url,
            ...headers,
            redirect: "error",
          },
        });
        mcpClients[name] = client;
        break;
      }
      case "stdio": {
        const args = (() => {
          if (config.args === undefined) return {};
          return { args: config.args };
        })();

        const client = await createMCPClient({
          transport: new StdioClientTransport({
            command: config.command,
            ...args,
          }),
        });
        mcpClients[name] = client;
        break;
      }
      default: {
        configType satisfies never;
      }
    }
  }
  return mcpClients;
}

export async function initMcpState() {
  const state = getState();
  await state.mcp.close();

  const clients = await getMcpClients();
  const toolSets = await Promise.all(
    Object.values(clients).map((client) => client.tools()),
  );
  const tools = Object.assign({}, ...toolSets) as MCPToolSet;
  actions.setMcp(clients, tools);
}
