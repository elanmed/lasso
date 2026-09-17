import assert from "node:assert";
import { Output, type ModelMessage } from "ai";
import { z } from "zod";
import { actions, getState, promptDeps } from "./state.ts";
import {
  isAbortError,
  tryCatchAsync,
  getMessageFromError,
  safeStringify,
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
import { aiDeps } from "./deps.ts";
import { prependToChatHistory } from "./log.ts";
import {
  getApproxTokensFromMessages,
  strToApproxTokens,
  approxTokensToCharLen,
} from "./tokens.ts";
import { getLanguageModel } from "./model.ts";
import { resolveInterruptWithEditor } from "./input.ts";

const compactTriggerRatio = 0.8;
const compactTargetRatio = 0.3;
const dedicatedSummaryRatio = 0.5;
const dedicatedSystemInstructionsRatio =
  compactTriggerRatio - dedicatedSummaryRatio;

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

  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;

  // no need to approximate the system prompt tokens here — inputTokens already includes them
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

export async function maybeCompactMessageParams(userInput: string) {
  const { model } = getState().config;
  if (model === MISSING) return;

  const contextWindow = getState().config.contextWindowPerModel[model];
  if (contextWindow === undefined) return;

  // maybeCompactMessageParams runs before each api call turn, so we don't know the token
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
      return;
    }

    print.error(getMessageFromError(generateTextResult.error));
    return;
  }

  const { usage, output } = generateTextResult.value;
  const { compacted } = output;
  await appendModelUsage(usage);
  const afterCompactionTokens = usage.outputTokens ?? 0;

  actions.resetMessageParams();
  actions.appendToMessageParams({ content: compacted, role: "assistant" });
  actions.setMessageParamTokens(
    afterCompactionTokens + systemInstructionsTokensApprox,
  );
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
