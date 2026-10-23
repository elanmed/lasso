import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { initMcpState, printMcps } from "./mcp.ts";
import { actions, getState } from "./state.ts";
import {
  setupTestContext,
  mockStdoutWrites,
  BLUE,
  RESET,
  makeFakeMcpClient,
  makeStartupPerformanceLogger,
  CLEAR_LINE,
  CR,
  DOWN_1,
  DOWN_2,
  GREEN,
  UP_1,
  UP_2,
  makeFakeMcpToolSet,
  mockMcpClients,
  setMcpClients,
  setMcps,
  testFs,
  YELLOW,
} from "./test-helpers.ts";

describe("mcp", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  it("sets clients and tools", () => {
    const firstClient = makeFakeMcpClient();
    const secondClient = makeFakeMcpClient();
    const clients = { first: firstClient, second: secondClient };
    const tools = makeFakeMcpToolSet({});

    setMcpClients({ clients, tools });

    assert.strictEqual(getState().mcp.clients, clients);
    assert.strictEqual(getState().mcp.tools, tools);
  });

  describe("initMcpState", () => {
    it("closes existing clients and resets MCP state", async () => {
      const closeFirst = mock.fn(() => undefined);
      const closeSecond = mock.fn(() => undefined);
      const firstClient = makeFakeMcpClient({ close: closeFirst });
      const secondClient = makeFakeMcpClient({ close: closeSecond });
      setMcpClients({ clients: { first: firstClient, second: secondClient } });

      const performanceLogger = makeStartupPerformanceLogger();
      await initMcpState({ performanceLogger });

      assert.equal(closeFirst.mock.callCount(), 1);
      assert.equal(closeSecond.mock.callCount(), 1);
      assert.deepStrictEqual(getState().mcp.clients, {});
      assert.deepStrictEqual(getState().mcp.tools, {});
    });

    it("ignores MCP clients that fail during initialization", async () => {
      mockMcpClients(new Error("connection refused"));
      setMcps("first", "second");

      const performanceLogger = makeStartupPerformanceLogger();
      await initMcpState({ performanceLogger });

      assert.deepStrictEqual(getState().mcp.clients, {});
      assert.deepStrictEqual(getState().mcp.tools, {});
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

      const performanceLogger = makeStartupPerformanceLogger();
      await initMcpState({ performanceLogger });

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
      const tools = makeFakeMcpToolSet({
        greet: { description: "says hello" },
      });
      const firstClient = makeFakeMcpClient({
        tools: () => Promise.reject(new Error("boom")),
      });
      const secondClient = makeFakeMcpClient({
        tools: () => Promise.resolve(tools),
      });
      mockMcpClients(firstClient, secondClient);
      setMcps("first", "second");

      const performanceLogger = makeStartupPerformanceLogger();
      await initMcpState({ performanceLogger });

      assert.deepStrictEqual(getState().mcp.tools, {
        greet: { description: "says hello" },
      });
    });
  });

  describe("startup printing", () => {
    it("records a warning when a client fails to start", async () => {
      mockMcpClients(new Error("connection refused"));
      setMcps("first");

      const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });
      const performanceLogger = makeStartupPerformanceLogger();
      performanceLogger.printAllLabels();
      await initMcpState({ performanceLogger });

      assert.deepStrictEqual(getWrites(), [
        `${BLUE}Starting first mcp server: ${RESET}\n`,
        `${UP_1}${CLEAR_LINE}${CR}`,
        `${BLUE}Starting first mcp server: ${RESET}`,
        `${GREEN}0.0ms${RESET}`,
        `${DOWN_1}${CR}`,
      ]);
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "Failed to start the first mcp server, ignoring. Error: connection refused",
      ]);
    });

    it("records a warning for every server that fails to start", async () => {
      mockMcpClients(new Error("first error"), new Error("second error"));
      setMcps("first", "second");

      const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });
      const performanceLogger = makeStartupPerformanceLogger();
      performanceLogger.printAllLabels();
      await initMcpState({ performanceLogger });

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
      ]);
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "Failed to start the first mcp server, ignoring. Error: first error",
        "Failed to start the second mcp server, ignoring. Error: second error",
      ]);
    });

    it("prints the mcp server start duration when suppressStartupDurations is false", async () => {
      mockMcpClients(makeFakeMcpClient());
      setMcps("first");

      const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });
      const performanceLogger = makeStartupPerformanceLogger();
      performanceLogger.printAllLabels();
      await initMcpState({ performanceLogger });

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
      actions.config.setSuppressStartupDurations(true);
      setMcps("first");

      const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });
      const performanceLogger = makeStartupPerformanceLogger();
      await initMcpState({ performanceLogger });

      assert.deepStrictEqual(getWrites(), []);
    });

    it("prints an error when a client's tools() call fails", async () => {
      mockMcpClients(
        makeFakeMcpClient({ tools: () => Promise.reject(new Error("boom")) }),
      );
      setMcps("first");

      const getWrites = mockStdoutWrites({ includeSpinnerFrames: true });
      const performanceLogger = makeStartupPerformanceLogger();
      performanceLogger.printAllLabels();
      await initMcpState({ performanceLogger });

      assert.deepStrictEqual(getWrites(), [
        `${BLUE}Starting first mcp server: ${RESET}\n`,
        `${UP_1}${CLEAR_LINE}${CR}`,
        `${BLUE}Starting first mcp server: ${RESET}`,
        `${GREEN}0.0ms${RESET}`,
        `${DOWN_1}${CR}`,
      ]);
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "Failed to import the tools for the `first` mcp server, ignoring. Error: boom",
      ]);
    });
  });
});

describe("printMcps", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  let getWrites: () => string[];

  beforeEach(() => {
    setupTestContext();
    getWrites = mockStdoutWrites();
  });

  describe("printMcps", () => {
    beforeEach(() => {
      actions.resetState();
      actions.terminal.resetStdout();
    });

    it("prints available MCP servers", () => {
      setMcpClients({
        clients: {
          first: makeFakeMcpClient(),
          second: makeFakeMcpClient(),
        },
      });

      printMcps();

      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${BLUE}Available MCP servers:${RESET}\n`,
        "- first (fake-server v0.0.0)\n",
        "- second (fake-server v0.0.0)\n",
        "\n",
      ]);
    });

    it("prints server name and version when available", () => {
      setMcpClients({
        clients: {
          first: makeFakeMcpClient({
            serverInfo: { name: "my-server", version: "1.2.3" },
          }),
          second: makeFakeMcpClient({
            serverInfo: { name: "other-server", version: "0.1.0" },
            instructions: "Instructions line 1.\nInstructions line 2.",
          }),
        },
      });

      printMcps();

      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${BLUE}Available MCP servers:${RESET}\n`,
        "- first (my-server v1.2.3)\n",
        "- second (other-server v0.1.0)\n",
        "\n",
      ]);
    });

    it("prints that there are no available MCP servers when clients map is empty", () => {
      printMcps();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${YELLOW}No available MCP servers${RESET}\n`,
        "\n",
      ]);
      assert.strictEqual(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
    });

    it("surrounds the message with blank lines when isTyped is false", () => {
      printMcps();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${YELLOW}No available MCP servers${RESET}\n`,
        "\n",
      ]);
    });

    it("adds spacing when streaming", () => {
      actions.abortControllers.setApiStream(new AbortController());
      printMcps();
      assert.deepStrictEqual(getWrites(), [
        "\n",
        `${YELLOW}No available MCP servers${RESET}\n`,
        "\n",
      ]);
    });
  });
});
