import readline from "node:readline/promises";
import { type MCPClient } from "@ai-sdk/mcp";
import {
  MISSING,
  defaultConfig,
  type DefaultedConfig,
  type Mcp,
  type ModelMessage,
  type ModelPricing,
  type ModelUsage,
  type ModelSummary,
  type Reasoning,
  type SdkProvider,
  type ToolEditDiff,
  type TranscriptEntry,
  type UsageLimit,
} from "./schemas.ts";
import {
  assertAtRuntime,
  getShortId,
  stringify,
  writeDebugLog,
} from "./utils.ts";

export interface ContextEntry {
  filePath: string;
  content: string;
}

export interface Skill {
  name: string;
  description: string;
  dir: string;
  content: string;
}

export interface SlashCommand {
  name: string;
  filePath: string;
  content: string;
}

export type MCPToolSet = Awaited<ReturnType<MCPClient["tools"]>>;

export type MCPClients = Record<string, MCPClient>;

export interface McpState {
  clients: MCPClients;
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
  requestInputTokens: {
    value: number;
    stale: boolean;
    charLength: number;
  };
  modelUsageForSession: Record<string, ModelUsage[]>;
  modelUsageForLimitWindow: Record<string, ModelUsage[]>;
  apiStartTime: bigint | null;
  apiEndTime: bigint | null;
}

interface ContentState {
  configErrorMessages: string[];
  configWarningMessages: string[];
  includeConfigInitMessage: boolean;
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
  isSteering: boolean;
  bufferedInputWhileInitializing: string;
  bufferedStdoutWhileEditorOpen: string;
  stdoutTail: string;
  editorInputValue: string | null;
}

interface ConversationState {
  messages: ModelMessage[];
  unsummarizedMessages: ModelMessage[];
  summaries: ModelSummary[];
  transcript: TranscriptEntry[];
  toolEditDiffs: ToolEditDiff[];
}

interface AbortControllersState {
  question: AbortController | null;
  apiStream: AbortController | null;
  executeUserInput: AbortController | null;
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
    unsummarizedMessages: [],
    summaries: [],
    transcript: [],
    toolEditDiffs: [],
  },
  usage: {
    requestInputTokens: {
      value: 0,
      stale: true,
      charLength: 0,
    },
    modelUsageForLimitWindow: {},
    modelUsageForSession: {},
    apiStartTime: null,
    apiEndTime: null,
  },
  content: {
    configErrorMessages: [],
    configWarningMessages: [],
    includeConfigInitMessage: false,
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
    isSteering: false,
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
    suppressConfigWarnings: defaultConfig.suppressConfigWarnings,
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
    executeUserInput: null,
    interruptWithEditorContent: null,
    recordProcess: null,
    transcription: null,
  },
});

let state: State = createInitialState();

export const getState = () => state;

const logStateChange = (actionType: string, before: string, after: string) => {
  void writeDebugLog(
    state.debug.debugLog,
    state.debug.debugLogPath,
    `dispatch ${actionType}: before=${before}, after=${after}`,
  );
};

/* eslint-disable @typescript-eslint/no-base-to-string */
export const actions = {
  debug: {
    setLog(debugLog: boolean) {
      // `logStateChange` returns early when `debugLog=false`
      // so it can't be called in the fn where `debugLog` is set
      state.debug.debugLog = debugLog;
    },
    setLogPath(debugLogPath: string) {
      const before = state.debug.debugLogPath;
      state.debug.debugLogPath = debugLogPath;
      logStateChange("set-debug-log-path", before, debugLogPath);
    },
  },
  session: {
    setFilePath(sessionFilePath: string) {
      const before = state.session.sessionFilePath;
      state.session.sessionFilePath = sessionFilePath;
      logStateChange("set-session-file-path", before, sessionFilePath);
    },
  },
  conversation: {
    setSummaries(summaries: ModelSummary[]) {
      const before = state.conversation.summaries;
      state.conversation.summaries = summaries;
      state.conversation.unsummarizedMessages =
        state.conversation.messages.slice(summaries.length);
      logStateChange(
        "set-conversation-summaries",
        stringify(before, { space: 2 }),
        stringify(summaries, { space: 2 }),
      );
    },
    setMessages(messages: ModelMessage[]) {
      const before = state.conversation.messages;
      state.conversation.messages = messages;
      state.conversation.unsummarizedMessages = messages.slice(
        state.conversation.summaries.length,
      );
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
  },
  usage: {
    setRequestInputTokens(tokens: number) {
      const before = state.usage.requestInputTokens.value;
      state.usage.requestInputTokens.value = tokens;
      logStateChange(
        "set-request-input-tokens",
        String(before),
        String(tokens),
      );
    },
    setRequestInputTokensStale(tokensStale: boolean) {
      const before = state.usage.requestInputTokens.stale;
      state.usage.requestInputTokens.stale = tokensStale;
      logStateChange(
        "set-request-input-tokens-stale",
        String(before),
        String(tokensStale),
      );
    },
    setRequestInputTokensCharLength(charLength: number) {
      const before = state.usage.requestInputTokens.charLength;
      state.usage.requestInputTokens.charLength = charLength;
      logStateChange(
        "set-request-input-tokens-char-length",
        String(before),
        String(charLength),
      );
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
    setModelUsageForSession(
      modelUsageForSession: Record<string, ModelUsage[]>,
    ) {
      const before = state.usage.modelUsageForSession;
      state.usage.modelUsageForSession = modelUsageForSession;

      logStateChange(
        "set-model-usage-for-session",
        String(Object.keys(before).length),
        String(Object.keys(state.usage.modelUsageForSession).length),
      );
    },
    appendToModelUsageForSession(usage: ModelUsage, model: string) {
      state.usage.modelUsageForSession[model] ??= [];

      const before = state.usage.modelUsageForSession[model];
      state.usage.modelUsageForSession[model].push(usage);

      logStateChange(
        "append-to-model-usage-for-session",
        String(before.length),
        String(state.usage.modelUsageForSession[model].length),
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
  },
  content: {
    setSlashCommands(commands: SlashCommand[]) {
      const before = state.content.slashCommands;
      state.content.slashCommands = commands;
      logStateChange("set-slash-commands", String(before), String(commands));
    },
    setBatAvailable(batAvailable: boolean) {
      const before = state.content.batAvailable;
      state.content.batAvailable = batAvailable;
      logStateChange("set-bat-available", String(before), String(batAvailable));
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
    appendConfigErrorMessage(message: string) {
      state.content.configErrorMessages.push(message);
      logStateChange(
        "append-config-error-message",
        String(state.content.configErrorMessages.length - 1),
        String(state.content.configErrorMessages.length),
      );
    },
    setIncludeConfigInitMessage(includeConfigInitMessage: boolean) {
      const before = state.content.includeConfigInitMessage;
      state.content.includeConfigInitMessage = includeConfigInitMessage;
      logStateChange(
        "set-include-config-init-message",
        String(before),
        String(includeConfigInitMessage),
      );
    },
    resetConfigErrorMessages() {
      state.content.configErrorMessages = [];
      logStateChange("reset-config-error-messages", "", "");
    },
    appendConfigWarningMessage(message: string) {
      state.content.configWarningMessages.push(message);
      logStateChange(
        "append-config-warning-message",
        String(state.content.configWarningMessages.length - 1),
        String(state.content.configWarningMessages.length),
      );
    },
    resetConfigWarningMessages() {
      state.content.configWarningMessages = [];
      logStateChange("reset-config-warning-messages", "", "");
    },
  },
  terminal: {
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
    setIsSteering(isSteering: boolean) {
      const before = state.terminal.isSteering;
      state.terminal.isSteering = isSteering;
      logStateChange("set-is-steering", String(before), String(isSteering));
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
  },
  config: {
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
        stringify(before, { space: 2 }),
        stringify(subagentModels, { space: 2 }),
      );
    },
    setTranscriptionSdkProvider(provider: "google" | "openai") {
      const before = state.config.transcriptionSdkProvider;
      state.config.transcriptionSdkProvider = provider;
      logStateChange(
        "set-transcription-sdk-provider",
        String(before),
        provider,
      );
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
        stringify(before, { space: 2 }),
        stringify(pricing, { space: 2 }),
      );
    },
    setContextWindowPerModel(contextWindowPerModel: Record<string, number>) {
      const before = state.config.contextWindowPerModel;
      state.config.contextWindowPerModel = contextWindowPerModel;
      logStateChange(
        "set-context-window-per-model",
        stringify(before, { space: 2 }),
        stringify(contextWindowPerModel, { space: 2 }),
      );
    },
    setKeymaps(keymaps: DefaultedConfig["keymaps"]) {
      const before = structuredClone(state.config.keymaps);
      state.config.keymaps = keymaps;
      logStateChange(
        "set-keymaps",
        stringify(before, { space: 2 }),
        stringify(keymaps, { space: 2 }),
      );
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
    setLoadingStateFrames(loadingStateFrames: string[]) {
      const before = state.config.loadingStateFrames;
      state.config.loadingStateFrames = loadingStateFrames;
      logStateChange(
        "set-loading-state-frames",
        stringify(before, { space: 2 }),
        stringify(loadingStateFrames, { space: 2 }),
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
    setSuppressConfigWarnings(suppressConfigWarnings: boolean) {
      const before = state.config.suppressConfigWarnings;
      state.config.suppressConfigWarnings = suppressConfigWarnings;
      logStateChange(
        "set-suppress-config-warnings",
        String(before),
        String(suppressConfigWarnings),
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
      logStateChange(
        "set-mcps",
        stringify(before, { space: 2 }),
        stringify(mcps, { space: 2 }),
      );
    },
    setUsageLimit(usageLimit: UsageLimit | undefined) {
      const before = state.config.usageLimit;
      state.config.usageLimit = usageLimit;
      logStateChange(
        "set-usage-limit",
        stringify(before, { space: 2 }),
        stringify(usageLimit, { space: 2 }),
      );
    },
  },
  mcp: {
    setClientsAndTools(clients: MCPClients, tools: MCPToolSet) {
      const before = state.mcp;
      state.mcp.clients = clients;
      state.mcp.tools = tools;
      state.mcp.close = async () => {
        await Promise.all(
          Object.values(clients).map((client) => client.close()),
        );
      };
      logStateChange(
        "set-mcp",
        `${String(Object.keys(before.clients).length)}:${String(Object.keys(before.tools).length)}`,
        `${String(Object.keys(clients).length)}:${String(Object.keys(tools).length)}`,
      );
    },
  },
  abortControllers: {
    setQuestion(controller: AbortController | null) {
      const before = state.abortControllers.question;
      state.abortControllers.question = controller;
      logStateChange(
        "set-question-abort-controller",
        String(before),
        String(controller),
      );
    },
    setApiStream(controller: AbortController | null) {
      const before = state.abortControllers.apiStream;
      state.abortControllers.apiStream = controller;
      logStateChange(
        "set-api-stream-abort-controller",
        String(before),
        String(controller),
      );
    },
    setExecuteUserInput(controller: AbortController | null) {
      const before = state.abortControllers.executeUserInput;
      state.abortControllers.executeUserInput = controller;
      logStateChange(
        "set-execute-user-input-abort-controller",
        String(before),
        String(controller),
      );
    },
    setInterruptWithEditorContent(controller: AbortController | null) {
      const before = state.abortControllers.interruptWithEditorContent;
      state.abortControllers.interruptWithEditorContent = controller;
      logStateChange(
        "set-interrupt-with-editor-abort-controller",
        String(before),
        String(controller),
      );
    },
    setTranscription(controller: AbortController | null) {
      const before = state.abortControllers.transcription;
      state.abortControllers.transcription = controller;
      logStateChange(
        "set-transcription-abort-controller",
        String(before),
        String(controller),
      );
    },
    setRecordProcess(controller: AbortController | null) {
      const before = state.abortControllers.recordProcess;
      state.abortControllers.recordProcess = controller;
      logStateChange(
        "set-record-process-abort-controller",
        String(before),
        String(controller),
      );
    },
  },
  resetState() {
    // `createInitialState` resets `debugLog` to false, so need to log before assigning to `state`
    logStateChange(
      "reset-state",
      "[truncating]",
      stringify(createInitialState(), { space: 2 }),
    );
    state = createInitialState();
  },
};
