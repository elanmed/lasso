import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
// eslint-disable-next-line import/no-unresolved
import { Experimental_StdioMCPTransport as StdioClientTransport } from "@ai-sdk/mcp/mcp-stdio";
import { actions, getState, type MCPToolSet } from "./state.ts";
import type { Mcp } from "./config-types.ts";
import { print } from "./print.ts";
import { tryCatchAsync } from "./utils.ts";

async function createMcpClient(config: Mcp) {
  switch (config.type) {
    case "http":
    case "sse": {
      const headers = (() => {
        if (config.headers === undefined) return {};
        return { headers: config.headers };
      })();

      return createMCPClient({
        transport: {
          type: config.type,
          url: config.url,
          ...headers,
          protocolVersion: config.protocolVersion,
          redirect: "error",
        },
      });
    }
    case "stdio": {
      const args = (() => {
        if (config.args === undefined) return {};
        return { args: config.args };
      })();

      return createMCPClient({
        transport: new StdioClientTransport({
          command: config.command,
          ...args,
          stderr: "pipe",
        }),
      });
    }
    default: {
      config satisfies never;
      throw new Error("Unsupported MCP configuration");
    }
  }
}

async function getMcpClients() {
  const mcpClients: Record<string, MCPClient> = {};

  await Promise.all(
    Object.entries(getState().config.mcps).map(async ([name, config]) => {
      print.doing(`Starting mcp server: ${name}`);
      const createMcpResult = await tryCatchAsync(createMcpClient(config));
      if (createMcpResult.ok) {
        mcpClients[name] = createMcpResult.value;
      }
    }),
  );

  return mcpClients;
}

export async function initMcpState() {
  const state = getState();

  await state.mcp.close();
  const clients = await getMcpClients();
  const toolSetsPromise = Promise.all(
    Object.values(clients).map((client) => client.tools()),
  );
  const toolSetsResult = await tryCatchAsync(toolSetsPromise);
  if (toolSetsResult.ok) {
    const tools = Object.assign({}, ...toolSetsResult.value) as MCPToolSet;
    actions.setMcp(clients, tools);
  } else {
    actions.setMcp({}, {});
  }
}
