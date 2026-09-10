import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert";
import type { MCPClient } from "@ai-sdk/mcp";
import { actions, getState, type MCPToolSet } from "./state.ts";
import { initMcpState } from "./mcp.ts";
import { setupTestContext } from "./test-helpers.ts";

describe("mcp", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
    actions.resetState();
  });

  it("sets clients and tools", () => {
    const firstClient = {} as MCPClient;
    const secondClient = {} as MCPClient;
    const clients = { first: firstClient, second: secondClient };
    const tools = {} as MCPToolSet;

    actions.setMcp(clients, tools);

    assert.strictEqual(getState().mcp.clients, clients);
    assert.strictEqual(getState().mcp.tools, tools);
  });

  it("closes existing clients and resets MCP state", async () => {
    const closeFirst = mock.fn(() => undefined);
    const closeSecond = mock.fn(() => undefined);
    const firstClient = { close: closeFirst } as unknown as MCPClient;
    const secondClient = { close: closeSecond } as unknown as MCPClient;
    actions.setMcp({ first: firstClient, second: secondClient }, {});

    await initMcpState();

    assert.equal(closeFirst.mock.callCount(), 1);
    assert.equal(closeSecond.mock.callCount(), 1);
    assert.deepStrictEqual(getState().mcp.clients, {});
    assert.deepStrictEqual(getState().mcp.tools, {});
  });

  it("ignores MCP clients that fail during initialization", async () => {
    actions.setMcps({
      first: { type: "http", url: "not-a-url" },
      second: { type: "sse", url: "also-not-a-url" },
    });

    await initMcpState();

    assert.deepStrictEqual(getState().mcp.clients, {});
    assert.deepStrictEqual(getState().mcp.tools, {});
  });
});
