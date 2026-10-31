import { join, dirname } from "node:path";
import readline from "node:readline/promises";
import { once } from "node:events";
import { stdin, stdout } from "node:process";
import { Output, type ModelMessage as AiModelMessage } from "ai";
import { z } from "zod";
import {
  assertAtBuildtime,
  isAbortError,
  tryCatchAsync,
  getMessageFromError,
  markdownFence,
  removeMediaReplacer,
  stringify,
  assertAtRuntime,
  tryCatch,
  normalizeNewline,
  getShortId,
  getPrettyDuration,
  parseFrontMatter,
  isReadlineClosedError,
  sleep,
  writeDebugLog,
} from "./utils.ts";
import { actions, getState, type ContextEntry, type Skill } from "./state.ts";
import { aiDeps, childProcessDeps, fsDeps, processDeps } from "./deps.ts";
import {
  getDebugLogDir,
  getGlobalContextDir,
  getGlobalSkillDir,
  getLocalSkillDir,
} from "./paths.ts";
import {
  getConversationSummaryPrompt,
  getMergeSummariesPrompt,
} from "./prompts.ts";
import { maxTokenCountPerSummary, type ModelSummary } from "./schemas.ts";
import {
  getUnicodeChar,
  print,
  createParallelPerformanceLogger,
  printNewline,
  startLoadingState,
  stopLoadingState,
  printSessionStartDate,
  toolPrint,
  streamingSupportedWithSpacing,
  createFencePrint,
} from "./printing.ts";
import type {
  ParallelPerformanceLogger,
  LogIdToLabel,
  SpacingOpts,
} from "./printing.ts";
import {
  interruptContent,
  getAppendedConversationMessages,
  getAppendedTranscript,
  syncSessionFile,
  initSessionFile,
  deleteExpiredSessionFiles,
  deleteExpiredWebpageFiles,
} from "./session.ts";
import {
  initStateFromConfig,
  initStateFirst,
  getLanguageModel,
} from "./config.ts";
import { initMcpState, getMcpLogIdToLabel } from "./mcp.ts";
import {
  appendModelUsage,
  syncInitialModelUsageForLimitWindow,
  getPrettyTokenUsage,
} from "./usage.ts";
import {
  createSubagentToolSchema,
  getBaseAgentTools,
  createToolCallDiffer,
  bashToolInputSchema,
  loadSkillToolSchema,
  mcpListResourcesSchema,
  mcpReadResourceSchema,
  readImageSchema,
  timeoutSettings,
  webFetchToolSchema,
} from "./tools.ts";
import {
  getSystemContent,
  compactTriggerRatio,
  getDefaultedContextWindow,
  maxCharCountPerSummary,
  getMaxNumberSummaries,
  getRequestInputOverheadTokensApprox,
  getApproxRequestInputTokens,
  resolveRequestInputTokens,
  getPrettyContextWindowUsage,
  strToApproxTokens,
  orApproxTokens,
  getRequestInputCharLength,
  getRequestInputOverheadStr,
} from "./tokens.ts";
import {
  contextFileSkillNamePrefix,
  shouldResolveSlashCommand,
  getAvailableSlashCommands,
  mutedStdout,
  initSigInt,
  createCommands,
} from "./commands.ts";

export const fencePrint = createFencePrint({
  sessionInfoSegments: [
    () => getPrettyApiDuration(),
    () => getPrettyTokenUsage(),
    () => getPrettyContextWindowUsage(),
  ],
});

const commands = createCommands({
  reloadState: () => initStateRepeatable(),
  onExitRequested: () => exitSession(),
});
export const { resolveSlashCommand, initKeypress } = commands;

export function getContextFilesStr(contextEntries: ContextEntry[]) {
  if (contextEntries.length === 0) return "";

  const contextFilesList = contextEntries
    .map(
      (entry) => `## Path: ${entry.filePath}

${normalizeNewline(entry.content)}`,
    )
    .join("\n\n");

  return `# [lasso] AGENTS.md context files

${contextFilesList}`;
}

export async function getContextEntries() {
  const agentFileDirs: string[] = [processDeps.cwd(), getGlobalContextDir()];

  const entries: ContextEntry[] = [];

  for (const agentFileDir of agentFileDirs) {
    const filePath = join(agentFileDir, "AGENTS.md");
    const filePathExistsResult = tryCatch(() => fsDeps.existsSync(filePath));
    if (!filePathExistsResult.ok) {
      print.error(
        `Failed to check if ${filePath} exists. Error: ${getMessageFromError(filePathExistsResult.error)}`,
      );
      continue;
    }
    if (!filePathExistsResult.value) continue;
    const readResult = await tryCatchAsync(fsDeps.readFile(filePath, "utf8"));
    if (!readResult.ok) {
      actions.content.appendConfigWarningMessage(
        `Failed to read the agent file at \`${filePath}\`, ignoring. Error: ${getMessageFromError(readResult.error, { forceSingleLine: true })}`,
      );
      continue;
    }
    entries.push({ filePath, content: readResult.value });
  }

  return entries;
}

const skillMetadataSchema = z.object({
  name: z.string(),
  description: z.string(),
});

export type SkillMetadata = z.infer<typeof skillMetadataSchema>;

export function getSkillsStr(skills: Skill[]) {
  if (skills.length === 0) return "";

  const skillsFormatted = skills
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join("\n");

  return `# [lasso] Skills

Use the \`load_skill\` tool to load a skill when the user's request
would benefit from specialized instructions.

## Available skills:

${skillsFormatted}`;
}

export async function getSkills() {
  const seenSkills = new Set<string>();
  const skillGrandparentDirs = [
    ...getState().config.customSkillDirs,
    getLocalSkillDir(),
    getGlobalSkillDir(),
  ];
  const skills: Skill[] = [];
  const skillPaths: string[] = [];

  for (const skillGrandparentDir of skillGrandparentDirs) {
    const glob = join(skillGrandparentDir, "**/SKILL.md");
    const globResult = await tryCatchAsync(fsDeps.glob(glob));
    if (!globResult.ok) {
      actions.content.appendConfigWarningMessage(
        `Failed to list the skill files in \`${skillGrandparentDir}\`, ignoring. Error: ${getMessageFromError(globResult.error, { forceSingleLine: true })}`,
      );
      continue;
    }
    skillPaths.push(...globResult.value);
  }

  for (const skillPath of skillPaths) {
    const skill = await getSkillJSON(skillPath);
    if (skill === null) continue;

    if (seenSkills.has(skill.name)) continue;
    seenSkills.add(skill.name);
    skills.push(skill);
  }

  const agentFileGlobResult = await tryCatchAsync(
    fsDeps.gitLsFiles("**/AGENTS.md"),
  );
  if (!agentFileGlobResult.ok) {
    actions.content.appendConfigWarningMessage(
      `Failed to list the agent files with git, ignoring. Error: ${getMessageFromError(agentFileGlobResult.error, { forceSingleLine: true })}`,
    );
    return skills;
  }

  for (const agentFilePath of agentFileGlobResult.value) {
    const isRootAgentsMd = agentFilePath === "AGENTS.md";
    if (isRootAgentsMd) continue;
    const readResult = await tryCatchAsync(
      fsDeps.readFile(agentFilePath, "utf8"),
    );
    if (!readResult.ok) {
      actions.content.appendConfigWarningMessage(
        `Failed to read the agent file at \`${agentFilePath}\`, ignoring. Error: ${getMessageFromError(readResult.error, { forceSingleLine: true })}`,
      );
      continue;
    }
    const dir = dirname(agentFilePath);

    const skill: Skill = {
      content: readResult.value,
      description: `Context relevant for ${dir}`,
      dir,
      name: `${contextFileSkillNamePrefix}-${dir}`,
    };
    skills.push(skill);
  }

  return skills;
}

export async function getSkillJSON(skillMdPath: string) {
  const readResult = await tryCatchAsync(fsDeps.readFile(skillMdPath, "utf8"));
  if (!readResult.ok) {
    actions.content.appendConfigWarningMessage(
      `Failed to read the skill at ${skillMdPath}, ignoring. Error: ${getMessageFromError(readResult.error)}`,
    );
    return null;
  }

  const parsed = parseFrontMatter(readResult.value);
  if (parsed === null) {
    actions.content.appendConfigWarningMessage(
      `Malformed skill at ${skillMdPath}! A skill's front matter must contain valid YAML between \`---\` and \`---\`.`,
    );
    return null;
  }
  const parseResult = skillMetadataSchema.safeParse(parsed.data);
  if (!parseResult.success) {
    actions.content.appendConfigWarningMessage(
      `Malformed skill at ${skillMdPath}! A skill's front matter must contain a \`name\` and \`description\` field.`,
    );
    return null;
  }

  const skill: Skill = {
    content: parsed.body,
    dir: dirname(skillMdPath),
    name: parseResult.data.name,
    description: parseResult.data.description,
  };
  return skill;
}

export function getPrettyApiDuration({
  includeMicroseconds = false,
}: { includeMicroseconds?: boolean } = {}) {
  const startTime = getState().usage.apiStartTime;
  assertAtRuntime(startTime !== null);
  const endTime = getState().usage.apiEndTime;
  assertAtRuntime(endTime !== null);

  return getPrettyDuration(startTime, endTime, { includeMicroseconds });
}

export function debugLog(content: string) {
  void writeDebugLog(
    getState().debug.debugLog,
    getState().debug.debugLogPath,
    content,
  );
}

export async function initStateFromFs({
  performanceLogger,
}: {
  performanceLogger: ParallelPerformanceLogger;
}) {
  await syncInitialModelUsageForLimitWindow();

  performanceLogger.start("context");
  const contextEntries = await getContextEntries();
  actions.content.setContextEntries(contextEntries);
  actions.content.setContextStr(getContextFilesStr(contextEntries));
  performanceLogger.end("context");

  performanceLogger.start("skills");
  const skills = await getSkills();
  actions.content.setSkills(skills);
  actions.content.setSkillsStr(getSkillsStr(skills));
  performanceLogger.end("skills");

  performanceLogger.start("commands");
  const slashCommands = await getAvailableSlashCommands();
  actions.content.setSlashCommands(slashCommands);
  performanceLogger.end("commands");
}

export async function initStateRepeatable() {
  const { globalConfig, localConfig } = await initStateFirst();
  initStateFromConfig({ globalConfig, localConfig });

  const performanceLogger = createParallelPerformanceLogger({
    logDuration: !getState().config.suppressStartupDurations,
    logIdToLabel: getStartupLogIdToLabel(),
  });
  performanceLogger.printAllLabels();

  initSessionFile();

  await Promise.all([
    initMcpState({ performanceLogger }),
    initStateFromFs({ performanceLogger }),
  ]);
}

export function getStartupLogIdToLabel(): LogIdToLabel {
  return getMcpLogIdToLabel().concat([
    ["context", "Reading context files: "],
    ["skills", "Reading skills: "],
    ["commands", "Reading slash commands: "],
  ]);
}

export async function initBatAvailable() {
  const batResult = await tryCatchAsync(childProcessDeps.exec("bat --version"));
  actions.content.setBatAvailable(batResult.ok);
  if (!batResult.ok) {
    actions.content.appendConfigWarningMessage(
      `\`bat\` is not available; consider installing it to properly render markdown responses`,
    );
  }
}

export async function initState() {
  const { globalConfig, localConfig } = await initStateFirst();
  const debugLogPath = join(getDebugLogDir(), `debug-${getShortId()}.log`);
  actions.debug.setLogPath(debugLogPath);

  initStateFromConfig({ globalConfig, localConfig });

  const performanceLogger = createParallelPerformanceLogger({
    logDuration: !getState().config.suppressStartupDurations,
    logIdToLabel: getStartupLogIdToLabel(),
  });
  performanceLogger.printAllLabels();

  initSessionFile();

  await Promise.all([
    initMcpState({ performanceLogger }),
    initStateFromFs({ performanceLogger }),
    deleteExpiredSessionFiles(),
    deleteExpiredWebpageFiles(),
    initBatAvailable(),
  ]);
}

function getApiStreamAbortSignal() {
  const controller = getState().abortControllers.apiStream;
  assertAtBuildtime(controller !== null);
  return controller.signal;
}

export async function resolveApiCall(userInput: string) {
  const toolCallDiffer = createToolCallDiffer();

  const userMessage: AiModelMessage = {
    role: "user",
    content: userInput,
  };

  const systemContent = getSystemContent();

  await syncSessionFile({
    messages: getAppendedConversationMessages(userMessage),
  });

  const completedStepMessages: AiModelMessage[] = [];

  actions.conversation.resetToolEditDiffs();
  actions.usage.setApiStartTime();
  actions.abortControllers.setApiStream(new AbortController());
  startLoadingState();
  const generateTextResult = await tryCatchAsync(
    aiDeps.generateText({
      model: getLanguageModel(getState().config.model),
      reasoning: getState().config.reasoning,
      instructions: systemContent,
      messages: [...getState().conversation.messages] as AiModelMessage[],
      tools: getBaseAgentTools(),
      stopWhen: aiDeps.isLoopFinished(),
      abortSignal: getApiStreamAbortSignal(),
      timeout: timeoutSettings,
      onToolExecutionStart: async ({ toolCall }) => {
        switch (toolCall.toolName) {
          case "bash": {
            const input = bashToolInputSchema.parse(toolCall.input);
            toolPrint("bash", input.command);
            if (input.fileSystemAccessType === "create-update-delete") {
              await toolCallDiffer.setTempFiles(
                toolCall.toolCallId,
                input.filePaths,
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
              toolPrint("create_subagent", `[${task.model}] ${task.prompt}`, {
                maxLines: 2,
              });
            }
            break;
          }
          default:
            toolPrint(
              `[mcp] ${toolCall.toolName}`,
              stringify(toolCall.input, { space: 0 }),
            );
        }
      },
      onToolExecutionEnd: async ({ toolCall, toolOutput }) => {
        if (toolCall.toolName !== "bash") return;
        const success = toolOutput.type === "tool-result";

        const bashSchemaResult = bashToolInputSchema.parse(toolCall.input);
        if (bashSchemaResult.fileSystemAccessType === "create-update-delete") {
          if (!success) {
            await toolCallDiffer.cleanupToolCallIdTempFiles(
              toolCall.toolCallId,
            );
            return;
          }
          await toolCallDiffer.diffAndCleanup(
            toolCall.toolCallId,
            bashSchemaResult.filePaths,
          );
        }
      },
      onStepEnd: (stepResult) => {
        completedStepMessages.push(...stepResult.response.messages);
      },
    }),
  );
  stopLoadingState();
  actions.abortControllers.setApiStream(null);
  actions.usage.setApiEndTime();

  if (!generateTextResult.ok) {
    actions.usage.setRequestInputTokensStale(true);
    await toolCallDiffer.cleanupAllTempFiles();

    if (isAbortError(generateTextResult.error)) {
      const interruptMessage: AiModelMessage = {
        role: "assistant",
        content: interruptContent,
      };

      // TODO (later): do I want to save the completedStepMessages to the transcript?
      await syncSessionFile({
        messages: getAppendedConversationMessages(
          ...completedStepMessages,
          interruptMessage,
        ),
      });

      if (getState().terminal.isSteering) {
        print.info("Steering" + getUnicodeChar("…"));
        actions.terminal.setIsSteering(false);
        return null;
      }

      if (getState().terminal.editorInputValue !== null) {
        await resolveInterruptWithEditor();
      }
      return null;
    }

    print.error(getMessageFromError(generateTextResult.error));
    return null;
  }

  const { usage, finalStep, text, responseMessages } = generateTextResult.value;

  await appendModelUsage(usage);

  const finalStepInputTokens =
    finalStep.usage.inputTokens ?? getApproxRequestInputTokens();
  const finalStepOutputTokens = orApproxTokens(
    finalStep.usage.outputTokens,
    text,
  );

  actions.usage.setRequestInputTokens(
    finalStepInputTokens + finalStepOutputTokens,
  );
  actions.usage.setRequestInputTokensCharLength(
    getRequestInputCharLength() + text.length,
  );
  actions.usage.setRequestInputTokensStale(false);

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

export async function getMergedSummaries(summaries: ModelSummary[]) {
  const maxNumberSummaries = getMaxNumberSummaries();

  if (summaries.length < maxNumberSummaries) {
    return summaries;
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

  const compactPrompt = getMergeSummariesPrompt({
    targetCharLen: maxCharCountPerSummary,
    summaries: markdownFence(
      "json",
      stringify(
        [firstSummary, secondSummary].map(({ compacted }) => compacted),
        { space: 0 },
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
      timeout: timeoutSettings,
      ...structuredOutputOpts,
    }),
  );
  stopLoadingState();

  if (!generateTextResult.ok) {
    if (isAbortError(generateTextResult.error)) {
      if (getState().terminal.editorInputValue !== null) {
        await resolveInterruptWithEditor();
      }
      return summaries;
    }

    print.error(getMessageFromError(generateTextResult.error));
    return summaries;
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

export async function getConversationSummary(messageChunk: string[]) {
  // messages[0..summaries.length) are re-appended summaries, one per entry,
  // so everything from summaries.length on is not yet summarized
  const compactPrompt = getConversationSummaryPrompt({
    targetCharLen: maxCharCountPerSummary,
    conversation: markdownFence("json", messageChunk.join("\n")),
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
      timeout: timeoutSettings,
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

export async function maybeCompact(userInput: string) {
  const contextWindow = getDefaultedContextWindow();

  // maybeCompact runs before each api call turn, so we don't know the token
  // count of userInput until after the API call. This can be problematic when the userInput
  // would large enough to trigger compaction, so we approximate for the userInput
  const userInputTokensApprox = strToApproxTokens(userInput);
  const requestInputOverheadTokensApprox =
    getRequestInputOverheadTokensApprox();

  const nextInputTokens = resolveRequestInputTokens() + userInputTokensApprox;

  const nextInputRatio = nextInputTokens / contextWindow;
  if (nextInputRatio <= compactTriggerRatio) return;

  const chunks = splitMessagesToCompact();
  if (chunks.length === 0) return;

  print.doing("Compacting" + getUnicodeChar("…"));

  const { unsummarizedMessages } = getState().conversation;
  let summarizedMessageCount = 0;

  actions.abortControllers.setApiStream(new AbortController());
  try {
    for (const chunk of chunks) {
      const summary = await getConversationSummary(chunk);
      if (summary === null) return;
      const mergedSummaries = await getMergedSummaries([
        ...getState().conversation.summaries,
        summary,
      ]);

      summarizedMessageCount += chunk.length;
      const remainingMessages = unsummarizedMessages.slice(
        summarizedMessageCount,
      );
      const remainingMessagesStr = stringify(remainingMessages, {
        replacer: removeMediaReplacer,
        space: 0,
      });
      const remainingMessagesTokens = strToApproxTokens(remainingMessagesStr);

      await syncSessionFile({
        messages: [
          ...mergedSummaries.map(({ compacted }) => ({
            content: compacted,
            role: "assistant",
          })),
          ...remainingMessages,
        ],
        summaries: mergedSummaries,
      });

      const summaryTokens = mergedSummaries
        .map(({ tokens }) => tokens)
        .reduce((accum, curr) => accum + curr, 0);

      const summaryCharLengths = mergedSummaries
        .map(({ compacted }) => compacted)
        .reduce((accum, curr) => accum + curr.length, 0);

      actions.usage.setRequestInputTokens(
        summaryTokens +
          remainingMessagesTokens +
          requestInputOverheadTokensApprox,
      );
      actions.usage.setRequestInputTokensCharLength(
        summaryCharLengths +
          remainingMessagesStr.length +
          getRequestInputOverheadStr().length,
      );
      actions.usage.setRequestInputTokensStale(false);
    }
  } finally {
    actions.abortControllers.setApiStream(null);
  }
}

export function splitMessagesToCompact() {
  const emptyCompactPrompt = getConversationSummaryPrompt({
    targetCharLen: maxCharCountPerSummary,
    conversation: markdownFence("json", ""),
  });
  const { unsummarizedMessages } = getState().conversation;
  const availableTokensToCompact = Math.max(
    0,
    getDefaultedContextWindow() -
      strToApproxTokens(emptyCompactPrompt) -
      maxTokenCountPerSummary,
  );

  const chunks: string[][] = [];
  let currChunk: string[] = [];
  let tokenCount = 0;

  for (const message of unsummarizedMessages) {
    const messageStr = stringify(message, {
      replacer: removeMediaReplacer,
      space: 0,
    });
    const messageTokens = strToApproxTokens(messageStr);

    if (
      tokenCount + messageTokens > availableTokensToCompact &&
      currChunk.length > 0
    ) {
      chunks.push(currChunk);
      currChunk = [];
      tokenCount = 0;
    }

    currChunk.push(messageStr);
    tokenCount += messageTokens;
  }

  if (currChunk.length > 0) {
    chunks.push(currChunk);
  }

  return chunks;
}

export async function resolveInterruptWithEditor() {
  const rl = getState().terminal.rl;
  assertAtBuildtime(rl !== null);

  actions.abortControllers.setInterruptWithEditorContent(new AbortController());
  const abortController =
    getState().abortControllers.interruptWithEditorContent;
  assertAtBuildtime(abortController !== null);
  print.warning("You have queued messages!");
  const continueResult = await tryCatchAsync(
    rl.question(
      `Edit (${stringify(getState().config.keymaps.edit, { space: 0 })}), c(lear), or <CR> to continue: `,
      {
        signal: abortController.signal,
      },
    ),
  );
  actions.abortControllers.setInterruptWithEditorContent(null);

  if (!continueResult.ok) {
    if (isAbortError(continueResult.error)) return;
    print.error(getMessageFromError(continueResult.error));
    return;
  }

  if (/^c(lear)?$/i.exec(continueResult.value) !== null) {
    actions.terminal.setEditorInputValue(null);
  }
}

Object.defineProperties(mutedStdout, {
  columns: {
    get: () => stdout.columns,
    enumerable: true,
    configurable: true,
  },
  rows: {
    get: () => stdout.rows,
    enumerable: true,
    configurable: true,
  },
});

export function initReadline() {
  const rl = readline.createInterface({
    input: stdin,
    output: mutedStdout,
    terminal: true,
  });
  actions.terminal.setRl(rl);

  initKeypress(rl);
  initSigInt(rl);
}

function filterIfLength(str: string) {
  return str.length > 0;
}

export async function parseInputFromEditor() {
  const editorInputValue = getState().terminal.editorInputValue;
  assertAtBuildtime(editorInputValue !== null);
  const splitByDelimiterEditorInputValue = editorInputValue
    .split(getState().config.messageQueueDelimiter)
    .filter(filterIfLength);

  const splitByCommandEditorInputValue =
    splitByDelimiterEditorInputValue.flatMap((editorChunk) => {
      const lineElements = editorChunk.split(/(?<=\n)/);

      const smallerChunks: string[] = [];
      let tempBuffer: string[] = [];

      for (const lineElement of lineElements) {
        if (
          shouldResolveSlashCommand(lineElement, { forceKnownCommand: true })
        ) {
          if (tempBuffer.length > 0) {
            smallerChunks.push(tempBuffer.join(""));
            tempBuffer = [];
          }

          smallerChunks.push(lineElement);
        } else {
          tempBuffer.push(lineElement);
        }
      }
      if (tempBuffer.length > 0) smallerChunks.push(tempBuffer.join(""));

      return smallerChunks.filter(filterIfLength);
    });

  const [firstMessage, ...rest] = splitByCommandEditorInputValue;

  if (firstMessage === undefined) {
    actions.terminal.setEditorInputValue(null);
    return null;
  }

  if (rest.length === 0) {
    actions.terminal.setEditorInputValue(null);
  } else {
    actions.terminal.setEditorInputValue(
      rest.join(getState().config.messageQueueDelimiter),
    );
  }

  await syncSessionFile({
    transcript: getAppendedTranscript({
      message: firstMessage,
      role: "user",
      timestamp: Date.now(),
    }),
  });
  return firstMessage;
}

export async function pollUntilNonBlockingProcessClosed() {
  while (getState().terminal.isNonBlockingProcessOngoing) {
    await sleep(100);
  }
}

export async function resolveUserInput({
  isFirstInput,
}: {
  isFirstInput: boolean;
}) {
  const rl = getState().terminal.rl;
  assertAtBuildtime(rl !== null);

  if (getState().terminal.editorInputValue !== null) {
    const editorInput = await parseInputFromEditor();
    if (
      editorInput !== null &&
      shouldResolveSlashCommand(editorInput, { forceKnownCommand: true })
    ) {
      return await resolveSlashCommand(editorInput);
    }

    return editorInput;
  }

  if (!isFirstInput) {
    printNewline();
  }
  fencePrint("Input", { color: "yellow" });
  actions.terminal.resetStdout();

  actions.abortControllers.setQuestion(new AbortController());
  const abortController = getState().abortControllers.question;
  assertAtBuildtime(abortController !== null);
  const bufferedInputWhileInitializing =
    getState().terminal.bufferedInputWhileInitializing;
  const questionResult = tryCatchAsync(
    rl.question(getState().config.promptPrefix, {
      signal: abortController.signal,
    }),
  );
  if (bufferedInputWhileInitializing.length > 0) {
    rl.write(bufferedInputWhileInitializing);
    actions.terminal.resetBufferedInputWhileInitializing();
  }
  const inputResult = await questionResult;
  actions.abortControllers.setQuestion(null);

  if (!inputResult.ok) {
    if (isReadlineClosedError(inputResult.error)) {
      await exitSession();
    }

    if (!isAbortError(inputResult.error)) {
      print.error(getMessageFromError(inputResult.error));
      return null;
    }

    const abortedByEditor = getState().terminal.editorInputValue !== null;
    if (abortedByEditor) {
      const editorInput = await parseInputFromEditor();
      if (
        editorInput !== null &&
        shouldResolveSlashCommand(editorInput, { forceKnownCommand: true })
      ) {
        return await resolveSlashCommand(editorInput);
      }

      return editorInput;
    }

    await resolveExitConfirmation();
    return null;
  }

  actions.terminal.appendStdoutTail(
    `${getState().config.promptPrefix}${inputResult.value}\n`,
  );
  await syncSessionFile({
    transcript: getAppendedTranscript({
      message: inputResult.value,
      role: "user",
      timestamp: Date.now(),
    }),
  });

  const rawInput = inputResult.value;
  if (shouldResolveSlashCommand(rawInput, { forceKnownCommand: false })) {
    return await resolveSlashCommand(rawInput);
  }

  if (shouldExecuteUserInput(rawInput)) {
    await executeUserInput(rawInput);
    return null;
  }

  return rawInput.trim();
}

export async function executeUserInput(rawInput: string) {
  actions.terminal.setIsExecutingUserInput(true);
  const abortController = new AbortController();
  actions.abortControllers.setExecuteUserInput(abortController);

  const userInput = rawInput.trim().slice(1);
  print.doing(`$ ${userInput}`);
  try {
    const spawnResult = await tryCatchAsync(
      runUserInput(userInput, abortController.signal),
    );
    if (!spawnResult.ok) {
      if (isAbortError(spawnResult.error)) return;

      print.error(
        `Error while executing the user input. Error: ${getMessageFromError(spawnResult.error)}`,
      );
      return;
    }
  } finally {
    actions.abortControllers.setExecuteUserInput(null);
    actions.terminal.setIsExecutingUserInput(false);
  }
}

async function runUserInput(userInput: string, signal: AbortSignal) {
  const { rl } = getState().terminal;
  // Pause readline so it cannot compete with the inherited shell for terminal input.
  if (rl !== null) rl.pause();

  try {
    const userShell = processDeps.env.get("SHELL") ?? "/bin/sh";
    // Disable zsh job control; otherwise it can background the parent, which suspends on its next terminal read.
    const userShellArgs = userShell.endsWith("zsh")
      ? ["-i", "+m", "-c", userInput]
      : ["-i", "-c", userInput];
    const userProcess = childProcessDeps.spawn(userShell, userShellArgs, {
      stdio: "inherit",
      signal,
    });
    await once(userProcess, "exit");
  } finally {
    if (rl !== null) rl.resume();
  }
}

export function shouldExecuteUserInput(rawInput: string | null): boolean {
  if (rawInput === null) return false;
  return rawInput.trim().at(0) === "!";
}

async function exitSession({ isTyped = false }: SpacingOpts = {}) {
  stopLoadingState();
  const rl = getState().terminal.rl;
  assertAtBuildtime(rl !== null);
  rl.close();
  streamingSupportedWithSpacing(isTyped, () => printSessionStartDate());
  await getState().mcp.close();
  process.exit(0);
}

async function resolveExitConfirmation() {
  const rl = getState().terminal.rl;
  assertAtBuildtime(rl !== null);

  actions.abortControllers.setQuestion(new AbortController());
  const abortController = getState().abortControllers.question;
  assertAtBuildtime(abortController !== null);
  const exitResult = await tryCatchAsync(
    rl.question("y(es) or <C-c> to exit: ", {
      signal: abortController.signal,
    }),
  );
  actions.abortControllers.setQuestion(null);

  if (!exitResult.ok) {
    if (
      isAbortError(exitResult.error) ||
      isReadlineClosedError(exitResult.error)
    ) {
      await exitSession({ isTyped: true });
    }

    print.error(getMessageFromError(exitResult.error));
    return;
  }

  if (/^y(es)?$/i.exec(exitResult.value) !== null) {
    actions.terminal.appendStdoutTail(
      `${getState().config.promptPrefix}${exitResult.value}\n`,
    );

    await exitSession({ isTyped: true });
  }

  return;
}
