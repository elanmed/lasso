import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert";
import { actions, getState } from "./state.ts";
import { initMcpState } from "./mcp.ts";
import {
  executeMcpListResourcesTool,
  executeMcpReadResourceTool,
} from "./tools.ts";
import { stringify } from "./utils.ts";
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
  makeFakeMcpToolSet,
  makeStartupPerformanceLogger,
  mockMcpClients,
  mockStdoutWrites,
  setMcpClients,
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
    const firstClient = makeFakeMcpClient();
    const secondClient = makeFakeMcpClient();
    const clients = { first: firstClient, second: secondClient };
    const tools = makeFakeMcpToolSet({});

    setMcpClients({ clients, tools });

    assert.strictEqual(getState().mcp.clients, clients);
    assert.strictEqual(getState().mcp.tools, tools);
  });

  describe("executeMcpListResourcesTool", () => {
    it("returns the resources of the given server", async () => {
      setMcpClients({
        clients: {
          first: makeFakeMcpClient({
            listResources: () =>
              Promise.resolve({
                resources: [
                  {
                    uri: "file:///a.txt",
                    name: "a",
                    description: "File a",
                    mimeType: "text/plain",
                  },
                ],
                nextCursor: "cursor-2",
              }),
          }),
        },
      });

      const result = await executeMcpListResourcesTool({ server: "first" });

      assert.deepStrictEqual(result, {
        isError: false,
        content: stringify({
          resources: [
            {
              uri: "file:///a.txt",
              name: "a",
              description: "File a",
              mimeType: "text/plain",
            },
          ],
          nextCursor: "cursor-2",
        }),
      });
    });

    it("passes the cursor to the client and returns no next cursor", async () => {
      let capturedCursor: string | undefined;
      const listResources = mock.fn(
        (options?: { params?: { cursor: string } }) => {
          capturedCursor = options?.params?.cursor;
          return Promise.resolve({ resources: [{ uri: "file:///a.txt" }] });
        },
      );
      setMcpClients({
        clients: { first: makeFakeMcpClient({ listResources }) },
      });

      const result = await executeMcpListResourcesTool({
        server: "first",
        cursor: "cursor-1",
      });

      assert.strictEqual(capturedCursor, "cursor-1");
      assert.deepStrictEqual(result, {
        isError: false,
        content: stringify({
          resources: [{ uri: "file:///a.txt" }],
          nextCursor: null,
        }),
      });
    });

    it("returns an error for an unknown server", async () => {
      const result = await executeMcpListResourcesTool({ server: "missing" });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "Unknown mcp server: missing",
      });
    });

    it("returns isError when listing fails", async () => {
      setMcpClients({
        clients: {
          first: makeFakeMcpClient({
            listResources: () => Promise.reject(new Error("boom")),
          }),
        },
      });

      const result = await executeMcpListResourcesTool({ server: "first" });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "boom",
      });
    });
  });

  describe("executeMcpReadResourceTool", () => {
    it("returns the text contents of the given resource", async () => {
      setMcpClients({
        clients: {
          first: makeFakeMcpClient({
            readResource: ({ uri }: { uri: string }) =>
              Promise.resolve({
                contents: [
                  { uri, mimeType: "text/plain", text: "resource text" },
                ],
              }),
          }),
        },
      });

      const result = await executeMcpReadResourceTool({
        server: "first",
        uri: "file:///a.txt",
      });

      assert.deepStrictEqual(result, {
        isError: false,
        content: stringify([
          {
            uri: "file:///a.txt",
            mimeType: "text/plain",
            text: "resource text",
            blob: null,
          },
        ]),
      });
    });

    it("returns blob contents as base64", async () => {
      setMcpClients({
        clients: {
          first: makeFakeMcpClient({
            readResource: () =>
              Promise.resolve({
                contents: [{ uri: "file:///a.png", blob: "aGVsbG8=" }],
              }),
          }),
        },
      });

      const result = await executeMcpReadResourceTool({
        server: "first",
        uri: "file:///a.png",
      });

      assert.deepStrictEqual(result, {
        isError: false,
        content: stringify([
          {
            uri: "file:///a.png",
            mimeType: null,
            text: null,
            blob: "aGVsbG8=",
          },
        ]),
      });
    });

    it("returns an error for an unknown server", async () => {
      const result = await executeMcpReadResourceTool({
        server: "missing",
        uri: "file:///a.txt",
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "Unknown mcp server: missing",
      });
    });

    it("returns isError when reading fails", async () => {
      setMcpClients({
        clients: {
          first: makeFakeMcpClient({
            readResource: () => Promise.reject(new Error("boom")),
          }),
        },
      });

      const result = await executeMcpReadResourceTool({
        server: "first",
        uri: "file:///a.txt",
      });
      assert.deepStrictEqual(result, {
        isError: true,
        content: "boom",
      });
    });
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
    it("prints an error when a client fails to start", async () => {
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
        `${RED}Failed to start the first mcp server: connection refused${RESET}\n`,
      ]);
    });

    it("prints all labels upfront and failure messages after every server settles", async () => {
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
        `${RED}Failed to start the first mcp server: first error${RESET}\n`,
        `${RED}Failed to start the second mcp server: second error${RESET}\n`,
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
      actions.setSuppressStartupDurations(true);
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
        `${RED}Failed to import the tools the first mcp server: boom${RESET}\n`,
      ]);
    });
  });
});
