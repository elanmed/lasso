import assert from "node:assert";
import { Output, type ModelMessage } from "ai";
import { z } from "zod";
import { actions, getState, promptDeps } from "./state.ts";

import {
  isAbortError,
  tryCatchAsync,
  getMessageFromError,
  safeStringify,
  strToApproxTokens,
  approxTokensToCharLen,
  decimalToPercent,
} from "./utils.ts";
import { createToolCallDiffer } from "./differ.ts";
import { getUnicodeChar } from "./text.ts";
import { print, startLoadingState, stopLoadingState } from "./print.ts";
import {
  appendModelUsage,
  getApproxPromptTokens,
  getCurrentPromptTokens,
  getPromptOverheadTokensApprox,
  orApproxTokens,
} from "./usage.ts";
import {
  getTools,
  toolPrint,
  bashToolInputSchema,
  webFetchToolSchema,
  loadSkillToolSchema,
  createSubagentToolSchema,
} from "./tools.ts";
import { MISSING } from "./missing.ts";
import type { ModelSummary } from "./state.ts";
import { aiDeps } from "./deps.ts";
import { prependToChatHistory } from "./log.ts";
import { getLanguageModel } from "./model.ts";
import { resolveInterruptWithEditor } from "./input.ts";

const compactTriggerRatio = 0.8;
const compactTargetRatio = 0.3;
const dedicatedSummaryRatio = 0.5;
const dedicatedPromptOverheadRatio =
  compactTriggerRatio - dedicatedSummaryRatio;
const maxNumberSummaries = 5;
const maxRatioPerSummary = dedicatedSummaryRatio / maxNumberSummaries;

function getApiStreamAbortSignal() {
  const controller = getState().abortControllers.apiStream;
  assert(controller !== null);
  return controller.signal;
}

export async function resolveApiCall(userInput: string) {
  const toolCallDiffer = createToolCallDiffer();

  const userMessage: ModelMessage = {
    role: "user",
    content: userInput,
  };

  const systemContent = promptDeps.getSystemContent();

  actions.appendToConversation(userMessage);

  actions.resetToolEditDiffs();
  actions.setApiStartTime();
  actions.setApiStreamAbortController(new AbortController());
  startLoadingState();
  const generateTextResult = await tryCatchAsync(
    aiDeps.generateText({
      model: getLanguageModel(getState().config.model),
      reasoning: getState().config.reasoning,
      instructions: systemContent,
      messages: [...getState().app.conversation.messages],
      tools: getTools(),
      stopWhen: aiDeps.isLoopFinished(),
      abortSignal: getApiStreamAbortSignal(),
      onToolExecutionStart: ({ toolCall }) => {
        switch (toolCall.toolName) {
          case "bash": {
            const input = bashToolInputSchema.parse(toolCall.input);
            toolPrint("bash", input.command);
            if (input.fileSystemAccessType === "create-update-delete") {
              toolCallDiffer.setTempFileBefore(
                toolCall.toolCallId,
                input.filePath,
              );
            }
            break;
          }
          case "web_fetch_html": {
            const input = webFetchToolSchema.parse(toolCall.input);
            toolPrint("web_fetch_html", input.href);
            break;
          }
          case "web_fetch_json": {
            const input = webFetchToolSchema.parse(toolCall.input);
            toolPrint("web_fetch_json", input.href);
            break;
          }
          case "load_skill": {
            const input = loadSkillToolSchema.parse(toolCall.input);
            toolPrint("load_skill", input.name);
            break;
          }
          case "create_subagent": {
            const input = createSubagentToolSchema.parse(toolCall.input);
            for (const task of input.tasks) {
              toolPrint("   create_subagent", `[${task.model}] ${task.prompt}`);
            }
            break;
          }
          default:
            toolPrint(
              `[mcp] ${toolCall.toolName}`,
              safeStringify(toolCall.input),
            );
        }
      },
      onToolExecutionEnd: async ({ toolCall, toolOutput }) => {
        if (toolCall.toolName !== "bash") return;
        const success = toolOutput.type === "tool-result";

        const bashSchemaResult = bashToolInputSchema.parse(toolCall.input);
        if (bashSchemaResult.fileSystemAccessType === "create-update-delete") {
          if (!success) {
            toolCallDiffer.cleanupTempFileBefore(toolCall.toolCallId);
            return;
          }
          await toolCallDiffer.diffAndCleanup(
            toolCall.toolCallId,
            bashSchemaResult.filePath,
          );
        }
      },
    }),
  );
  stopLoadingState();
  actions.setApiStreamAbortController(null);
  actions.setApiEndTime();

  if (!generateTextResult.ok) {
    toolCallDiffer.cleanupAllTempFileBefore();

    if (isAbortError(generateTextResult.error)) {
      const interruptContent = "[Interrupted before a response was generated]";
      const interruptMessage: ModelMessage = {
        role: "assistant",
        content: interruptContent,
      };

      actions.appendToConversation(interruptMessage);
      actions.setPromptTokensDirty(true);

      if (getState().app.editorInputValue !== null) {
        await resolveInterruptWithEditor();
      }
      return null;
    }

    print.error(getMessageFromError(generateTextResult.error));
    return null;
  }

  const { usage, text, responseMessages } = generateTextResult.value;

  await appendModelUsage(usage);

  const inputTokens = usage.inputTokens ?? getApproxPromptTokens();
  const outputTokens = orApproxTokens(usage.outputTokens, text);

  actions.setPromptTokens(inputTokens + outputTokens);
  actions.setPromptTokensDirty(false);

  for (const message of responseMessages) {
    actions.appendToConversation(message);
  }
  prependToChatHistory(text, "assistant");

  return text;
}

export async function getMergedSummaries() {
  const { summaries } = getState().app.conversation;
  if (summaries.length < maxNumberSummaries) {
    return getState().app.conversation.summaries;
  }

  let smallestSecondSummaryIdx = -1;
  let smallestFirstSummaryIdx = -1;

  let smallestSummaryCompactedAt = Infinity;
  for (let idx = 0; idx < summaries.length - 1; idx++) {
    const firstSummary = summaries[idx];
    assert(
      firstSummary !== undefined,
      "Guaranteed by `idx < summaries.length - 1`",
    );

    const secondSummary = summaries[idx + 1];
    assert(
      secondSummary !== undefined,
      "Guaranteed by `idx < summaries.length - 1`",
    );

    const largerCompactedAt = Math.max(
      firstSummary.compactedAt,
      secondSummary.compactedAt,
    );
    if (largerCompactedAt < smallestSummaryCompactedAt) {
      smallestSummaryCompactedAt = largerCompactedAt;
      smallestFirstSummaryIdx = idx;
      smallestSecondSummaryIdx = idx + 1;
    }
  }

  const firstSummary = summaries[smallestFirstSummaryIdx];
  assert(firstSummary !== undefined, "Guaranteed by loop");

  const secondSummary = summaries[smallestSecondSummaryIdx];
  assert(secondSummary !== undefined, "Guaranteed by loop");

  const { model } = getState().config;
  assert(model !== MISSING, "Early return in `maybeCompact`");

  const contextWindow = getState().config.contextWindowPerModel[model];
  assert(contextWindow !== undefined, "Early return in `maybeCompact`");

  const targetTokens = Math.floor(maxRatioPerSummary * contextWindow);
  const targetCharLen = approxTokensToCharLen(targetTokens);

  const compactPrompt = `Merge the following two summaries into one. Output a maximum of ${String(targetCharLen)} characters:
${JSON.stringify([firstSummary, secondSummary].map(({ compacted }) => compacted))}
`;

  const structuredOutputOpts = (() => {
    if (getState().config.compactWithStructuredOutput) {
      return {
        output: Output.object({
          schema: z.object({
            compacted: z.string().max(targetCharLen),
          }),
        }),
      };
    }
    return {};
  })();

  actions.setApiStreamAbortController(new AbortController());
  startLoadingState();
  const generateTextResult = await tryCatchAsync(
    aiDeps.generateText({
      model: getLanguageModel(model),
      messages: [{ content: compactPrompt, role: "user" }],
      stopWhen: aiDeps.isLoopFinished(),
      abortSignal: getApiStreamAbortSignal(),
      ...structuredOutputOpts,
    }),
  );
  stopLoadingState();
  actions.setApiStreamAbortController(null);

  if (!generateTextResult.ok) {
    if (isAbortError(generateTextResult.error)) {
      if (getState().app.editorInputValue !== null) {
        await resolveInterruptWithEditor();
      }
      return getState().app.conversation.summaries;
    }

    print.error(getMessageFromError(generateTextResult.error));
    return getState().app.conversation.summaries;
  }

  const { usage, output, text } = generateTextResult.value;
  const summaryText = getState().config.compactWithStructuredOutput
    ? output.compacted
    : text;
  await appendModelUsage(usage);

  const mergedSummary: ModelSummary = {
    compacted: summaryText,
    compactedAt: Date.now(),
    tokens: orApproxTokens(usage.outputTokens, summaryText),
  };

  const nextSummaries = summaries
    .slice(0, smallestFirstSummaryIdx)
    .concat(mergedSummary)
    .concat(summaries.slice(smallestSecondSummaryIdx + 1));
  return nextSummaries;
}

export async function getConversationSummary() {
  const { model } = getState().config;
  assert(model !== MISSING);

  const contextWindow = getState().config.contextWindowPerModel[model];
  assert(contextWindow !== undefined);

  const targetTokens = Math.floor(compactTargetRatio * contextWindow);
  const targetCharLen = approxTokensToCharLen(targetTokens);

  // messages[0..summaries.length) are re-appended summaries, one per entry,
  // so everything from summaries.length on is not yet summarized
  const compactPrompt = `Compact the following conversation. Output a maximum of ${String(targetCharLen)} characters:
${JSON.stringify(getState().app.conversation.messages.slice(getState().app.conversation.summaries.length))}
`;
  // messages[0..summaries.length) are re-appended summaries, one per entry,
  // so everything from summaries.length on is not yet summarized

  const structuredOutputOpts = (() => {
    if (getState().config.compactWithStructuredOutput) {
      return {
        output: Output.object({
          schema: z.object({
            compacted: z.string().max(targetCharLen),
          }),
        }),
      };
    }
    return {};
  })();

  // TODO (not you ai): make a small helper around generateText
  actions.setApiStreamAbortController(new AbortController());
  startLoadingState();
  const generateTextResult = await tryCatchAsync(
    aiDeps.generateText({
      model: getLanguageModel(getState().config.model),
      messages: [{ content: compactPrompt, role: "user" }],
      stopWhen: aiDeps.isLoopFinished(),
      abortSignal: getApiStreamAbortSignal(),
      ...structuredOutputOpts,
    }),
  );
  stopLoadingState();
  actions.setApiStreamAbortController(null);

  if (!generateTextResult.ok) {
    if (isAbortError(generateTextResult.error)) {
      if (getState().app.editorInputValue !== null) {
        await resolveInterruptWithEditor();
      }
      return null;
    }

    print.error(getMessageFromError(generateTextResult.error));
    return null;
  }

  const { usage, output, text } = generateTextResult.value;
  const summaryText = getState().config.compactWithStructuredOutput
    ? output.compacted
    : text;
  const summary: ModelSummary = {
    compacted: summaryText,
    compactedAt: Date.now(),
    tokens: orApproxTokens(usage.outputTokens, summaryText),
  };
  await appendModelUsage(usage);

  return summary;
}

function applyCompactedConversation(summaries: ModelSummary[]) {
  actions.resetConversation();
  actions.setSummaries(summaries);
  for (const summary of summaries) {
    actions.appendToConversation({
      content: summary.compacted,
      role: "assistant",
    });
  }
}

export async function maybeCompact(userInput: string) {
  const { model } = getState().config;
  if (model === MISSING) return;

  const contextWindow = getState().config.contextWindowPerModel[model];
  if (contextWindow === undefined) return;

  // maybeCompact runs before each api call turn, so we don't know the token
  // count of userInput until after the API call. This can be problematic when the userInput
  // would large enough to trigger compaction, so we approximate for the userInput
  const userInputTokensApprox = strToApproxTokens(userInput);
  const promptOverheadTokensApprox = getPromptOverheadTokensApprox();

  const nextApiTokens = getCurrentPromptTokens() + userInputTokensApprox;

  const currRatio = nextApiTokens / contextWindow;
  if (currRatio <= compactTriggerRatio) return;

  print.doing("Compacting" + getUnicodeChar("…"));

  // If summarizing the message params failed, don't reset the message params
  const conversationSummary = await getConversationSummary();
  if (conversationSummary === null) return;

  // If merging the existing summaries failed, use existing summaries
  const mergedSummaries = await getMergedSummaries();

  applyCompactedConversation([...mergedSummaries, conversationSummary]);

  const summaryTokens = getState()
    .app.conversation.summaries.map(({ tokens }) => tokens)
    .reduce((accum, curr) => accum + curr, 0);
  actions.setPromptTokens(summaryTokens + promptOverheadTokensApprox);
}

export function warnOnLargePromptOverhead() {
  const { model } = getState().config;
  const contextWindow = getState().config.contextWindowPerModel[model];
  if (contextWindow === undefined) return;

  const promptOverheadTokensApprox = getPromptOverheadTokensApprox();

  const promptOverheadRatio = promptOverheadTokensApprox / contextWindow;
  if (promptOverheadRatio >= dedicatedPromptOverheadRatio) {
    print.warning(
      `The current set of context, skills, and tools is ${decimalToPercent(promptOverheadRatio)} of the ${contextWindow.toLocaleString()} token context window!

Lasso reserves ${decimalToPercent(dedicatedSummaryRatio)} of the context window for compacted summaries and ${decimalToPercent(dedicatedPromptOverheadRatio)} for prompt overhead. As is, the prompt overhead may breach the llm's context window and cause API calls to be rejected. Consider converting some of your context to skills and minimizing MCP servers.`,
    );
  }
}
