import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert";
import type { MCPClient } from "@ai-sdk/mcp";
import { actions, getState, type MCPToolSet } from "./state.ts";
import { initMcpState } from "./mcp.ts";
import {
  makeFakeMcpClient,
  mockMcpClients,
  mockStdout,
  setupTestContext,
  stripAnsi,
} from "./test-helpers.ts";

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
    const firstClient = makeFakeMcpClient({ close: closeFirst });
    const secondClient = makeFakeMcpClient({ close: closeSecond });
    actions.setMcp({ first: firstClient, second: secondClient }, {});

    await initMcpState();

    assert.equal(closeFirst.mock.callCount(), 1);
    assert.equal(closeSecond.mock.callCount(), 1);
    assert.deepStrictEqual(getState().mcp.clients, {});
    assert.deepStrictEqual(getState().mcp.tools, {});
  });

  it("ignores MCP clients that fail during initialization", async () => {
    mockMcpClients(new Error("connection refused"));
    actions.setMcps({
      first: { type: "http", url: "not-a-url" },
      second: { type: "sse", url: "also-not-a-url" },
    });

    await initMcpState();

    assert.deepStrictEqual(getState().mcp.clients, {});
    assert.deepStrictEqual(getState().mcp.tools, {});
  });

  it("prints an error when a client fails to start", async () => {
    mockMcpClients(new Error("connection refused"));
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
    mockMcpClients(makeFakeMcpClient());
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
    mockMcpClients(makeFakeMcpClient());
    actions.setHideStartupDurations(true);
    actions.setMcps({
      first: { type: "http", url: "not-a-url" },
    });

    const getCaptured = mockStdout();
    await initMcpState();

    assert.strictEqual(stripAnsi(getCaptured()), "");
  });

  it("keeps all clients when one client's tools() call fails", async () => {
    const closeFirst = mock.fn(() => undefined);
    const closeSecond = mock.fn(() => undefined);
    const firstClient = makeFakeMcpClient({
      tools: () => Promise.reject(new Error("boom")),
      close: closeFirst,
    });
    const secondClient = makeFakeMcpClient({ close: closeSecond });
    mockMcpClients(firstClient, secondClient);
    actions.setMcps({
      first: { type: "http", url: "not-a-url" },
      second: { type: "sse", url: "also-not-a-url" },
    });

    await initMcpState();

    assert.deepStrictEqual(getState().mcp.clients, {
      first: firstClient,
      second: secondClient,
    });
    assert.deepStrictEqual(getState().mcp.tools, {});
    await getState().mcp.close();
    assert.equal(closeFirst.mock.callCount(), 1);
    assert.equal(closeSecond.mock.callCount(), 1);
  });

  it("keeps the tools of clients whose tools() call succeeds", async () => {
    const tools = {
      greet: { description: "says hello" },
    } as unknown as MCPToolSet;
    const firstClient = makeFakeMcpClient({
      tools: () => Promise.reject(new Error("boom")),
    });
    const secondClient = makeFakeMcpClient({
      tools: () => Promise.resolve(tools),
    });
    mockMcpClients(firstClient, secondClient);
    actions.setMcps({
      first: { type: "http", url: "not-a-url" },
      second: { type: "sse", url: "also-not-a-url" },
    });

    await initMcpState();

    assert.deepStrictEqual(getState().mcp.tools, {
      greet: { description: "says hello" },
    });
  });

  it("prints an error when a client's tools() call fails", async () => {
    mockMcpClients(
      makeFakeMcpClient({ tools: () => Promise.reject(new Error("boom")) }),
    );
    actions.setMcps({
      first: { type: "http", url: "not-a-url" },
    });

    const getCaptured = mockStdout();
    await initMcpState();

    assert.strictEqual(
      stripAnsi(getCaptured()),
      "Starting first mcp server: 0.0ms\nFailed to import the tools the first mcp server: boom\n",
    );
  });
});
