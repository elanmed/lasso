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
import { assertAtRuntime, getShortId } from "./utils.ts";

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
  isExecutingUserInput: boolean;
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
    isExecutingUserInput: false,
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

export const actions = {
  debug: {
    setLog(debugLog: boolean) {
      state.debug.debugLog = debugLog;
    },
    setLogPath(debugLogPath: string) {
      state.debug.debugLogPath = debugLogPath;
    },
  },
  session: {
    setFilePath(sessionFilePath: string) {
      state.session.sessionFilePath = sessionFilePath;
    },
  },
  conversation: {
    setSummaries(summaries: ModelSummary[]) {
      state.conversation.summaries = summaries;
      state.conversation.unsummarizedMessages =
        state.conversation.messages.slice(summaries.length);
    },
    setMessages(messages: ModelMessage[]) {
      state.conversation.messages = messages;
      state.conversation.unsummarizedMessages = messages.slice(
        state.conversation.summaries.length,
      );
    },
    setTranscript(transcript: TranscriptEntry[]) {
      state.conversation.transcript = transcript;
    },
    appendToolEditDiff(diff: ToolEditDiff) {
      state.conversation.toolEditDiffs.push(diff);
    },
    resetToolEditDiffs() {
      state.conversation.toolEditDiffs = [];
    },
  },
  usage: {
    setRequestInputTokens(tokens: number) {
      state.usage.requestInputTokens.value = tokens;
    },
    setRequestInputTokensStale(tokensStale: boolean) {
      state.usage.requestInputTokens.stale = tokensStale;
    },
    setRequestInputTokensCharLength(charLength: number) {
      state.usage.requestInputTokens.charLength = charLength;
    },
    setModelUsageForLimitWindow(
      modelUsageForLimitWindow: Record<string, ModelUsage[]>,
    ) {
      state.usage.modelUsageForLimitWindow = modelUsageForLimitWindow;
    },
    setModelUsageForSession(
      modelUsageForSession: Record<string, ModelUsage[]>,
    ) {
      state.usage.modelUsageForSession = modelUsageForSession;
    },
    appendToModelUsageForSession(usage: ModelUsage, model: string) {
      state.usage.modelUsageForSession[model] ??= [];

      state.usage.modelUsageForSession[model].push(usage);
    },
    setApiStartTime() {
      const now = process.hrtime.bigint();
      state.usage.apiStartTime = now;
    },
    setApiEndTime() {
      const now = process.hrtime.bigint();
      state.usage.apiEndTime = now;
    },
  },
  content: {
    setSlashCommands(commands: SlashCommand[]) {
      state.content.slashCommands = commands;
    },
    setBatAvailable(batAvailable: boolean) {
      state.content.batAvailable = batAvailable;
    },
    setContextEntries(contextEntries: ContextEntry[]) {
      state.content.contextEntries = contextEntries;
    },
    setContextStr(contextStr: string) {
      state.content.contextStr = contextStr;
    },
    setGlobalConfigStr(globalConfigStr: string) {
      state.content.globalConfigStr = globalConfigStr;
    },
    setLocalConfigStr(localConfigStr: string) {
      state.content.localConfigStr = localConfigStr;
    },
    setSkillsStr(skillsStr: string) {
      state.content.skillsStr = skillsStr;
    },
    setSkills(skills: Skill[]) {
      state.content.skills = skills;
    },
    appendConfigErrorMessage(message: string) {
      state.content.configErrorMessages.push(message);
    },
    setIncludeConfigInitMessage(includeConfigInitMessage: boolean) {
      state.content.includeConfigInitMessage = includeConfigInitMessage;
    },
    resetConfigErrorMessages() {
      state.content.configErrorMessages = [];
    },
    appendConfigWarningMessage(message: string) {
      state.content.configWarningMessages.push(message);
    },
    resetConfigWarningMessages() {
      state.content.configWarningMessages = [];
    },
  },
  terminal: {
    setEditorInputValue(value: string | null) {
      assertAtRuntime(value !== "");
      state.terminal.editorInputValue = value;
    },
    appendEditorInputValue(value: string) {
      assertAtRuntime(value !== "");
      const before = state.terminal.editorInputValue;
      const appended = before === null ? value : `${before}${value}`;
      state.terminal.editorInputValue = appended;
    },
    setIsNonBlockingProcessOngoing(isNonBlockingProcessOngoing: boolean) {
      state.terminal.isNonBlockingProcessOngoing = isNonBlockingProcessOngoing;
    },
    setIsExecutingUserInput(isExecutingUserInput: boolean) {
      state.terminal.isExecutingUserInput = isExecutingUserInput;
    },
    setIsInitializing(isInitializing: boolean) {
      state.terminal.isInitializing = isInitializing;
    },
    setIsRecording(isRecording: boolean) {
      state.terminal.isRecording = isRecording;
    },
    setIsSteering(isSteering: boolean) {
      state.terminal.isSteering = isSteering;
    },
    appendBufferedInputWhileInitializing(input: string) {
      state.terminal.bufferedInputWhileInitializing += input;
    },
    resetBufferedInputWhileInitializing() {
      state.terminal.bufferedInputWhileInitializing = "";
    },
    appendBufferedStdoutWhileEditorOpen(line: string) {
      state.terminal.bufferedStdoutWhileEditorOpen += line;
    },
    resetBufferedStdoutWhileEditorOpen() {
      state.terminal.bufferedStdoutWhileEditorOpen = "";
    },
    resetStdout() {
      state.terminal.stdoutTail = "";
    },
    appendStdoutTail(line: string) {
      state.terminal.stdoutTail += line;
      state.terminal.stdoutTail = state.terminal.stdoutTail.slice(-2);
    },
    setRl(rl: readline.Interface | null) {
      state.terminal.rl = rl;
    },
    setLoadingStateTimeout(timeout: NodeJS.Timeout | null) {
      state.terminal.loadingStateTimeout = timeout;
    },
    incrementLoadingStateFrameIdx() {
      state.terminal.loadingStateFrameIdx++;
    },
    resetLoadingStateFrameIdx() {
      state.terminal.loadingStateFrameIdx = 0;
    },
  },
  config: {
    setModel(model: string) {
      state.config.model = model;
    },
    setSubagentModels(subagentModels: string[]) {
      state.config.subagentModels = subagentModels;
    },
    setTranscriptionSdkProvider(provider: "google" | "openai") {
      state.config.transcriptionSdkProvider = provider;
    },
    setTranscriptionModel(model: string) {
      state.config.transcriptionModel = model;
    },
    setSdkProvider(sdkProvider: SdkProvider) {
      state.config.sdkProvider = sdkProvider;
    },
    setGateway(gateway: "opencode" | undefined) {
      state.config.gateway = gateway;
    },
    setBaseURL(baseURL: string) {
      state.config.baseURL = baseURL;
    },
    setTranscriptionBaseURL(baseURL: string) {
      state.config.transcriptionBaseURL = baseURL;
    },
    setPricingPerModel(pricing: Record<string, ModelPricing>) {
      state.config.pricingPerModel = pricing;
    },
    setContextWindowPerModel(contextWindowPerModel: Record<string, number>) {
      state.config.contextWindowPerModel = contextWindowPerModel;
    },
    setKeymaps(keymaps: DefaultedConfig["keymaps"]) {
      state.config.keymaps = keymaps;
    },
    setCustomSlashCommandDirs(dirs: string[]) {
      state.config.customSlashCommandDirs = dirs;
    },
    setCustomSkillDirs(dirs: string[]) {
      state.config.customSkillDirs = dirs;
    },
    setLoadingStateFrames(loadingStateFrames: string[]) {
      state.config.loadingStateFrames = loadingStateFrames;
    },
    setLoadingStateFrameDuration(loadingStateFrameDuration: number) {
      state.config.loadingStateFrameDuration = loadingStateFrameDuration;
    },
    setPromptPrefix(promptPrefix: string) {
      state.config.promptPrefix = promptPrefix;
    },
    setSuppressConfigWarnings(suppressConfigWarnings: boolean) {
      state.config.suppressConfigWarnings = suppressConfigWarnings;
    },
    setMessageQueueDelimiter(messageQueueDelimiter: string) {
      state.config.messageQueueDelimiter = messageQueueDelimiter;
    },
    setAsciiOnly(asciiOnly: boolean) {
      state.config.asciiOnly = asciiOnly;
    },
    setSuppressStartupDurations(suppressStartupDurations: boolean) {
      state.config.suppressStartupDurations = suppressStartupDurations;
    },
    setSuppressToolEditDiffs(suppressToolEditDiffs: boolean) {
      state.config.suppressToolEditDiffs = suppressToolEditDiffs;
    },
    setCompactWithStructuredOutput(compactWithStructuredOutput: boolean) {
      state.config.compactWithStructuredOutput = compactWithStructuredOutput;
    },
    setReasoning(reasoning: Reasoning) {
      state.config.reasoning = reasoning;
    },
    setMcps(mcps: Record<string, Mcp>) {
      state.config.mcps = mcps;
    },
    setUsageLimit(usageLimit: UsageLimit | undefined) {
      state.config.usageLimit = usageLimit;
    },
  },
  mcp: {
    setClientsAndTools(clients: MCPClients, tools: MCPToolSet) {
      state.mcp.clients = clients;
      state.mcp.tools = tools;
      state.mcp.close = async () => {
        await Promise.all(
          Object.values(clients).map((client) => client.close()),
        );
      };
    },
  },
  abortControllers: {
    setQuestion(controller: AbortController | null) {
      state.abortControllers.question = controller;
    },
    setApiStream(controller: AbortController | null) {
      state.abortControllers.apiStream = controller;
    },
    setExecuteUserInput(controller: AbortController | null) {
      state.abortControllers.executeUserInput = controller;
    },
    setInterruptWithEditorContent(controller: AbortController | null) {
      state.abortControllers.interruptWithEditorContent = controller;
    },
    setTranscription(controller: AbortController | null) {
      state.abortControllers.transcription = controller;
    },
    setRecordProcess(controller: AbortController | null) {
      state.abortControllers.recordProcess = controller;
    },
  },
  resetState() {
    state = createInitialState();
  },
};
