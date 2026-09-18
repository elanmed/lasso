import assert from "node:assert";
import { Output, type ModelMessage } from "ai";
import { z } from "zod";
import { actions, getState, promptDeps } from "./state.ts";
import {
  isAbortError,
  tryCatchAsync,
  getMessageFromError,
  safeStringify,
  getApproxTokensFromMessages,
  strToApproxTokens,
  approxTokensToCharLen,
  decimalToPercent,
} from "./utils.ts";
import { createToolCallDiffer } from "./differ.ts";
import { getUnicodeChar } from "./text.ts";
import { print, startLoadingState, stopLoadingState } from "./print.ts";
import { appendModelUsage } from "./usage.ts";
import {
  objectWithPathSchema,
  harnessTools,
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

  const inputMessageParam: ModelMessage = {
    role: "user",
    content: userInput,
  };

  const systemContent = promptDeps.getSystemContent();

  actions.appendToMessageParams(inputMessageParam);

  actions.setApiStartTime();
  actions.setApiStreamAbortController(new AbortController());
  startLoadingState();
  const generateTextResult = await tryCatchAsync(
    aiDeps.generateText({
      model: getLanguageModel(getState().config.model),
      reasoning: getState().config.reasoning,
      instructions: systemContent,
      messages: [...getState().app.messageParams.messages],
      tools: { ...harnessTools, ...getState().mcp.tools },
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
      const interruptMessageParam: ModelMessage = {
        role: "assistant",
        content: interruptContent,
      };

      actions.appendToMessageParams(interruptMessageParam);
      actions.appendToMessageParamTokens(
        strToApproxTokens(userInput) + strToApproxTokens(interruptContent),
      );
      actions.setMessageParamTokensStale(true);

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

  const inputTokensApprox =
    getApproxTokensFromMessages(getState().app.messageParams.messages) +
    getSystemInstructionsTokensApprox();
  const inputTokens = usage.inputTokens ?? inputTokensApprox;

  const outputTokens = usage.outputTokens ?? strToApproxTokens(text);

  actions.setMessageParamTokens(inputTokens + outputTokens);
  actions.setMessageParamTokensStale(false);

  for (const message of responseMessages) {
    actions.appendToMessageParams(message);
  }
  prependToChatHistory(text, "assistant");

  return text;
}

export function getSystemInstructionsTokensApprox() {
  const systemContentTokensApprox = strToApproxTokens(
    promptDeps.getSystemContent(),
  );
  const toolsTokensApprox = strToApproxTokens(
    safeStringify({ ...harnessTools, ...getState().mcp.tools }),
  );
  return systemContentTokensApprox + toolsTokensApprox;
}

export async function getMergedSummaries() {
  const { summaries } = getState().app.messageParams;
  if (summaries.length < maxNumberSummaries) {
    return getState().app.messageParams.summaries;
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

  const compactMessageParam = `Merge the following two summaries into one:
${JSON.stringify([firstSummary, secondSummary].map(({ compacted }) => compacted))}
`;

  actions.setApiStreamAbortController(new AbortController());
  startLoadingState();
  const generateTextResult = await tryCatchAsync(
    aiDeps.generateText({
      model: getLanguageModel(model),
      messages: [{ content: compactMessageParam, role: "user" }],
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
      return getState().app.messageParams.summaries;
    }

    print.error(getMessageFromError(generateTextResult.error));
    return getState().app.messageParams.summaries;
  }

  const { output, usage } = generateTextResult.value;
  const { compacted } = output;
  await appendModelUsage(usage);

  const mergedSummary: ModelSummary = {
    compacted,
    compactedAt: Date.now(),
    tokens: usage.outputTokens ?? strToApproxTokens(compacted),
  };

  const nextSummaries = summaries
    .slice(0, smallestFirstSummaryIdx)
    .concat(mergedSummary)
    .concat(summaries.slice(smallestSecondSummaryIdx + 1));
  return nextSummaries;
}

export async function getMessageParamsSummary() {
  const { model } = getState().config;
  assert(model !== MISSING);

  const contextWindow = getState().config.contextWindowPerModel[model];
  assert(contextWindow !== undefined);

  const targetTokens = Math.floor(compactTargetRatio * contextWindow);
  const targetCharLen = approxTokensToCharLen(targetTokens);

  const compactMessageParam = `Compact the following conversation:
${JSON.stringify(getState().app.messageParams.messages)}
`;

  actions.setApiStreamAbortController(new AbortController());
  startLoadingState();
  const generateTextResult = await tryCatchAsync(
    aiDeps.generateText({
      model: getLanguageModel(getState().config.model),
      messages: [{ content: compactMessageParam, role: "user" }],
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
    tokens: usage.outputTokens ?? strToApproxTokens(summaryText),
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
  // the same applies to the system instructions, which is sent with every api call
  const systemInstructionsTokensApprox = getSystemInstructionsTokensApprox();

  const nextApiTokens = (() => {
    if (getState().app.messageParams.tokensStale) {
      return (
        getApproxTokensFromMessages(getState().app.messageParams.messages) +
        userInputTokensApprox +
        systemInstructionsTokensApprox
      );
    } else {
      return getState().app.messageParams.tokens + userInputTokensApprox;
    }
  })();

  const currRatio = nextApiTokens / contextWindow;
  if (currRatio <= compactTriggerRatio) return;

  print.doing("Compacting" + getUnicodeChar("…"));

  // If summarizing the message params failed, don't reset the message params
  const messageParamsSummary = await getMessageParamsSummary();
  if (messageParamsSummary === null) return;

  // If merging the existing summaries failed, use existing summaries
  const mergedSummaries = await getMergedSummaries();

  actions.resetMessageParams();
  actions.setSummaries([...mergedSummaries, messageParamsSummary]);
  for (const summary of getState().app.messageParams.summaries) {
    actions.appendToMessageParams({
      content: summary.compacted,
      role: "assistant",
    });
  }

  const summaryTokens = getState()
    .app.messageParams.summaries.map(({ tokens }) => tokens)
    .reduce((accum, curr) => accum + curr, 0);
  actions.setMessageParamTokens(summaryTokens + systemInstructionsTokensApprox);
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
