// eslint-disable-next-line import/no-unresolved
import { Experimental_StdioMCPTransport as StdioClientTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { MCPClient } from "@ai-sdk/mcp";
import { actions, getState, type MCPToolSet } from "./state.ts";
import type { Mcp } from "./config-types.ts";
import { print, type ParallelPerformanceLogger } from "./print.ts";
import { getMessageFromError, tryCatchAsync } from "./utils.ts";
import { mcpDeps } from "./deps.ts";

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
  const mcpClients: Record<string, MCPClient> = {};

  const serverEntries = Object.entries(getState().config.mcps);
  const failureMessages: string[] = [];
  await Promise.all(
    serverEntries.map(async ([name, config]) => {
      performanceLogger.start(name);
      const createMcpResult = await tryCatchAsync(createMcpClient(config));
      performanceLogger.end(name);
      if (createMcpResult.ok) {
        mcpClients[name] = createMcpResult.value;
      } else {
        failureMessages.push(
          `Failed to start the ${name} mcp server: ${getMessageFromError(createMcpResult.error, { forceSingleLine: true })}`,
        );
      }
    }),
  );
  failureMessages.forEach((message) => print.error(message));

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
        actions.appendConfigWarningMessage(
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
  actions.setMcp(clients, tools);
}
