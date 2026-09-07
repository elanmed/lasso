import type { ModelMessage } from "ai";
import { actions, getState } from "./state.ts";
import {
  isAbortError,
  tryCatchAsync,
  getMessageFromError,
  createToolCallDiffer,
} from "./utils.ts";
import { print, startLoadingState, stopLoadingState } from "./print.ts";
import { appendModelUsage } from "./usage.ts";
import { BASE_SYSTEM_PROMPT } from "./context.ts";
import { objectWithPathSchema, tools, type ToolName } from "./tools.ts";
import assert from "node:assert";
import { aiDeps, MISSING } from "./deps.ts";
import { appendToChatHistory } from "./log.ts";
import { getLanguageModel } from "./model.ts";

export { getHeaders, getLanguageModel } from "./model.ts";

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

  const systemContent = [
    BASE_SYSTEM_PROMPT,
    getState().app.contextStr,
    getState().app.skillsStr,
  ].join("\n");

  actions.setApiStartTime();
  actions.setApiStreamAbortController(new AbortController());
  startLoadingState();
  const generateTextResult = await tryCatchAsync(
    aiDeps.generateText({
      model: getLanguageModel(getState().config.model),
      system: systemContent,
      messages: [...getState().app.messageParams.messages, inputMessageParam],
      tools,
      stopWhen: aiDeps.isLoopFinished(),
      abortSignal: getApiStreamAbortSignal(),
      experimental_onToolCallStart: ({ toolCall }) => {
        switch (toolCall.toolName as ToolName) {
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
      experimental_onToolCallFinish: async ({ toolCall, success }) => {
        switch (toolCall.toolName as ToolName) {
          case "create_file":
          case "insert_lines":
          case "str_replace": {
            if (!success) {
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
      print.error("Interrupted");
      return null;
    }

    print.error(getMessageFromError(generateTextResult.error));
    return null;
  }

  const { totalUsage, text, response } = generateTextResult.value;

  await appendModelUsage(totalUsage);

  const inputTokens = totalUsage.inputTokens ?? 0;
  const outputTokens = totalUsage.outputTokens ?? 0;

  actions.setMessageParamTokens(inputTokens + outputTokens);
  actions.setMessageParamTokensStale(false);

  actions.appendToMessageParams(inputMessageParam);
  for (const message of response.messages) {
    actions.appendToMessageParams(message);
  }
  appendToChatHistory(text, "assistant");

  return text;
}

export async function maybeCompactMessageParams(userInput: string) {
  const { model } = getState().config;
  if (model === MISSING) return;

  const contextWindow = getState().config.contextWindowPerModel[model];
  if (contextWindow === undefined) return;

  if (getState().app.messageParams.tokensStale) return;

  const userInputTokensApprox = Math.floor(userInput.length / 3);
  const nextApiTokens =
    getState().app.messageParams.tokens + userInputTokensApprox;

  const currRatio = nextApiTokens / contextWindow;
  if (currRatio <= getState().config.compactTriggerRatio) return;
  print.doing("Compacting…");

  const targetTokens = getState().config.compactTargetRatio * contextWindow;

  const compactMessageParam = `Compact the following conversation. Your summary must be less than ${String(targetTokens)} tokens:
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
    }),
  );
  stopLoadingState();
  actions.setApiStreamAbortController(null);

  if (!generateTextResult.ok) {
    if (isAbortError(generateTextResult.error)) {
      print.error("Interrupted compaction");
      return;
    }

    print.error(getMessageFromError(generateTextResult.error));
    return;
  }

  const { totalUsage, text } = generateTextResult.value;
  await appendModelUsage(totalUsage);
  const afterCompactionTokens = totalUsage.outputTokens ?? 0;

  actions.resetMessageParams();
  actions.appendToMessageParams({ content: text, role: "assistant" });
  actions.setMessageParamTokens(afterCompactionTokens);
  if (afterCompactionTokens >= targetTokens) {
    print.warning(
      `Compacted to ${afterCompactionTokens.toLocaleString()}, ${(afterCompactionTokens - targetTokens).toLocaleString()} over the target.`,
    );
  }
}
