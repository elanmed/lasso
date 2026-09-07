/* eslint-disable @typescript-eslint/no-base-to-string */
import assert from "node:assert";
import type readline from "node:readline/promises";
import type { ModelMessage } from "ai";
import {
  defaultConfig,
  type DefaultedConfig,
  type Key,
  type ModelPricing,
  type SdkProvider,
  type UsageLimit,
} from "./config-types.ts";
import { MISSING } from "./deps.ts";
import { getShortId, stringify } from "./utils.ts";
import { debugLog } from "./debug-log.ts";
import type { ModelUsage } from "./usage.ts";
import type { ContextEntry, Skill } from "./context.ts";

export interface SlashCommand {
  name: string;
  filePath: string;
  content: string;
}

interface State {
  app: {
    messageParams: {
      tokens: number;
      tokensStale: boolean;
      messages: ModelMessage[];
    };
    editorInputValue: string | null;
    slashCommands: SlashCommand[];
    stdout: string;
    debugLog: boolean;
    debugLogPath: string;
    chatHistoryPath: string;
    contextEntries: ContextEntry[];
    contextStr: string;
    globalConfigStr: string;
    localConfigStr: string;
    skillsStr: string;
    skills: Skill[];
    subagentModels: string[];
    rl: readline.Interface | null;
    loadingStateTimeout: NodeJS.Timeout | null;
    loadingStateFrameIdx: number;
    apiStartTime: number | null;
    apiEndTime: number | null;
    modelUsageForLimitWindow: Record<string, ModelUsage[]>;
    modelUsageForSession: Record<string, ModelUsage[]>;
    sessionStartDate: number;
    sessionId: string;
  };
  config: DefaultedConfig;
  abortControllers: {
    question: AbortController | null;
    apiStream: AbortController | null;
    interruptWithEditorContent: AbortController | null;
  };
}

const createInitialState = (): State => ({
  app: {
    messageParams: { tokens: 0, tokensStale: false, messages: [] },
    editorInputValue: null,
    slashCommands: [],
    stdout: "",
    debugLog: false,
    debugLogPath: "",
    chatHistoryPath: "",
    contextEntries: [],
    contextStr: "",
    globalConfigStr: "",
    localConfigStr: "",
    skillsStr: "",
    skills: [],
    subagentModels: [],
    rl: null,
    loadingStateTimeout: null,
    loadingStateFrameIdx: 0,
    apiStartTime: null,
    apiEndTime: null,
    modelUsageForLimitWindow: {},
    modelUsageForSession: {},
    sessionStartDate: Date.now(),
    sessionId: getShortId(),
  },
  config: {
    model: MISSING,
    baseURL: undefined,
    sdkProvider: defaultConfig.sdkProvider,
    gateway: undefined,
    pricingPerModel: structuredClone(defaultConfig.pricingPerModel),
    contextWindowPerModel: structuredClone(defaultConfig.contextWindowPerModel),
    compactTriggerRatio: defaultConfig.compactTriggerRatio,
    compactTargetRatio: defaultConfig.compactTargetRatio,
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
    messageQueueDelimiter: defaultConfig.messageQueueDelimiter,
    usageLimit: undefined,
  },
  abortControllers: {
    question: null,
    apiStream: null,
    interruptWithEditorContent: null,
  },
});

let state: State = createInitialState();

export const getState = () => state;

const logStateChange = (actionType: string, before: string, after: string) => {
  debugLog(
    state.app.debugLog,
    state.app.debugLogPath,
    `dispatch ${actionType}: before=${before}, after=${after}`,
  );
};

export const actions = {
  appendToMessageParams(message: ModelMessage) {
    const before = state.app.messageParams.messages.length;
    state.app.messageParams.messages.push(message);
    logStateChange(
      "append-to-message-params",
      String(before),
      String(state.app.messageParams.messages.length),
    );
  },

  setMessageParamTokens(tokens: number) {
    const before = state.app.messageParams.tokens;
    state.app.messageParams.tokens = tokens;
    logStateChange("set-message-param-tokens", String(before), String(tokens));
  },

  setMessageParamTokensStale(tokensStale: boolean) {
    const before = state.app.messageParams.tokensStale;
    state.app.messageParams.tokensStale = tokensStale;
    logStateChange(
      "set-message-param-tokens-stale",
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
    const before = state.app.subagentModels;
    state.app.subagentModels = subagentModels;
    state.config.subagentModels = subagentModels;
    logStateChange(
      "set-subagent-models",
      stringify(before),
      stringify(subagentModels),
    );
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

  setCompactTriggerRatio(compactTriggerRatio: number) {
    const before = state.config.compactTriggerRatio;
    state.config.compactTriggerRatio = compactTriggerRatio;
    logStateChange(
      "set-compact-trigger-ratio",
      String(before),
      String(compactTriggerRatio),
    );
  },

  setCompactTargetRatio(compactTargetRatio: number) {
    const before = state.config.compactTargetRatio;
    state.config.compactTargetRatio = compactTargetRatio;
    logStateChange(
      "set-compact-target-ratio",
      String(before),
      String(compactTargetRatio),
    );
  },

  setKeymaps(keymaps: DefaultedConfig["keymaps"]) {
    const before = structuredClone(state.config.keymaps);
    state.config.keymaps = keymaps;
    logStateChange("set-keymaps", stringify(before), stringify(keymaps));
  },

  setKeymap(command: string, keymap: Key) {
    const before = state.config.keymaps[command];
    state.config.keymaps[command] = keymap;
    logStateChange(
      `set-keymap-${command}`,
      stringify(before),
      stringify(keymap),
    );
  },

  resetMessageParams() {
    const before = state.app.messageParams.tokens;
    state.app.messageParams = { tokens: 0, tokensStale: false, messages: [] };
    logStateChange("reset-message-params", String(before), "0");
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

  setEditorInputValue(value: string | null) {
    assert(value !== "");
    const before = state.app.editorInputValue;
    state.app.editorInputValue = value;
    logStateChange("set-editor-input-value", String(before), String(value));
  },

  setSlashCommands(commands: SlashCommand[]) {
    const before = state.app.slashCommands;
    state.app.slashCommands = commands;
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
    const before = state.app.stdout;
    state.app.stdout = "";
    logStateChange("reset-stdout", before, "");
  },

  appendToStdout(line: string) {
    const before = state.app.stdout;
    state.app.stdout += line;
    state.app.stdout = state.app.stdout.slice(-2);
    logStateChange(
      "append-to-stdout",
      String(before.length),
      String(state.app.stdout.length),
    );
  },

  setDebugLog(debugLog: boolean) {
    // `logStateChange` returns early when `debugLog=false`
    // so it can't be called in the fn where `debugLog` is set
    state.app.debugLog = debugLog;
  },

  setDebugLogPath(debugLogPath: string) {
    const before = state.app.debugLogPath;
    state.app.debugLogPath = debugLogPath;
    logStateChange("set-debug-log-path", before, debugLogPath);
  },

  setChatHistoryPath(chatHistoryPath: string) {
    const before = state.app.chatHistoryPath;
    state.app.chatHistoryPath = chatHistoryPath;
    logStateChange("set-chat-history-path", before, chatHistoryPath);
  },

  setContextEntries(contextEntries: ContextEntry[]) {
    const before = state.app.contextEntries.length;
    state.app.contextEntries = contextEntries;
    logStateChange(
      "set-context-entries",
      String(before),
      String(state.app.contextEntries.length),
    );
  },

  setContextStr(contextStr: string) {
    const before = state.app.contextStr;
    state.app.contextStr = contextStr;
    logStateChange(
      "set-context-str",
      String(before.length),
      String(contextStr.length),
    );
  },

  setGlobalConfigStr(globalConfigStr: string) {
    const before = state.app.globalConfigStr;
    state.app.globalConfigStr = globalConfigStr;
    logStateChange(
      "set-global-config-str",
      String(before.length),
      String(globalConfigStr.length),
    );
  },

  setLocalConfigStr(localConfigStr: string) {
    const before = state.app.localConfigStr;
    state.app.localConfigStr = localConfigStr;
    logStateChange(
      "set-local-config-str",
      String(before.length),
      String(localConfigStr.length),
    );
  },

  setSkillsStr(skillsStr: string) {
    const before = state.app.skillsStr;
    state.app.skillsStr = skillsStr;
    logStateChange(
      "set-skills-str",
      String(before.length),
      String(skillsStr.length),
    );
  },

  setSkills(skills: Skill[]) {
    const before = state.app.skills.length;
    state.app.skills = skills;
    logStateChange(
      "set-skills",
      String(before),
      String(state.app.skills.length),
    );
  },

  setModelUsageForLimitWindow(
    modelUsageForLimitWindow: Record<string, ModelUsage[]>,
  ) {
    const before = state.app.modelUsageForLimitWindow;
    state.app.modelUsageForLimitWindow = modelUsageForLimitWindow;

    logStateChange(
      "set-model-usage-for-limit-window",
      String(Object.keys(before).length),
      String(Object.keys(state.app.modelUsageForLimitWindow).length),
    );
  },

  setModelUsageForSession(modelUsageForSession: Record<string, ModelUsage[]>) {
    const before = state.app.modelUsageForSession;
    state.app.modelUsageForSession = modelUsageForSession;

    logStateChange(
      "set-model-usage-for-session",
      String(Object.keys(before).length),
      String(Object.keys(state.app.modelUsageForSession).length),
    );
  },

  appendToModelUsageForSession(usage: ModelUsage) {
    const model = state.config.model;
    state.app.modelUsageForSession[model] ??= [];

    const before = state.app.modelUsageForSession[model];
    state.app.modelUsageForSession[model].push(usage);

    logStateChange(
      "append-to-model-usage-for-session",
      String(before.length),
      String(state.app.modelUsageForSession[model].length),
    );
  },

  setRl(rl: readline.Interface | null) {
    const before = state.app.rl;
    state.app.rl = rl;
    logStateChange("set-rl", String(before), String(rl));
  },

  setLoadingStateTimeout(timeout: NodeJS.Timeout | null) {
    const before = state.app.loadingStateTimeout;
    state.app.loadingStateTimeout = timeout;
    logStateChange(
      "set-loading-state-timeout",
      String(before),
      String(timeout),
    );
  },

  setApiStartTime() {
    const before = state.app.apiStartTime;
    const now = performance.now();
    state.app.apiStartTime = now;
    logStateChange("set-api-start-time", String(before), String(now));
  },

  setApiEndTime() {
    const before = state.app.apiEndTime;
    const now = performance.now();
    state.app.apiEndTime = now;
    logStateChange("set-api-end-time", String(before), String(now));
  },

  resetState() {
    state = createInitialState();
    logStateChange("reset-state", "[truncating]", stringify(state));
  },

  incrementLoadingStateFrameIdx() {
    const before = state.app.loadingStateFrameIdx;
    state.app.loadingStateFrameIdx++;
    const after = state.app.loadingStateFrameIdx;
    logStateChange(
      "set-loading-state-frame-idx",
      String(before),
      String(after),
    );
  },

  resetLoadingStateFrameIdx() {
    const before = state.app.loadingStateFrameIdx;
    state.app.loadingStateFrameIdx = 0;
    logStateChange(
      "set-loading-state-frame-idx",
      String(before),
      String(state.app.loadingStateFrameIdx),
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

  setUsageLimit(usageLimit: UsageLimit | undefined) {
    const before = state.config.usageLimit;
    state.config.usageLimit = usageLimit;
    logStateChange("set-usage-limit", stringify(before), stringify(usageLimit));
  },
};
