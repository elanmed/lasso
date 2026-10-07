/* eslint-disable @typescript-eslint/no-base-to-string */
import type readline from "node:readline/promises";
import type { MCPClient } from "@ai-sdk/mcp";
import { z } from "zod";
import { assertAtRuntime } from "./assert.ts";
import {
  defaultConfig,
  type DefaultedConfig,
  type ModelPricing,
  type Mcp,
  type SdkProvider,
  type UsageLimit,
  type Reasoning,
} from "./config-types.ts";
import { MISSING } from "./missing.ts";
import { getBaseAgentPrompt } from "./prompts.ts";
import { getShortId, stringify } from "./utils.ts";
import { debugLog } from "./debug-log.ts";
import type { ModelUsage } from "./usage.ts";
import type { ContextEntry, Skill } from "./context.ts";

export interface SlashCommand {
  name: string;
  filePath: string;
  content: string;
}

export const ModelSummarySchema = z.strictObject({
  compacted: z.string(),
  compactedAt: z.number(),
  tokens: z.number(),
});

export type ModelSummary = z.infer<typeof ModelSummarySchema>;

export const ModelMessageSchema = z.looseObject({
  role: z.string(),
  content: z.any(),
});

export type ModelMessage = z.infer<typeof ModelMessageSchema>;

export interface ToolEditDiff {
  fileName: string;
  diffStdout: string;
}

export const TranscriptEntrySchema = z.strictObject({
  timestamp: z.number(),
  role: z.enum(["user", "assistant"]),
  message: z.string(),
});

export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

export const SessionFileSchema = z.object({
  messages: z.array(ModelMessageSchema),
  summaries: z.array(ModelSummarySchema),
  transcript: z.array(TranscriptEntrySchema),
});

export type SessionFile = z.infer<typeof SessionFileSchema>;

export type MCPToolSet = Awaited<ReturnType<MCPClient["tools"]>>;

export interface McpState {
  clients: Record<string, MCPClient>;
  tools: MCPToolSet;
  close: () => Promise<void>;
}

interface DebugState {
  debugLog: boolean;
  debugLogPath: string;
}

interface SessionState {
  sessionFilePath: string;
  sessionStartDate: number;
  sessionId: string;
}

interface UsageState {
  promptTokens: {
    value: number;
    dirty: boolean;
  };
  modelUsageForSession: Record<string, ModelUsage[]>;
  modelUsageForLimitWindow: Record<string, ModelUsage[]>;
  apiStartTime: bigint | null;
  apiEndTime: bigint | null;
}

interface ContentState {
  contextEntries: ContextEntry[];
  contextStr: string;
  globalConfigStr: string;
  localConfigStr: string;
  skillsStr: string;
  skills: Skill[];
  subagentModels: string[];
  slashCommands: SlashCommand[];
  batAvailable: boolean;
}

interface TerminalState {
  rl: readline.Interface | null;
  loadingStateTimeout: NodeJS.Timeout | null;
  loadingStateFrameIdx: number;
  isNonBlockingProcessOngoing: boolean;
  isInitializing: boolean;
  isRecording: boolean;
  bufferedInputWhileInitializing: string;
  bufferedStdoutWhileEditorOpen: string;
  stdoutTail: string;
  editorInputValue: string | null;
}

interface ConversationState {
  messages: ModelMessage[];
  summaries: ModelSummary[];
  transcript: TranscriptEntry[];
  toolEditDiffs: ToolEditDiff[];
}

interface AbortControllersState {
  question: AbortController | null;
  apiStream: AbortController | null;
  interruptWithEditorContent: AbortController | null;
  recordProcess: AbortController | null;
  transcription: AbortController | null;
}

interface State {
  debug: DebugState;
  session: SessionState;
  conversation: ConversationState;
  usage: UsageState;
  content: ContentState;
  terminal: TerminalState;
  config: DefaultedConfig;
  mcp: McpState;
  abortControllers: AbortControllersState;
}

const createInitialState = (): State => ({
  debug: {
    debugLog: false,
    debugLogPath: "",
  },
  session: {
    sessionFilePath: "",
    sessionStartDate: Date.now(),
    sessionId: getShortId(),
  },
  conversation: {
    messages: [],
    summaries: [],
    transcript: [],
    toolEditDiffs: [],
  },
  usage: {
    promptTokens: {
      value: 0,
      dirty: true,
    },
    modelUsageForLimitWindow: {},
    modelUsageForSession: {},
    apiStartTime: null,
    apiEndTime: null,
  },
  content: {
    contextEntries: [],
    contextStr: "",
    globalConfigStr: "",
    localConfigStr: "",
    skillsStr: "",
    skills: [],
    subagentModels: [],
    slashCommands: [],
    batAvailable: false,
  },
  terminal: {
    bufferedStdoutWhileEditorOpen: "",
    editorInputValue: null,
    isNonBlockingProcessOngoing: false,
    isInitializing: false,
    isRecording: false,
    bufferedInputWhileInitializing: "",
    stdoutTail: "",
    rl: null,
    loadingStateTimeout: null,
    loadingStateFrameIdx: 0,
  },
  config: {
    model: MISSING,
    baseURL: undefined,
    sdkProvider: defaultConfig.sdkProvider,
    transcriptionSdkProvider: defaultConfig.transcriptionSdkProvider,
    transcriptionModel: defaultConfig.transcriptionModel,
    transcriptionBaseURL: defaultConfig.transcriptionBaseURL,
    gateway: undefined,
    pricingPerModel: structuredClone(defaultConfig.pricingPerModel),
    contextWindowPerModel: structuredClone(defaultConfig.contextWindowPerModel),
    keymaps: structuredClone(defaultConfig.keymaps),
    customSlashCommandDirs: structuredClone(
      defaultConfig.customSlashCommandDirs,
    ),
    customSkillDirs: structuredClone(defaultConfig.customSkillDirs),
    subagentModels: structuredClone(defaultConfig.subagentModels),
    loadingStateFrameDuration: defaultConfig.loadingStateFrameDuration,
    loadingStateFrames: structuredClone(defaultConfig.loadingStateFrames),
    promptPrefix: defaultConfig.promptPrefix,
    suppressBatUnavailableWarning: defaultConfig.suppressBatUnavailableWarning,
    asciiOnly: defaultConfig.asciiOnly,
    suppressStartupDurations: defaultConfig.suppressStartupDurations,
    suppressToolEditDiffs: defaultConfig.suppressToolEditDiffs,
    compactWithStructuredOutput: defaultConfig.compactWithStructuredOutput,
    messageQueueDelimiter: defaultConfig.messageQueueDelimiter,
    reasoning: defaultConfig.reasoning,
    mcps: structuredClone(defaultConfig.mcps),
    usageLimit: undefined,
  },
  mcp: {
    clients: {},
    tools: {},
    close: () => Promise.resolve(),
  },
  abortControllers: {
    question: null,
    apiStream: null,
    interruptWithEditorContent: null,
    recordProcess: null,
    transcription: null,
  },
});

let state: State = createInitialState();

export const getState = () => state;

export const promptDeps = {
  getSystemContent: () =>
    [
      getBaseAgentPrompt(Object.keys(state.mcp.clients)),
      getState().content.contextStr,
      getState().content.skillsStr,
    ].join("\n\n"),
  getToolsContentStr: () => "",
};

const logStateChange = (actionType: string, before: string, after: string) => {
  void debugLog(
    state.debug.debugLog,
    state.debug.debugLogPath,
    `dispatch ${actionType}: before=${before}, after=${after}`,
  );
};

export const actions = {
  setConversationSummaries(summaries: ModelSummary[]) {
    const before = state.conversation.summaries;
    state.conversation.summaries = summaries;
    logStateChange(
      "set-conversation-summaries",
      stringify(before),
      stringify(summaries),
    );
  },

  setConversationMessages(messages: ModelMessage[]) {
    const before = state.conversation.messages;
    state.conversation.messages = messages;
    logStateChange(
      "set-conversation-messages",
      String(before.length),
      String(messages.length),
    );
  },

  setTranscript(transcript: TranscriptEntry[]) {
    const before = state.conversation.transcript;
    state.conversation.transcript = transcript;
    logStateChange(
      "set-transcript",
      String(before.length),
      String(transcript.length),
    );
  },

  setSessionFilePath(sessionFilePath: string) {
    const before = state.session.sessionFilePath;
    state.session.sessionFilePath = sessionFilePath;
    logStateChange("set-session-file-path", before, sessionFilePath);
  },

  setPromptTokens(tokens: number) {
    const before = state.usage.promptTokens.value;
    state.usage.promptTokens.value = tokens;
    logStateChange("set-prompt-tokens", String(before), String(tokens));
  },

  setPromptTokensDirty(tokensStale: boolean) {
    const before = state.usage.promptTokens.dirty;
    state.usage.promptTokens.dirty = tokensStale;
    logStateChange(
      "set-prompt-tokens-dirty",
      String(before),
      String(tokensStale),
    );
  },

  setModel(model: string) {
    const before = state.config.model;
    state.config.model = model;
    logStateChange("set-model", before, model);
  },

  setSubagentModels(subagentModels: string[]) {
    const before = state.config.subagentModels;
    state.config.subagentModels = subagentModels;
    logStateChange(
      "set-subagent-models",
      stringify(before),
      stringify(subagentModels),
    );
  },

  setTranscriptionSdkProvider(provider: "google" | "openai") {
    const before = state.config.transcriptionSdkProvider;
    state.config.transcriptionSdkProvider = provider;
    logStateChange("set-transcription-sdk-provider", String(before), provider);
  },

  setTranscriptionModel(model: string) {
    const before = state.config.transcriptionModel;
    state.config.transcriptionModel = model;
    logStateChange("set-transcription-model", String(before), model);
  },

  setSdkProvider(sdkProvider: SdkProvider) {
    const before = state.config.sdkProvider;
    state.config.sdkProvider = sdkProvider;
    logStateChange("set-sdk-provider", before, sdkProvider);
  },

  setGateway(gateway: "opencode" | undefined) {
    const before = state.config.gateway;
    state.config.gateway = gateway;
    logStateChange("set-gateway", String(before), String(gateway));
  },

  setBaseURL(baseURL: string) {
    const before = state.config.baseURL;
    state.config.baseURL = baseURL;
    logStateChange("set-base-url", String(before), baseURL);
  },

  setTranscriptionBaseURL(baseURL: string) {
    const before = state.config.transcriptionBaseURL;
    state.config.transcriptionBaseURL = baseURL;
    logStateChange("set-transcription-base-url", String(before), baseURL);
  },

  setPricingPerModel(pricing: Record<string, ModelPricing>) {
    const before = state.config.pricingPerModel;
    state.config.pricingPerModel = pricing;
    logStateChange(
      "set-pricing-per-model",
      stringify(before),
      stringify(pricing),
    );
  },

  setContextWindowPerModel(contextWindowPerModel: Record<string, number>) {
    const before = state.config.contextWindowPerModel;
    state.config.contextWindowPerModel = contextWindowPerModel;
    logStateChange(
      "set-context-window-per-model",
      stringify(before),
      stringify(contextWindowPerModel),
    );
  },

  setKeymaps(keymaps: DefaultedConfig["keymaps"]) {
    const before = structuredClone(state.config.keymaps);
    state.config.keymaps = keymaps;
    logStateChange("set-keymaps", stringify(before), stringify(keymaps));
  },

  setQuestionAbortController(controller: AbortController | null) {
    const before = state.abortControllers.question;
    state.abortControllers.question = controller;
    logStateChange(
      "set-question-abort-controller",
      String(before),
      String(controller),
    );
  },

  setApiStreamAbortController(controller: AbortController | null) {
    const before = state.abortControllers.apiStream;
    state.abortControllers.apiStream = controller;
    logStateChange(
      "set-api-stream-abort-controller",
      String(before),
      String(controller),
    );
  },

  setInterruptWithEditorAbortController(controller: AbortController | null) {
    const before = state.abortControllers.interruptWithEditorContent;
    state.abortControllers.interruptWithEditorContent = controller;
    logStateChange(
      "set-interrupt-with-editor-abort-controller",
      String(before),
      String(controller),
    );
  },

  setTranscriptionAbortController(controller: AbortController | null) {
    const before = state.abortControllers.transcription;
    state.abortControllers.transcription = controller;
    logStateChange(
      "set-transcription-abort-controller",
      String(before),
      String(controller),
    );
  },

  setRecordProcessAbortController(controller: AbortController | null) {
    const before = state.abortControllers.recordProcess;
    state.abortControllers.recordProcess = controller;
    logStateChange(
      "set-record-process-abort-controller",
      String(before),
      String(controller),
    );
  },

  setEditorInputValue(value: string | null) {
    assertAtRuntime(value !== "");
    const before = state.terminal.editorInputValue;
    state.terminal.editorInputValue = value;
    logStateChange("set-editor-input-value", String(before), String(value));
  },

  appendEditorInputValue(value: string) {
    assertAtRuntime(value !== "");
    const before = state.terminal.editorInputValue;
    const appended = before === null ? value : `${before}${value}`;
    state.terminal.editorInputValue = appended;
    logStateChange("append-editor-input-value", String(before), appended);
  },

  setIsNonBlockingProcessOngoing(isNonBlockingProcessOngoing: boolean) {
    const before = state.terminal.isNonBlockingProcessOngoing;
    state.terminal.isNonBlockingProcessOngoing = isNonBlockingProcessOngoing;
    logStateChange(
      "set-is-non-blocking-process-ongoing",
      String(before),
      String(isNonBlockingProcessOngoing),
    );
  },

  setIsInitializing(isInitializing: boolean) {
    const before = state.terminal.isInitializing;
    state.terminal.isInitializing = isInitializing;
    logStateChange(
      "set-is-initializing",
      String(before),
      String(isInitializing),
    );
  },

  setIsRecording(isRecording: boolean) {
    const before = state.terminal.isRecording;
    state.terminal.isRecording = isRecording;
    logStateChange("set-is-recording", String(before), String(isRecording));
  },

  appendBufferedInputWhileInitializing(input: string) {
    const before = state.terminal.bufferedInputWhileInitializing;
    state.terminal.bufferedInputWhileInitializing += input;
    logStateChange(
      "append-buffered-input-while-initializing",
      String(before.length),
      String(state.terminal.bufferedInputWhileInitializing.length),
    );
  },

  resetBufferedInputWhileInitializing() {
    const before = state.terminal.bufferedInputWhileInitializing;
    state.terminal.bufferedInputWhileInitializing = "";
    logStateChange("reset-buffered-input-while-initializing", before, "");
  },

  appendBufferedStdoutWhileEditorOpen(line: string) {
    const before = state.terminal.bufferedStdoutWhileEditorOpen;
    state.terminal.bufferedStdoutWhileEditorOpen += line;
    logStateChange(
      "append-buffered-stdout-while-editor-open",
      String(before.length),
      String(state.terminal.bufferedStdoutWhileEditorOpen.length),
    );
  },

  resetBufferedStdoutWhileEditorOpen() {
    const before = state.terminal.bufferedStdoutWhileEditorOpen;
    state.terminal.bufferedStdoutWhileEditorOpen = "";
    logStateChange(
      "reset-buffered-stdout-while-editor-open",
      String(before.length),
      "0",
    );
  },

  setSlashCommands(commands: SlashCommand[]) {
    const before = state.content.slashCommands;
    state.content.slashCommands = commands;
    logStateChange("set-slash-commands", String(before), String(commands));
  },

  setCustomSlashCommandDirs(dirs: string[]) {
    const before = state.config.customSlashCommandDirs;
    state.config.customSlashCommandDirs = dirs;
    logStateChange(
      "set-custom-slash-command-dirs",
      String(before),
      String(dirs),
    );
  },

  setCustomSkillDirs(dirs: string[]) {
    const before = state.config.customSkillDirs;
    state.config.customSkillDirs = dirs;
    logStateChange("set-custom-skill-dirs", String(before), String(dirs));
  },

  resetStdout() {
    const before = state.terminal.stdoutTail;
    state.terminal.stdoutTail = "";
    logStateChange("reset-stdout-tail", before, "");
  },

  appendStdoutTail(line: string) {
    const before = state.terminal.stdoutTail;
    state.terminal.stdoutTail += line;
    state.terminal.stdoutTail = state.terminal.stdoutTail.slice(-2);
    logStateChange(
      "append-stdout-tail",
      String(before.length),
      String(state.terminal.stdoutTail.length),
    );
  },

  setBatAvailable(batAvailable: boolean) {
    const before = state.content.batAvailable;
    state.content.batAvailable = batAvailable;
    logStateChange("set-bat-available", String(before), String(batAvailable));
  },

  setDebugLog(debugLog: boolean) {
    // `logStateChange` returns early when `debugLog=false`
    // so it can't be called in the fn where `debugLog` is set
    state.debug.debugLog = debugLog;
  },

  setDebugLogPath(debugLogPath: string) {
    const before = state.debug.debugLogPath;
    state.debug.debugLogPath = debugLogPath;
    logStateChange("set-debug-log-path", before, debugLogPath);
  },

  setContextEntries(contextEntries: ContextEntry[]) {
    const before = state.content.contextEntries.length;
    state.content.contextEntries = contextEntries;
    logStateChange(
      "set-context-entries",
      String(before),
      String(state.content.contextEntries.length),
    );
  },

  setContextStr(contextStr: string) {
    const before = state.content.contextStr;
    state.content.contextStr = contextStr;
    logStateChange(
      "set-context-str",
      String(before.length),
      String(contextStr.length),
    );
  },

  setGlobalConfigStr(globalConfigStr: string) {
    const before = state.content.globalConfigStr;
    state.content.globalConfigStr = globalConfigStr;
    logStateChange(
      "set-global-config-str",
      String(before.length),
      String(globalConfigStr.length),
    );
  },

  setLocalConfigStr(localConfigStr: string) {
    const before = state.content.localConfigStr;
    state.content.localConfigStr = localConfigStr;
    logStateChange(
      "set-local-config-str",
      String(before.length),
      String(localConfigStr.length),
    );
  },

  setSkillsStr(skillsStr: string) {
    const before = state.content.skillsStr;
    state.content.skillsStr = skillsStr;
    logStateChange(
      "set-skills-str",
      String(before.length),
      String(skillsStr.length),
    );
  },

  setSkills(skills: Skill[]) {
    const before = state.content.skills.length;
    state.content.skills = skills;
    logStateChange(
      "set-skills",
      String(before),
      String(state.content.skills.length),
    );
  },

  appendToolEditDiff(diff: ToolEditDiff) {
    state.conversation.toolEditDiffs.push(diff);
    logStateChange(
      "append-tool-edit-diff",
      String(state.conversation.toolEditDiffs.length - 1),
      String(state.conversation.toolEditDiffs.length),
    );
  },

  resetToolEditDiffs() {
    state.conversation.toolEditDiffs = [];
    logStateChange("reset-tool-edit-diffs", "", "");
  },

  setModelUsageForLimitWindow(
    modelUsageForLimitWindow: Record<string, ModelUsage[]>,
  ) {
    const before = state.usage.modelUsageForLimitWindow;
    state.usage.modelUsageForLimitWindow = modelUsageForLimitWindow;

    logStateChange(
      "set-model-usage-for-limit-window",
      String(Object.keys(before).length),
      String(Object.keys(state.usage.modelUsageForLimitWindow).length),
    );
  },

  setModelUsageForSession(modelUsageForSession: Record<string, ModelUsage[]>) {
    const before = state.usage.modelUsageForSession;
    state.usage.modelUsageForSession = modelUsageForSession;

    logStateChange(
      "set-model-usage-for-session",
      String(Object.keys(before).length),
      String(Object.keys(state.usage.modelUsageForSession).length),
    );
  },

  appendToModelUsageForSession(usage: ModelUsage) {
    const model = state.config.model;
    state.usage.modelUsageForSession[model] ??= [];

    const before = state.usage.modelUsageForSession[model];
    state.usage.modelUsageForSession[model].push(usage);

    logStateChange(
      "append-to-model-usage-for-session",
      String(before.length),
      String(state.usage.modelUsageForSession[model].length),
    );
  },

  setRl(rl: readline.Interface | null) {
    const before = state.terminal.rl;
    state.terminal.rl = rl;
    logStateChange("set-rl", String(before), String(rl));
  },

  setLoadingStateTimeout(timeout: NodeJS.Timeout | null) {
    const before = state.terminal.loadingStateTimeout;
    state.terminal.loadingStateTimeout = timeout;
    logStateChange(
      "set-loading-state-timeout",
      String(before),
      String(timeout),
    );
  },

  setApiStartTime() {
    const before = state.usage.apiStartTime;
    const now = process.hrtime.bigint();
    state.usage.apiStartTime = now;
    logStateChange("set-api-start-time", String(before), String(now));
  },

  setApiEndTime() {
    const before = state.usage.apiEndTime;
    const now = process.hrtime.bigint();
    state.usage.apiEndTime = now;
    logStateChange("set-api-end-time", String(before), String(now));
  },

  resetState() {
    // `createInitialState` resets `debugLog` to false, so need to log before assigning to `state`
    logStateChange(
      "reset-state",
      "[truncating]",
      stringify(createInitialState()),
    );
    state = createInitialState();
  },

  incrementLoadingStateFrameIdx() {
    const before = state.terminal.loadingStateFrameIdx;
    state.terminal.loadingStateFrameIdx++;
    const after = state.terminal.loadingStateFrameIdx;
    logStateChange(
      "set-loading-state-frame-idx",
      String(before),
      String(after),
    );
  },

  resetLoadingStateFrameIdx() {
    const before = state.terminal.loadingStateFrameIdx;
    state.terminal.loadingStateFrameIdx = 0;
    logStateChange(
      "set-loading-state-frame-idx",
      String(before),
      String(state.terminal.loadingStateFrameIdx),
    );
  },

  setLoadingStateFrames(loadingStateFrames: string[]) {
    const before = state.config.loadingStateFrames;
    state.config.loadingStateFrames = loadingStateFrames;
    logStateChange(
      "set-loading-state-frames",
      stringify(before),
      stringify(loadingStateFrames),
    );
  },

  setLoadingStateFrameDuration(loadingStateFrameDuration: number) {
    const before = state.config.loadingStateFrameDuration;
    state.config.loadingStateFrameDuration = loadingStateFrameDuration;
    logStateChange(
      "set-loading-state-frame-duration",
      String(before),
      String(loadingStateFrameDuration),
    );
  },

  setPromptPrefix(promptPrefix: string) {
    const before = state.config.promptPrefix;
    state.config.promptPrefix = promptPrefix;
    logStateChange("set-prompt-prefix", before, promptPrefix);
  },

  setSuppressBatUnavailableWarning(suppressBatUnavailableWarning: boolean) {
    const before = state.config.suppressBatUnavailableWarning;
    state.config.suppressBatUnavailableWarning = suppressBatUnavailableWarning;
    logStateChange(
      "set-suppress-bat-unavailable-warning",
      String(before),
      String(suppressBatUnavailableWarning),
    );
  },

  setMessageQueueDelimiter(messageQueueDelimiter: string) {
    const before = state.config.messageQueueDelimiter;
    state.config.messageQueueDelimiter = messageQueueDelimiter;
    logStateChange(
      "set-message-queue-delimiter",
      before,
      messageQueueDelimiter,
    );
  },

  setAsciiOnly(asciiOnly: boolean) {
    const before = state.config.asciiOnly;
    state.config.asciiOnly = asciiOnly;
    logStateChange("set-ascii-only", String(before), String(asciiOnly));
  },

  setSuppressStartupDurations(suppressStartupDurations: boolean) {
    const before = state.config.suppressStartupDurations;
    state.config.suppressStartupDurations = suppressStartupDurations;
    logStateChange(
      "set-hide-startup-durations",
      String(before),
      String(suppressStartupDurations),
    );
  },

  setSuppressToolEditDiffs(suppressToolEditDiffs: boolean) {
    const before = state.config.suppressToolEditDiffs;
    state.config.suppressToolEditDiffs = suppressToolEditDiffs;
    logStateChange(
      "set-suppress-tool-edit-diffs",
      String(before),
      String(suppressToolEditDiffs),
    );
  },

  setCompactWithStructuredOutput(compactWithStructuredOutput: boolean) {
    const before = state.config.compactWithStructuredOutput;
    state.config.compactWithStructuredOutput = compactWithStructuredOutput;
    logStateChange(
      "set-compact-with-structured-output",
      String(before),
      String(compactWithStructuredOutput),
    );
  },

  setReasoning(reasoning: Reasoning) {
    const before = state.config.reasoning;
    state.config.reasoning = reasoning;
    logStateChange("set-reasoning", before, reasoning);
  },

  setMcps(mcps: Record<string, Mcp>) {
    const before = state.config.mcps;
    state.config.mcps = mcps;
    logStateChange("set-mcps", stringify(before), stringify(mcps));
  },

  setMcp(clients: Record<string, MCPClient>, tools: MCPToolSet) {
    const before = state.mcp;
    state.mcp.clients = clients;
    state.mcp.tools = tools;
    state.mcp.close = async () => {
      await Promise.all(Object.values(clients).map((client) => client.close()));
    };
    logStateChange(
      "set-mcp",
      `${String(Object.keys(before.clients).length)}:${String(Object.keys(before.tools).length)}`,
      `${String(Object.keys(clients).length)}:${String(Object.keys(tools).length)}`,
    );
  },

  setUsageLimit(usageLimit: UsageLimit | undefined) {
    const before = state.config.usageLimit;
    state.config.usageLimit = usageLimit;
    logStateChange("set-usage-limit", stringify(before), stringify(usageLimit));
  },
};
