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
  getSystemInstructionsTokensApprox,
  orApproxTokens,
} from "./usage.ts";
import {
  objectWithPathSchema,
  harnessTools,
  getTools,
  type HarnessToolName,
  toolPrint,
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
const dedicatedSystemInstructionsRatio =
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
        if (!Object.keys(harnessTools).includes(toolCall.toolName)) {
          toolPrint(
            `[mcp] ${toolCall.toolName}`,
            safeStringify(toolCall.input),
          );
        }

        switch (toolCall.toolName as HarnessToolName) {
          case "create_file": {
            toolCallDiffer.setTempFileBefore(toolCall.toolCallId);
            break;
          }
          case "insert_lines":
          case "str_replace": {
            const { path } = objectWithPathSchema.parse(toolCall.input);
            toolCallDiffer.setTempFileBefore(toolCall.toolCallId, {
              initialContentPath: path,
            });
            break;
          }
        }
      },
      onToolExecutionEnd: async ({ toolCall, toolOutput }) => {
        switch (toolCall.toolName as HarnessToolName) {
          case "create_file":
          case "insert_lines":
          case "str_replace": {
            if (toolOutput.type === "tool-error") {
              toolCallDiffer.cleanupTempFileBefore(toolCall.toolCallId);
              return;
            }

            const { path } = objectWithPathSchema.parse(toolCall.input);
            await toolCallDiffer.diffAndCleanup(toolCall.toolCallId, path);
            break;
          }
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
      actions.appendToPromptTokens(
        strToApproxTokens(userInput) + strToApproxTokens(interruptContent),
      );
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

  // [S1(@1), S2(@2), S3(@3), S4(@4), S5(@5)]

  // [S1(@1), S2(@2), S3(@3), S4(@4), S5(@5), S6(@6)]
  // [M2(@6), S3(@3), S4(@4), S5(@5), S6(@6)]

  // [M2(@6), S3(@3), S4(@4), S5(@5), S6(@6)]
  // [M2(@6), S3(@3), S4(@4), S5(@5), S6(@6), S7(@7)]

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

  const compactPrompt = `Merge the following two summaries into one:
${JSON.stringify([firstSummary, secondSummary].map(({ compacted }) => compacted))}
`;

  actions.setApiStreamAbortController(new AbortController());
  startLoadingState();
  const generateTextResult = await tryCatchAsync(
    aiDeps.generateText({
      model: getLanguageModel(model),
      messages: [{ content: compactPrompt, role: "user" }],
      stopWhen: aiDeps.isLoopFinished(),
      abortSignal: getApiStreamAbortSignal(),
      output: Output.object({
        schema: z.object({
          compacted: z.string().max(targetCharLen),
        }),
      }),
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

  const { output, usage } = generateTextResult.value;
  const { compacted } = output;
  await appendModelUsage(usage);

  const mergedSummary: ModelSummary = {
    compacted,
    compactedAt: Date.now(),
    tokens: orApproxTokens(usage.outputTokens, compacted),
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

  const compactPrompt = `Compact the following conversation:
${JSON.stringify(getState().app.conversation.messages)}
`;

  // TODO (not you ai): more clearly differentiate between different types of tokens
  // TODO (not you ai): make a small helper around generateText
  actions.setApiStreamAbortController(new AbortController());
  startLoadingState();
  const generateTextResult = await tryCatchAsync(
    aiDeps.generateText({
      model: getLanguageModel(getState().config.model),
      messages: [{ content: compactPrompt, role: "user" }],
      stopWhen: aiDeps.isLoopFinished(),
      abortSignal: getApiStreamAbortSignal(),
      output: Output.object({
        schema: z.object({
          compacted: z.string().max(targetCharLen),
        }),
      }),
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

  const { usage, output } = generateTextResult.value;
  const summaryText = output.compacted;
  const summary: ModelSummary = {
    compacted: output.compacted,
    compactedAt: Date.now(),
    tokens: orApproxTokens(usage.outputTokens, summaryText),
  };
  await appendModelUsage(usage);

  return summary;
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
  const systemInstructionsTokensApprox = getSystemInstructionsTokensApprox();

  const nextApiTokens = getCurrentPromptTokens() + userInputTokensApprox;

  const currRatio = nextApiTokens / contextWindow;
  if (currRatio <= compactTriggerRatio) return;

  print.doing("Compacting" + getUnicodeChar("…"));

  // If summarizing the message params failed, don't reset the message params
  const conversationSummary = await getConversationSummary();
  if (conversationSummary === null) return;

  // If merging the existing summaries failed, use existing summaries
  const mergedSummaries = await getMergedSummaries();

  actions.resetConversation();
  actions.setSummaries([...mergedSummaries, conversationSummary]);
  for (const summary of getState().app.conversation.summaries) {
    actions.appendToConversation({
      content: summary.compacted,
      role: "assistant",
    });
  }

  const summaryTokens = getState()
    .app.conversation.summaries.map(({ tokens }) => tokens)
    .reduce((accum, curr) => accum + curr, 0);
  actions.setPromptTokens(summaryTokens + systemInstructionsTokensApprox);
}

export function warnOnLargeSystemInstructions() {
  const { model } = getState().config;
  const contextWindow = getState().config.contextWindowPerModel[model];
  if (contextWindow === undefined) return;

  const systemInstructionsTokensApprox = getSystemInstructionsTokensApprox();

  const systemInstructionsRatio =
    systemInstructionsTokensApprox / contextWindow;
  if (systemInstructionsRatio >= dedicatedSystemInstructionsRatio) {
    print.warning(
      `The current set of context, skills, and tools is ${decimalToPercent(systemInstructionsRatio)} of the ${contextWindow.toLocaleString()} token context window!

Lasso reserves ${decimalToPercent(dedicatedSummaryRatio)} of the context window for compacted summaries and ${decimalToPercent(dedicatedSystemInstructionsRatio)} for system instructions. As is, the system instructions may breach the llm's context window and cause API calls to be rejected. Consider converting some of your context to skills and minimizing MCP servers.`,
    );
  }
}
