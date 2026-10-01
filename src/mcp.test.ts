import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert";
import type { MCPClient } from "@ai-sdk/mcp";
import { actions, getState, type MCPToolSet } from "./state.ts";
import { initMcpState } from "./mcp.ts";
import {
  makeFakeMcpClient,
  mockMcpClients,
  mockStdout,
  setMcps,
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
    setMcps("first", "second");

    await initMcpState();

    assert.deepStrictEqual(getState().mcp.clients, {});
    assert.deepStrictEqual(getState().mcp.tools, {});
  });

  it("prints an error when a client fails to start", async () => {
    mockMcpClients(new Error("connection refused"));
    setMcps("first");

    const getCaptured = mockStdout();
    await initMcpState();

    assert.strictEqual(
      stripAnsi(getCaptured()),
      `Starting first mcp server: 
Starting first mcp server: 0.0msFailed to start the first mcp server: connection refused
`,
    );
  });

  it("prints all labels upfront and failure messages after every server settles", async () => {
    mockMcpClients(new Error("first error"), new Error("second error"));
    setMcps("first", "second");

    const getCaptured = mockStdout();
    await initMcpState();

    assert.strictEqual(
      stripAnsi(getCaptured()),
      `Starting first mcp server: 
Starting second mcp server: 
Starting first mcp server: 0.0msStarting second mcp server: 0.0msFailed to start the first mcp server: first error
Failed to start the second mcp server: second error
`,
    );
  });

  it("prints the mcp server start duration when suppressStartupDurations is false", async () => {
    mockMcpClients(makeFakeMcpClient());
    setMcps("first");

    const getCaptured = mockStdout();
    await initMcpState();

    assert.strictEqual(
      stripAnsi(getCaptured()),
      `Starting first mcp server: 
Starting first mcp server: 0.0ms`,
    );
  });

  it("hides the mcp server start duration when suppressStartupDurations is true", async () => {
    mockMcpClients(makeFakeMcpClient());
    actions.setSuppressStartupDurations(true);
    setMcps("first");

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
    setMcps("first", "second");

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
    setMcps("first", "second");

    await initMcpState();

    assert.deepStrictEqual(getState().mcp.tools, {
      greet: { description: "says hello" },
    });
  });

  it("prints an error when a client's tools() call fails", async () => {
    mockMcpClients(
      makeFakeMcpClient({ tools: () => Promise.reject(new Error("boom")) }),
    );
    setMcps("first");

    const getCaptured = mockStdout();
    await initMcpState();

    assert.strictEqual(
      stripAnsi(getCaptured()),
      `Starting first mcp server: 
Starting first mcp server: 0.0msFailed to import the tools the first mcp server: boom
`,
    );
  });
});
