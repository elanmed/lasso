// eslint-disable-next-line import/no-unresolved
import { Experimental_StdioMCPTransport as StdioClientTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { MCPClient } from "@ai-sdk/mcp";
import { actions, getState, type MCPToolSet } from "./state.ts";
import type { Mcp } from "./config-types.ts";
import { createParallelPerformanceLogger, print } from "./print.ts";
import { getMessageFromError, tryCatchAsync } from "./utils.ts";
import { mcpDeps } from "./deps.ts";
import { assertAtBuildtime } from "./assert.ts";

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

async function getMcpClients() {
  const mcpClients: Record<string, MCPClient> = {};

  const serverEntries = Object.entries(getState().config.mcps);
  const labelByName = Object.fromEntries(
    serverEntries.map(([name]) => [name, `Starting ${name} mcp server: `]),
  );
  const performanceLogger = createParallelPerformanceLogger({
    logDuration: !getState().config.suppressStartupDurations,
    labels: Object.values(labelByName),
  });
  performanceLogger.printAllLabels();

  const failureMessages: string[] = [];
  await Promise.all(
    serverEntries.map(async ([name, config]) => {
      const label = labelByName[name];
      assertAtBuildtime(label !== undefined);

      performanceLogger.start(label);
      const createMcpResult = await tryCatchAsync(createMcpClient(config));
      performanceLogger.end(label);
      if (createMcpResult.ok) {
        mcpClients[name] = createMcpResult.value;
      } else {
        failureMessages.push(
          `Failed to start the ${name} mcp server: ${getMessageFromError(createMcpResult.error)}`,
        );
      }
    }),
  );
  failureMessages.forEach((message) => print.error(message));

  return mcpClients;
}

export async function initMcpState() {
  const state = getState();

  await state.mcp.close();
  const clients = await getMcpClients();
  const toolSetsPromise = Promise.all(
    Object.entries(clients).map(async ([name, client]) => {
      const toolsPromise = await tryCatchAsync(client.tools());
      if (toolsPromise.ok) {
        return toolsPromise.value;
      } else {
        print.error(
          `Failed to import the tools the ${name} mcp server: ${getMessageFromError(toolsPromise.error)}`,
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
