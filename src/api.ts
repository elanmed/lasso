import type { ModelMessage } from "ai";
import { actions, getState, promptDeps } from "./state.ts";
import {
  isAbortError,
  getApproxTokens,
  tryCatchAsync,
  getMessageFromError,
  safeStringify,
} from "./utils.ts";
import { createToolCallDiffer } from "./differ.ts";
import { print, startLoadingState, stopLoadingState } from "./print.ts";
import { appendModelUsage } from "./usage.ts";
import {
  objectWithPathSchema,
  printGitDiff,
  harnessTools,
  type HarnessToolName,
  toolPrint,
} from "./tools.ts";
import assert from "node:assert";
import { MISSING } from "./missing.ts";
import { aiDeps } from "./deps.ts";
import { prependToChatHistory } from "./log.ts";
import { getLanguageModel } from "./model.ts";
import { resolveInterruptWithEditor } from "./input.ts";

function getApiStreamAbortSignal() {
  const controller = getState().abortControllers.apiStream;
  assert(controller !== null);
  return controller.signal;
}

export async function resolveApiCall(userInput: string) {
  const toolCallDiffer = createToolCallDiffer(printGitDiff);

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
      print.error("Interrupted!");
      const interruptContent = "[Interrupted before a response was generated]";
      const interruptMessageParam: ModelMessage = {
        role: "assistant",
        content: interruptContent,
      };

      actions.appendToMessageParams(interruptMessageParam);
      actions.appendToMessageParamTokens(
        getApproxTokens(userInput) + getApproxTokens(interruptContent),
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

function getApproxTokensFromMessages(messages: ModelMessage[]) {
  const textOnly = messages.map((message) => {
    if (typeof message.content === "string") return message;
    return {
      ...message,
      content: message.content.filter(
        (part) => part.type !== "image" && part.type !== "file",
      ),
    };
  });
  return getApproxTokens(JSON.stringify(textOnly));
}

export async function maybeCompactMessageParams(userInput: string) {
  const { model } = getState().config;
  if (model === MISSING) return;

  const contextWindow = getState().config.contextWindowPerModel[model];
  if (contextWindow === undefined) return;

  // maybeCompactMessageParams runs before each api call turn, so we don't know the token
  // count of userInput until after the API call. This can be problematic when the userInput
  // would large enough to trigger compaction, so we approximate for the userInput
  const userInputTokensApprox = getApproxTokens(userInput);
  // the same applies to the system content, which is sent with every api call
  const systemContentTokensApprox = getApproxTokens(
    promptDeps.getSystemContent(),
  );

  const nextApiTokens = (() => {
    if (getState().app.messageParams.tokensStale) {
      return (
        getApproxTokensFromMessages(getState().app.messageParams.messages) +
        userInputTokensApprox +
        systemContentTokensApprox
      );
    } else {
      return getState().app.messageParams.tokens + userInputTokensApprox;
    }
  })();

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
      print.error("Interrupted compaction!");

      if (getState().app.editorInputValue !== null) {
        await resolveInterruptWithEditor();
      }
      return;
    }

    print.error(getMessageFromError(generateTextResult.error));
    return;
  }

  const { usage, text } = generateTextResult.value;
  await appendModelUsage(usage);
  const afterCompactionTokens = usage.outputTokens ?? 0;

  actions.resetMessageParams();
  actions.appendToMessageParams({ content: text, role: "assistant" });
  actions.setMessageParamTokens(
    afterCompactionTokens + systemContentTokensApprox,
  );
  if (afterCompactionTokens >= targetTokens) {
    print.warning(
      `Compacted to ${afterCompactionTokens.toLocaleString()}, ${(afterCompactionTokens - targetTokens).toLocaleString()} over the target.`,
    );
  }
}
