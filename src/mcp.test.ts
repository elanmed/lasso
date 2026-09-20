import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert";
import type { MCPClient } from "@ai-sdk/mcp";
import { actions, getState, type MCPToolSet } from "./state.ts";
import { initMcpState } from "./mcp.ts";
import {
  makeFakeMcpClient,
  mockStdout,
  setupTestContext,
  stripAnsi,
} from "./test-helpers.ts";
import { mcpDeps } from "./deps.ts";

describe("mcp", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
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
    mock.method(mcpDeps, "createMCPClient", () => {
      return Promise.reject(new Error("connection refused"));
    });
    actions.setMcps({
      first: { type: "http", url: "not-a-url" },
      second: { type: "sse", url: "also-not-a-url" },
    });

    await initMcpState();

    assert.deepStrictEqual(getState().mcp.clients, {});
    assert.deepStrictEqual(getState().mcp.tools, {});
  });

  it("prints an error when a client fails to start", async () => {
    mock.method(mcpDeps, "createMCPClient", () => {
      return Promise.reject(new Error("connection refused"));
    });
    mock.method(process.hrtime, "bigint", () => BigInt(0));
    actions.setMcps({
      first: { type: "http", url: "not-a-url" },
    });

    const getCaptured = mockStdout();
    await initMcpState();

    assert.strictEqual(
      stripAnsi(getCaptured()),
      "Starting first mcp server: 0.0ms\nFailed to start the first mcp server: connection refused\n",
    );
  });

  it("prints the mcp server start duration when hideStartupDurations is false", async () => {
    mock.method(mcpDeps, "createMCPClient", () => {
      return Promise.resolve(makeFakeMcpClient());
    });
    mock.method(process.hrtime, "bigint", () => BigInt(0));
    actions.setMcps({
      first: { type: "http", url: "not-a-url" },
    });

    const getCaptured = mockStdout();
    await initMcpState();

    assert.strictEqual(
      stripAnsi(getCaptured()),
      "Starting first mcp server: 0.0ms\n",
    );
  });

  it("hides the mcp server start duration when hideStartupDurations is true", async () => {
    mock.method(mcpDeps, "createMCPClient", () => {
      return Promise.resolve(makeFakeMcpClient());
    });
    actions.setHideStartupDurations(true);
    actions.setMcps({
      first: { type: "http", url: "not-a-url" },
    });

    const getCaptured = mockStdout();
    await initMcpState();

    assert.strictEqual(stripAnsi(getCaptured()), "");
  });
});
