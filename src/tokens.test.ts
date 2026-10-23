import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { stringifyTools } from "./tools.ts";
import {
  getSystemContent,
  getToolsContentStr,
  getApproxPromptTokens,
  getCurrentPromptTokens,
  getMaxNumberSummaries,
  getPrettyTokensByArea,
  getPromptOverheadTokensApprox,
  getTokensByArea,
  printLargeContextOverheadWarning,
  getApproxTokensFromMessages,
  getPrettyContextWindowUsage,
  strToApproxTokens,
  formatTokenCountAside,
  formatTokenRangeAside,
  approxTokensToCharLen,
  orApproxTokens,
} from "./tokens.ts";
import { actions, getState } from "./state.ts";
import { processDeps } from "./deps.ts";
import { getBaseAgentPrompt } from "./prompts.ts";
import {
  setupTestContext,
  mockStdoutWrites,
  RESET,
  YELLOW,
} from "./test-helpers.ts";

describe("token utilities", () => {
  it("approximates tokens by splitting character length by 3", () => {
    assert.deepStrictEqual(
      [
        strToApproxTokens(""),
        strToApproxTokens("abc"),
        strToApproxTokens("abcdef"),
        strToApproxTokens("abcdefg"),
      ],
      [0, 1, 2, 2],
    );
  });

  it("formats token counts and ranges", () => {
    assert.deepStrictEqual(
      [formatTokenCountAside("abc"), formatTokenRangeAside("abc", "abcdef")],
      ["_(1 tokens)_", "_(1-2 tokens)_"],
    );
  });

  it("converts approximate token counts to character lengths", () => {
    assert.deepStrictEqual(
      [
        approxTokensToCharLen(0),
        approxTokensToCharLen(1),
        approxTokensToCharLen(250),
      ],
      [0, 3, 750],
    );
  });

  it("prefers supplied token usage over the approximation", () => {
    assert.deepStrictEqual(
      [orApproxTokens(7, "one two three"), orApproxTokens(undefined, "abcdef")],
      [7, 2],
    );
  });
});

describe("state", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext({ model: null, sdkProvider: null });
  });

  describe("system content", () => {
    it("getSystemContent joins prompt, context, and skills with blank lines", () => {
      actions.content.setContextStr("ctx body");
      actions.content.setSkillsStr("skills body");
      assert.strictEqual(
        getSystemContent(),
        `${getBaseAgentPrompt({})}

ctx body

skills body`,
      );
    });

    it("getToolsContentStr returns the stringified tools", () => {
      assert.strictEqual(getToolsContentStr(), stringifyTools());
    });
  });
});

describe("getPromptOverheadTokensApprox", () => {
  beforeEach(() => {
    setupTestContext();
    actions.content.setContextStr("abc");
  });

  it("sums the approx of system content and tools", () => {
    assert.strictEqual(getPromptOverheadTokensApprox(), 1961);
  });

  it("takes tools into account when computing the prompt overhead approx", () => {
    assert.strictEqual(getApproxPromptTokens(), 1961);
  });
});

describe("getApproxPromptTokens", () => {
  beforeEach(() => {
    setupTestContext();
    actions.content.setContextStr("abc");
  });

  it("sums messages approx with the system instructions approx", () => {
    actions.conversation.setMessages([{ role: "user", content: "hello" }]);
    assert.strictEqual(getApproxPromptTokens(), 1972);
  });
});

describe("getCurrentPromptTokens", () => {
  beforeEach(() => {
    setupTestContext();
    actions.content.setContextStr("abc");
  });

  it("returns the cached prompt tokens when not stale", () => {
    actions.usage.setPromptTokens(50);
    actions.usage.setPromptTokensStale(false);
    assert.strictEqual(getCurrentPromptTokens(), 50);
  });

  it("starts with the token cache marked stale", () => {
    assert.strictEqual(getState().usage.promptTokens.stale, true);
  });

  it("returns the approx prompt tokens when stale", () => {
    actions.usage.setPromptTokens(50);
    actions.usage.setPromptTokensStale(true);
    assert.strictEqual(getCurrentPromptTokens(), 1961);
  });
});

describe("getTokensByArea", () => {
  beforeEach(() => {
    setupTestContext();
    actions.content.setContextStr("123456789");
    actions.content.setSkillsStr("1234");
    actions.conversation.setMessages([{ role: "user", content: "hello" }]);
  });

  it("returns the approx areas when the token cache is stale", () => {
    actions.usage.setPromptTokensStale(true);
    assert.deepStrictEqual(getTokensByArea(), {
      messages: 11,
      context: 3,
      tools: 1106,
      basePrompt: 853,
      skills: 1,
    });
  });

  it("returns the approx areas when the cached token count is zero", () => {
    actions.usage.setPromptTokensStale(false);
    assert.deepStrictEqual(getTokensByArea(), {
      messages: 11,
      context: 3,
      tools: 1106,
      basePrompt: 853,
      skills: 1,
    });
  });

  it("scales the areas to the cached token count when clean", () => {
    actions.usage.setPromptTokens(1500);
    actions.usage.setPromptTokensStale(false);
    assert.deepStrictEqual(getTokensByArea(), {
      messages: 8.354430379746836,
      context: 2.278481012658228,
      tools: 840,
      basePrompt: 647.8481012658228,
      skills: 0.759493670886076,
    });
  });
});

describe("getPrettyTokensByArea", () => {
  beforeEach(() => {
    setupTestContext();
    actions.content.setContextStr("123456789");
    actions.content.setSkillsStr("1234");
    actions.conversation.setMessages([{ role: "user", content: "hello" }]);
  });

  it("returns each area with its approx count when the cache is stale", () => {
    actions.usage.setPromptTokensStale(true);
    assert.strictEqual(
      getPrettyTokensByArea(),
      `- Chat messages: 11
- Context files: 3
- Harness and MCP tools: 1,106
- Base system prompt: 853
- Skill descriptions: 1`,
    );
  });

  it("returns each area scaled to the cached token count when clean", () => {
    actions.usage.setPromptTokens(1500);
    actions.usage.setPromptTokensStale(false);
    assert.strictEqual(
      getPrettyTokensByArea(),
      `- Chat messages: 8
- Context files: 2
- Harness and MCP tools: 840
- Base system prompt: 648
- Skill descriptions: 1`,
    );
  });
});

describe("printLargeContextOverheadWarning", () => {
  beforeEach(() => {
    setupTestContext({ model: "gpt-4" });
    actions.config.setContextWindowPerModel({ "gpt-4": 100_000 });
  });

  it("returns early without a warning when the model has no context window", () => {
    actions.config.setContextWindowPerModel({});
    const getWrites = mockStdoutWrites();
    printLargeContextOverheadWarning();
    assert.deepStrictEqual(getWrites(), []);
  });

  it("does not warn when prompt overhead is below the dedicated share", () => {
    actions.content.setContextStr("s".repeat(30_000));
    const getWrites = mockStdoutWrites();
    printLargeContextOverheadWarning();
    assert.deepStrictEqual(getWrites(), []);
  });

  it("warns when prompt overhead reaches the dedicated share", () => {
    actions.content.setContextStr("s".repeat(210_000));
    const getWrites = mockStdoutWrites();
    printLargeContextOverheadWarning();
    assert.deepStrictEqual(getWrites(), [
      `${YELLOW}The current set of context, skills, and tools is 71.96% of the 100,000 token context window!\n\nLasso reserves 25% of the context window for compacted summaries with the assumption that at most 70% of the context window will be used for prompt overhead. As is, the prompt overhead is large enough to break this assumption and, along with any user messages, may breach the llm's context window and cause API calls to be rejected. Consider converting some of your context to skills and minimizing MCP servers.${RESET}\n`,
    ]);
  });
});

describe("getMaxNumberSummaries", () => {
  beforeEach(() => {
    setupTestContext({ model: null });
  });

  it("uses the default context window when the model is missing", () => {
    const result = getMaxNumberSummaries();
    assert.strictEqual(result, 6);
  });

  it("uses the configured context window", () => {
    actions.config.setModel("test-model");
    actions.config.setContextWindowPerModel({ "test-model": 100_000 });
    const result = getMaxNumberSummaries();
    assert.strictEqual(result, 5);
  });

  it("falls back to the default context window", () => {
    actions.config.setModel("test-model");
    const result = getMaxNumberSummaries();
    assert.strictEqual(result, 6);
  });
});

describe("getApproxTokensFromMessages", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  it("does not count base64 image data in tool results", () => {
    const makeMessages = (data: string) => [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read_image",
            output: {
              type: "content",
              value: [
                {
                  type: "file",
                  data: { type: "data", data: data },
                  mediaType: "image/png",
                },
              ],
            },
          },
        ],
      },
    ];
    assert.strictEqual(
      getApproxTokensFromMessages(makeMessages("A".repeat(100_000))),
      getApproxTokensFromMessages(makeMessages("B")),
    );
  });
});

describe("getPrettyContextWindowUsage", () => {
  beforeEach(() => {
    setupTestContext();
  });

  describe("calculates the percentage", () => {
    it("falls back to the default context window when the model has none configured", () => {
      actions.config.setModel("unknown-model");
      actions.usage.setPromptTokens(1_280);
      actions.usage.setPromptTokensStale(false);
      const result = getPrettyContextWindowUsage();
      assert.strictEqual(result, "1% of context window");
    });

    it("returns 0% when no tokens are used", () => {
      actions.config.setModel("test-model");
      actions.config.setContextWindowPerModel({ "test-model": 10_000 });
      const result = getPrettyContextWindowUsage();
      assert.strictEqual(result, "19.6% of context window");
    });

    it("returns the percent of the context window used", () => {
      actions.config.setModel("test-model");
      actions.config.setContextWindowPerModel({ "test-model": 10_000 });
      actions.conversation.setMessages([{ role: "user", content: "hi" }]);
      actions.usage.setPromptTokens(5_000);
      actions.usage.setPromptTokensStale(false);
      const result = getPrettyContextWindowUsage();
      assert.strictEqual(result, "50% of context window");
    });

    it("rounds partial percents to 3 decimal places", () => {
      actions.config.setModel("test-model");
      actions.config.setContextWindowPerModel({ "test-model": 10_000 });
      actions.conversation.setMessages([{ role: "user", content: "hi" }]);
      actions.usage.setPromptTokens(1_666);
      actions.usage.setPromptTokensStale(false);
      const result = getPrettyContextWindowUsage();
      assert.strictEqual(result, "16.66% of context window");
    });

    it("returns percents above 100", () => {
      actions.config.setModel("test-model");
      actions.config.setContextWindowPerModel({ "test-model": 10_000 });
      actions.conversation.setMessages([{ role: "user", content: "hi" }]);
      actions.usage.setPromptTokens(15_000);
      actions.usage.setPromptTokensStale(false);
      const result = getPrettyContextWindowUsage();
      assert.strictEqual(result, "150% of context window");
    });
  });

  describe("token counts", () => {
    it("uses approximated message tokens when tokens are stale", () => {
      actions.config.setModel("test-model");
      actions.config.setContextWindowPerModel({ "test-model": 10_000 });
      actions.conversation.setMessages([{ role: "user", content: "hihoho" }]);
      actions.usage.setPromptTokens(5_000);
      actions.usage.setPromptTokensStale(true);
      const result = getPrettyContextWindowUsage();
      assert.strictEqual(result, "19.72% of context window");
    });

    it("uses the stored token count when tokens are not stale", () => {
      actions.config.setModel("test-model");
      actions.config.setContextWindowPerModel({ "test-model": 10_000 });
      actions.conversation.setMessages([{ role: "user", content: "hihoho" }]);
      actions.usage.setPromptTokens(5_000);
      actions.usage.setPromptTokensStale(false);
      const result = getPrettyContextWindowUsage();
      assert.strictEqual(result, "50% of context window");
    });
  });

  it("ignores terminal width", () => {
    mock.method(processDeps.stdout, "getColumns", () => 79);
    actions.config.setModel("test-model");
    actions.config.setContextWindowPerModel({ "test-model": 10_000 });
    const result = getPrettyContextWindowUsage();
    assert.strictEqual(result, "19.6% of context window");
  });
});
