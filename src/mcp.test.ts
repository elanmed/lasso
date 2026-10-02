import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert";
import type { MCPClient } from "@ai-sdk/mcp";
import { actions, getState, type MCPToolSet } from "./state.ts";
import { initMcpState } from "./mcp.ts";
import {
  BLUE,
  CLEAR_LINE,
  CR,
  DOWN_1,
  DOWN_2,
  GREEN,
  RED,
  RESET,
  UP_1,
  UP_2,
  makeFakeMcpClient,
  mockMcpClients,
  mockStdoutWrites,
  setMcps,
  setupTestContext,
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

    const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });
    await initMcpState();

    assert.deepStrictEqual(getWrites(), [
      `${BLUE}Starting first mcp server: ${RESET}\n`,
      `${UP_1}${CLEAR_LINE}${CR}`,
      `${BLUE}Starting first mcp server: ${RESET}`,
      `${GREEN}0.0ms${RESET}`,
      `${DOWN_1}${CR}`,
      `${RED}Failed to start the first mcp server: connection refused${RESET}\n`,
    ]);
  });

  it("prints all labels upfront and failure messages after every server settles", async () => {
    mockMcpClients(new Error("first error"), new Error("second error"));
    setMcps("first", "second");

    const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });
    await initMcpState();

    assert.deepStrictEqual(getWrites(), [
      `${BLUE}Starting first mcp server: ${RESET}\n`,
      `${BLUE}Starting second mcp server: ${RESET}\n`,
      `${UP_2}${CLEAR_LINE}${CR}`,
      `${BLUE}Starting first mcp server: ${RESET}`,
      `${GREEN}0.0ms${RESET}`,
      `${DOWN_2}${CR}`,
      `${UP_1}${CLEAR_LINE}${CR}`,
      `${BLUE}Starting second mcp server: ${RESET}`,
      `${GREEN}0.0ms${RESET}`,
      `${DOWN_1}${CR}`,
      `${RED}Failed to start the first mcp server: first error${RESET}\n`,
      `${RED}Failed to start the second mcp server: second error${RESET}\n`,
    ]);
  });

  it("prints the mcp server start duration when suppressStartupDurations is false", async () => {
    mockMcpClients(makeFakeMcpClient());
    setMcps("first");

    const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });
    await initMcpState();

    assert.deepStrictEqual(getWrites(), [
      `${BLUE}Starting first mcp server: ${RESET}\n`,
      `${UP_1}${CLEAR_LINE}${CR}`,
      `${BLUE}Starting first mcp server: ${RESET}`,
      `${GREEN}0.0ms${RESET}`,
      `${DOWN_1}${CR}`,
    ]);
  });

  it("hides the mcp server start duration when suppressStartupDurations is true", async () => {
    mockMcpClients(makeFakeMcpClient());
    actions.setSuppressStartupDurations(true);
    setMcps("first");

    const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });
    await initMcpState();

    assert.deepStrictEqual(getWrites(), []);
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

    const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });
    await initMcpState();

    assert.deepStrictEqual(getWrites(), [
      `${BLUE}Starting first mcp server: ${RESET}\n`,
      `${UP_1}${CLEAR_LINE}${CR}`,
      `${BLUE}Starting first mcp server: ${RESET}`,
      `${GREEN}0.0ms${RESET}`,
      `${DOWN_1}${CR}`,
      `${RED}Failed to import the tools the first mcp server: boom${RESET}\n`,
    ]);
  });
});
