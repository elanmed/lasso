// eslint-disable-next-line import/no-unresolved
import { Experimental_StdioMCPTransport as StdioClientTransport } from "@ai-sdk/mcp/mcp-stdio";
import { tryCatchAsync, getMessageFromError } from "./utils.ts";
import {
  actions,
  getState,
  type MCPClients,
  type MCPToolSet,
} from "./state.ts";
import { mcpDeps } from "./deps.ts";
import { type Mcp } from "./schemas.ts";
import { print, successWithSpacing } from "./printing.ts";
import type { ParallelPerformanceLogger, LogIdToLabel } from "./printing.ts";

async function createMcpClient(config: Mcp) {
  switch (config.type) {
    case "http":
    case "sse": {
      const headers = (() => {
        if (config.headers === undefined) return {};
        return { headers: config.headers };
      })();

      return mcpDeps.createMCPClient({
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

      return mcpDeps.createMCPClient({
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

async function getMcpClients({
  performanceLogger,
}: {
  performanceLogger: ParallelPerformanceLogger;
}) {
  const mcpClients: MCPClients = {};

  const serverEntries = Object.entries(getState().config.mcps);
  await Promise.all(
    serverEntries.map(async ([name, config]) => {
      performanceLogger.start(name);
      const createMcpResult = await tryCatchAsync(createMcpClient(config));
      performanceLogger.end(name);
      if (createMcpResult.ok) {
        mcpClients[name] = createMcpResult.value;
      } else {
        actions.content.appendConfigWarningMessage(
          `Failed to start the ${name} mcp server, ignoring. Error: ${getMessageFromError(createMcpResult.error, { forceSingleLine: true })}`,
        );
      }
    }),
  );

  return mcpClients;
}

export async function initMcpState({
  performanceLogger,
}: {
  performanceLogger: ParallelPerformanceLogger;
}) {
  const state = getState();

  await state.mcp.close();
  const clients = await getMcpClients({
    performanceLogger,
  });
  const toolSetsPromise = Promise.all(
    Object.entries(clients).map(async ([name, client]) => {
      const toolsPromise = await tryCatchAsync(client.tools());
      if (toolsPromise.ok) {
        return toolsPromise.value;
      } else {
        actions.content.appendConfigWarningMessage(
          `Failed to import the tools for the \`${name}\` mcp server, ignoring. Error: ${getMessageFromError(toolsPromise.error, { forceSingleLine: true })}`,
        );
        return null;
      }
    }),
  );
  const toolSetsResult = (await toolSetsPromise).filter(
    (toolSet) => toolSet !== null,
  );
  const tools = Object.assign({}, ...toolSetsResult) as MCPToolSet;
  actions.mcp.setClientsAndTools(clients, tools);
}

export function getMcpLogIdToLabel(): LogIdToLabel {
  const serverEntries = Object.entries(getState().config.mcps);
  return serverEntries.map(([name]) => [name, `Starting ${name} mcp server: `]);
}

export function printMcps() {
  if (Object.keys(getState().mcp.clients).length === 0) {
    successWithSpacing(() => print.warning("No available MCP servers"));
    return;
  }

  const formatted = Object.entries(getState().mcp.clients).map(
    ([clientName, client]) => {
      const { serverInfo } = client;
      return `- ${clientName} (${serverInfo.name} v${serverInfo.version})`;
    },
  );

  successWithSpacing(() => {
    print.doing("Available MCP servers:");
    for (const server of formatted) {
      print.plain(server);
    }
  });
}
