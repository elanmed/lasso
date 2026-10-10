import { Output, type ModelMessage } from "ai";
import { z } from "zod";
import { assertAtBuildtime } from "./assert.ts";
import { actions, getState, promptDeps } from "./state.ts";
import {
  isAbortError,
  tryCatchAsync,
  getMessageFromError,
  safeStringify,
  strToApproxTokens,
  markdownFence,
  removeMediaReplacer,
} from "./utils.ts";
import { createToolCallDiffer } from "./differ.ts";
import { getUnicodeChar } from "./text.ts";
import { print, startLoadingState, stopLoadingState } from "./print.ts";
import {
  getConversationSummaryPrompt,
  getMergeSummariesPrompt,
} from "./prompts.ts";
import {
  appendModelUsage,
  getApproxPromptTokens,
  getCurrentPromptTokens,
  getPromptOverheadTokensApprox,
  compactTriggerRatio,
  orApproxTokens,
  getMaxNumberSummaries,
  maxCharCountPerSummary,
  defaultContextWindow,
} from "./usage.ts";
import {
  getBaseAgentTools,
  toolPrint,
  baseTimeoutSettings,
  bashToolInputSchema,
  webFetchToolSchema,
  loadSkillToolSchema,
  createSubagentToolSchema,
  mcpListResourcesSchema,
  mcpReadResourceSchema,
  readImageSchema,
} from "./tools.ts";
import { MISSING } from "./missing.ts";
import type { ModelSummary } from "./state.ts";
import { aiDeps } from "./deps.ts";
import { getLanguageModel } from "./model.ts";
import { resolveInterruptWithEditor } from "./input.ts";
import {
  getAppendedConversationMessages,
  getAppendedTranscript,
  syncSessionFile,
} from "./log.ts";

function getApiStreamAbortSignal() {
  const controller = getState().abortControllers.apiStream;
  assertAtBuildtime(controller !== null);
  return controller.signal;
}

export async function resolveApiCall(userInput: string) {
  const toolCallDiffer = createToolCallDiffer();

  const userMessage: ModelMessage = {
    role: "user",
    content: userInput,
  };

  const systemContent = promptDeps.getSystemContent();

  await syncSessionFile({
    messages: getAppendedConversationMessages(userMessage),
  });

  actions.resetToolEditDiffs();
  actions.setApiStartTime();
  actions.setApiStreamAbortController(new AbortController());
  startLoadingState();
  const generateTextResult = await tryCatchAsync(
    aiDeps.generateText({
      model: getLanguageModel(getState().config.model),
      reasoning: getState().config.reasoning,
      instructions: systemContent,
      messages: [...getState().conversation.messages] as ModelMessage[],
      tools: getBaseAgentTools(),
      stopWhen: aiDeps.isLoopFinished(),
      abortSignal: getApiStreamAbortSignal(),
      timeout: baseTimeoutSettings,
      onToolExecutionStart: async ({ toolCall }) => {
        switch (toolCall.toolName) {
          case "bash": {
            const input = bashToolInputSchema.parse(toolCall.input);
            toolPrint("bash", input.command);
            if (input.fileSystemAccessType === "create-update-delete") {
              await toolCallDiffer.setTempFileBefore(
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
          case "mcp_list_resources": {
            const input = mcpListResourcesSchema.parse(toolCall.input);
            toolPrint("mcp_list_resources", input.server);
            break;
          }
          case "mcp_read_resource": {
            const input = mcpReadResourceSchema.parse(toolCall.input);
            toolPrint("mcp_read_resource", `${input.server} ${input.uri}`);
            break;
          }
          case "load_skill": {
            const input = loadSkillToolSchema.parse(toolCall.input);
            toolPrint("load_skill", input.name);
            break;
          }
          case "read_image": {
            const input = readImageSchema.parse(toolCall.input);
            toolPrint("read_image", input.filePath);
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
            await toolCallDiffer.cleanupTempFileBefore(toolCall.toolCallId);
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
    actions.setPromptTokensDirty(true);
    await toolCallDiffer.cleanupAllTempFileBefore();

    if (isAbortError(generateTextResult.error)) {
      const interruptContent = "[Interrupted before a response was generated]";
      const interruptMessage: ModelMessage = {
        role: "assistant",
        content: interruptContent,
      };

      await syncSessionFile({
        messages: getAppendedConversationMessages(interruptMessage),
      });

      if (getState().terminal.editorInputValue !== null) {
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

  await syncSessionFile({
    transcript: getAppendedTranscript({
      message: text,
      role: "assistant",
      timestamp: Date.now(),
    }),
    messages: getAppendedConversationMessages(...responseMessages),
  });

  return text;
}

export async function getMergedSummaries() {
  const { summaries } = getState().conversation;
  const maxNumberSummaries = getMaxNumberSummaries();
  assertAtBuildtime(maxNumberSummaries !== null);

  if (summaries.length < maxNumberSummaries) {
    return getState().conversation.summaries;
  }

  let smallestSecondSummaryIdx = -1;
  let smallestFirstSummaryIdx = -1;

  let smallestSummaryCompactedAt = Infinity;
  for (let idx = 0; idx < summaries.length - 1; idx++) {
    const firstSummary = summaries[idx];
    assertAtBuildtime(firstSummary !== undefined);

    const secondSummary = summaries[idx + 1];
    assertAtBuildtime(secondSummary !== undefined);

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
  assertAtBuildtime(firstSummary !== undefined);

  const secondSummary = summaries[smallestSecondSummaryIdx];
  assertAtBuildtime(secondSummary !== undefined);

  const { model } = getState().config;
  assertAtBuildtime(model !== MISSING);

  const compactPrompt = getMergeSummariesPrompt({
    targetCharLen: maxCharCountPerSummary,
    summaries: markdownFence(
      "json",
      JSON.stringify(
        [firstSummary, secondSummary].map(({ compacted }) => compacted),
      ),
    ),
  });

  const structuredOutputOpts = (() => {
    if (getState().config.compactWithStructuredOutput) {
      return {
        output: Output.object({
          schema: z.object({
            compacted: z.string().max(maxCharCountPerSummary),
          }),
        }),
      };
    }
    return {};
  })();

  startLoadingState();
  const generateTextResult = await tryCatchAsync(
    aiDeps.generateText({
      model: getLanguageModel(model),
      messages: [{ content: compactPrompt, role: "user" }],
      stopWhen: aiDeps.isLoopFinished(),
      abortSignal: getApiStreamAbortSignal(),
      timeout: baseTimeoutSettings,
      ...structuredOutputOpts,
    }),
  );
  stopLoadingState();

  if (!generateTextResult.ok) {
    if (isAbortError(generateTextResult.error)) {
      if (getState().terminal.editorInputValue !== null) {
        await resolveInterruptWithEditor();
      }
      return getState().conversation.summaries;
    }

    print.error(getMessageFromError(generateTextResult.error));
    return getState().conversation.summaries;
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
  assertAtBuildtime(model !== MISSING);

  // messages[0..summaries.length) are re-appended summaries, one per entry,
  // so everything from summaries.length on is not yet summarized
  const compactPrompt = getConversationSummaryPrompt({
    targetCharLen: maxCharCountPerSummary,
    conversation: markdownFence(
      "json",
      JSON.stringify(
        getState().conversation.messages.slice(
          getState().conversation.summaries.length,
        ),
        removeMediaReplacer,
      ),
    ),
  });

  // messages[0..summaries.length) are re-appended summaries, one per entry,
  // so everything from summaries.length on is not yet summarized

  const structuredOutputOpts = (() => {
    if (getState().config.compactWithStructuredOutput) {
      return {
        output: Output.object({
          schema: z.object({
            compacted: z.string().max(maxCharCountPerSummary),
          }),
        }),
      };
    }
    return {};
  })();

  startLoadingState();
  const generateTextResult = await tryCatchAsync(
    aiDeps.generateText({
      model: getLanguageModel(getState().config.model),
      messages: [{ content: compactPrompt, role: "user" }],
      stopWhen: aiDeps.isLoopFinished(),
      abortSignal: getApiStreamAbortSignal(),
      timeout: baseTimeoutSettings,
      ...structuredOutputOpts,
    }),
  );
  stopLoadingState();

  if (!generateTextResult.ok) {
    if (isAbortError(generateTextResult.error)) {
      if (getState().terminal.editorInputValue !== null) {
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

async function applyCompactedConversation(summaries: ModelSummary[]) {
  await syncSessionFile({
    messages: summaries.map(({ compacted }) => ({
      content: compacted,
      role: "assistant",
    })),
    summaries: summaries,
  });
}

export async function maybeCompact(userInput: string) {
  const { model } = getState().config;
  if (model === MISSING) return;

  const contextWindow =
    getState().config.contextWindowPerModel[model] ?? defaultContextWindow;

  // maybeCompact runs before each api call turn, so we don't know the token
  // count of userInput until after the API call. This can be problematic when the userInput
  // would large enough to trigger compaction, so we approximate for the userInput
  const userInputTokensApprox = strToApproxTokens(userInput);
  const promptOverheadTokensApprox = getPromptOverheadTokensApprox();

  const nextApiTokens = getCurrentPromptTokens() + userInputTokensApprox;

  const currRatio = nextApiTokens / contextWindow;
  if (currRatio <= compactTriggerRatio) return;

  print.doing("Compacting" + getUnicodeChar("…"));

  actions.setApiStreamAbortController(new AbortController());
  // If summarizing the message params failed, don't reset the message params
  const conversationSummary = await getConversationSummary();
  if (conversationSummary === null) {
    actions.setApiStreamAbortController(null);
    return;
  }

  // If merging the existing summaries failed, use existing summaries
  const mergedSummaries = await getMergedSummaries();
  actions.setApiStreamAbortController(null);

  await applyCompactedConversation([...mergedSummaries, conversationSummary]);

  const summaryTokens = getState()
    .conversation.summaries.map(({ tokens }) => tokens)
    .reduce((accum, curr) => accum + curr, 0);
  actions.setPromptTokens(summaryTokens + promptOverheadTokensApprox);
  actions.setPromptTokensDirty(false);
}
