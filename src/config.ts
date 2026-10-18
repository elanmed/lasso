import { dirname } from "node:path";
import * as YAML from "yaml";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogle } from "@ai-sdk/google";
import {
  assertAtBuildtime,
  tryCatchAsync,
  getMessageFromError,
  markdownFence,
  tryCatch,
  stringify,
} from "./utils.ts";
import { actions, getState } from "./state.ts";
import { fsDeps, processDeps } from "./deps.ts";
import { getGlobalConfigPath, getLocalConfigPath } from "./paths.ts";
import {
  MISSING,
  ConfigSchema,
  defaultConfig,
  isSameKey,
  type Config,
} from "./schemas.ts";
import { print, printNewline } from "./printing.ts";

export function getHeaders() {
  const headers: Record<string, string> = {};
  if (getState().config.gateway === "opencode") {
    headers["x-opencode-session"] = getState().session.sessionId;
    headers["x-opencode-client"] = "lasso";
  }
  return headers;
}

export function getLanguageModel(model = getState().config.model) {
  const apiKey = processDeps.env.get("LASSO_API_KEY");
  const sdkProvider = getState().config.sdkProvider;

  assertAtBuildtime(apiKey !== undefined);
  assertAtBuildtime(sdkProvider !== MISSING);

  const baseURL = getState().config.baseURL;
  const headers = getHeaders();

  switch (sdkProvider) {
    case "openai-compatible": {
      assertAtBuildtime(baseURL !== undefined);
      return createOpenAICompatible({
        apiKey,
        baseURL,
        name: "openai-compatible",
        headers,
      }).chatModel(model);
    }
    case "anthropic": {
      return createAnthropic({
        apiKey,
        headers,
        ...(baseURL === undefined ? {} : { baseURL }),
      })(model);
    }
    case "openai": {
      return createOpenAI({
        apiKey,
        headers,
        ...(baseURL === undefined ? {} : { baseURL }),
      })(model);
    }
    case "google": {
      return createGoogle({
        apiKey,
        headers,
        ...(baseURL === undefined ? {} : { baseURL }),
      })(model);
    }
    default: {
      sdkProvider satisfies never;
      throw new Error("Unhandled sdkProvider");
    }
  }
}

export function getTranscriptionProvider() {
  const apiKey = processDeps.env.get("LASSO_TRANSCRIPTION_API_KEY");
  assertAtBuildtime(apiKey !== undefined);

  const { transcriptionBaseURL, transcriptionSdkProvider } = getState().config;
  assertAtBuildtime(transcriptionSdkProvider !== undefined);

  switch (transcriptionSdkProvider) {
    case "openai": {
      return createOpenAI({
        apiKey,
        ...(transcriptionBaseURL === undefined
          ? {}
          : { baseURL: transcriptionBaseURL }),
      });
    }
    case "google": {
      return createGoogle({
        apiKey,
        ...(transcriptionBaseURL === undefined
          ? {}
          : { baseURL: transcriptionBaseURL }),
      });
    }
    default: {
      transcriptionSdkProvider satisfies never;
      throw new Error("Unhandled transcriptionSdkProvider");
    }
  }
}

export async function readConfigFileStr(path: string) {
  const pathExistsResult = tryCatch(() => fsDeps.existsSync(path));
  if (!pathExistsResult.ok) {
    print.error(
      `Failed to check if ${path} exists. Error: ${getMessageFromError(pathExistsResult.error)}`,
    );
    return "{}";
  }
  if (!pathExistsResult.value) return "{}";

  const readResult = await tryCatchAsync(fsDeps.readFile(path, "utf8"));
  if (!readResult.ok) {
    actions.appendConfigWarningMessage(
      `Failed to read the config file at \`${path}\`, using the default config. Error: ${getMessageFromError(readResult.error, { forceSingleLine: true })}`,
    );
    return "{}";
  }

  return readResult.value;
}

export function parseConfigFileStr(
  configFileStr: string,
  path: string,
): Partial<Config> {
  const parseResult = tryCatch((): unknown => YAML.parse(configFileStr));
  if (!parseResult.ok) {
    actions.appendConfigErrorMessage(
      `Invalid YAML in \`${path}\`, using the default config. Error: ${getMessageFromError(parseResult.error, { forceSingleLine: true })}`,
    );
    return {};
  }

  const configResult = ConfigSchema.safeParse(parseResult.value);
  if (configResult.success) return configResult.data;
  actions.appendConfigErrorMessage(
    `Failed to validate \`${path}\`, using the default config. Error: ${getMessageFromError(configResult.error, { forceSingleLine: true })}`,
  );
  return {};
}

export function printMissingConfigWarnings() {
  if (getState().config.suppressConfigWarnings) return;

  const messages = getState().content.configWarningMessages;
  if (messages.length === 0) return;

  printNewline();
  print.warning("Warnings:");
  print.warning(messages.map((message) => `- ${message}`).join("\n"));
  printNewline();
  print.warning(
    `Suppress these warnings via the \`suppressConfigWarnings\` config option`,
  );
  printNewline();
}

export function printMissingConfigErrors() {
  const messages = getState().content.configErrorMessages;
  if (messages.length === 0) return false;

  printNewline();
  print.error("Errors:");
  print.error(messages.map((message) => `- ${message}`).join("\n"));
  if (getState().content.includeConfigInitMessage) {
    printNewline();
    print.error(
      "Run /initlocal or /initglobal to generate a sample config in `./.lasso` or `~/.config/lasso` respectively, then /reload to apply it to the current session.",
    );
  }
  printNewline();
  return true;
}

function filterNulls<T>(entries: Record<string, T | null>): Record<string, T> {
  const filtered: Record<string, T> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === null) continue;
    filtered[key] = value;
  }
  return filtered;
}

export function initStateFromConfig({
  localConfig,
  globalConfig,
}: {
  localConfig: Partial<Config>;
  globalConfig: Partial<Config>;
}) {
  const defaultedModel =
    localConfig.model ?? globalConfig.model ?? defaultConfig.model;

  const defaultedSdkProvider =
    localConfig.sdkProvider ??
    globalConfig.sdkProvider ??
    defaultConfig.sdkProvider;
  const defaultedGateway =
    localConfig.gateway ?? globalConfig.gateway ?? defaultConfig.gateway;
  const defaultedBaseURL = localConfig.baseURL ?? globalConfig.baseURL;

  const defaultedTranscriptionSdkProvider =
    localConfig.transcriptionSdkProvider ??
    globalConfig.transcriptionSdkProvider ??
    defaultConfig.transcriptionSdkProvider;
  const defaultedTranscriptionModel =
    localConfig.transcriptionModel ??
    globalConfig.transcriptionModel ??
    defaultConfig.transcriptionModel;
  const defaultedTranscriptionBaseURL =
    localConfig.transcriptionBaseURL ?? globalConfig.transcriptionBaseURL;

  if (
    defaultedBaseURL === undefined &&
    defaultedSdkProvider === "openai-compatible"
  ) {
    actions.appendConfigErrorMessage(
      `A \`baseURL\` is required when \`sdkProvider\` is \`openai-compatible\``,
    );
  }

  actions.setModel(defaultedModel);
  if (defaultedBaseURL !== undefined) actions.setBaseURL(defaultedBaseURL);
  actions.setSdkProvider(defaultedSdkProvider);
  actions.setGateway(defaultedGateway);
  if (defaultedTranscriptionSdkProvider !== undefined) {
    actions.setTranscriptionSdkProvider(defaultedTranscriptionSdkProvider);
  }
  if (defaultedTranscriptionModel !== undefined) {
    actions.setTranscriptionModel(defaultedTranscriptionModel);
  }
  if (defaultedTranscriptionBaseURL !== undefined) {
    actions.setTranscriptionBaseURL(defaultedTranscriptionBaseURL);
  }

  const defaultedPricingPerModel = filterNulls({
    ...defaultConfig.pricingPerModel,
    ...globalConfig.pricingPerModel,
    ...localConfig.pricingPerModel,
  });
  actions.setPricingPerModel(defaultedPricingPerModel);
  const defaultedContextWindowPerModel = filterNulls({
    ...defaultConfig.contextWindowPerModel,
    ...globalConfig.contextWindowPerModel,
    ...localConfig.contextWindowPerModel,
  });
  actions.setContextWindowPerModel(defaultedContextWindowPerModel);
  actions.setCustomSlashCommandDirs(
    localConfig.customSlashCommandDirs ??
      globalConfig.customSlashCommandDirs ??
      defaultConfig.customSlashCommandDirs,
  );
  actions.setCustomSkillDirs(
    localConfig.customSkillDirs ??
      globalConfig.customSkillDirs ??
      defaultConfig.customSkillDirs,
  );
  actions.setSubagentModels(
    localConfig.subagentModels ??
      globalConfig.subagentModels ??
      defaultConfig.subagentModels,
  );
  const defaultedKeymaps = {
    ...defaultConfig.keymaps,
    ...globalConfig.keymaps,
    ...localConfig.keymaps,
  };
  const keyedCommands = Object.entries(defaultedKeymaps);
  for (const [i, [commandA, keymapA]] of keyedCommands.entries()) {
    for (const [commandB, keymapB] of keyedCommands.slice(i + 1)) {
      if (!isSameKey(keymapA, keymapB)) continue;
      actions.appendConfigErrorMessage(
        `\`keymaps\` must be unique: \`${commandA}\` and \`${commandB}\` are both bound to \`${stringify(keymapA)}\``,
      );
    }
  }

  actions.setKeymaps(defaultedKeymaps);
  actions.setLoadingStateFrames(
    localConfig.loadingStateFrames ??
      globalConfig.loadingStateFrames ??
      defaultConfig.loadingStateFrames,
  );
  actions.setLoadingStateFrameDuration(
    localConfig.loadingStateFrameDuration ??
      globalConfig.loadingStateFrameDuration ??
      defaultConfig.loadingStateFrameDuration,
  );
  actions.setPromptPrefix(
    localConfig.promptPrefix ??
      globalConfig.promptPrefix ??
      defaultConfig.promptPrefix,
  );
  actions.setSuppressConfigWarnings(
    localConfig.suppressConfigWarnings ??
      globalConfig.suppressConfigWarnings ??
      defaultConfig.suppressConfigWarnings,
  );
  actions.setSuppressToolEditDiffs(
    localConfig.suppressToolEditDiffs ??
      globalConfig.suppressToolEditDiffs ??
      defaultConfig.suppressToolEditDiffs,
  );
  actions.setAsciiOnly(
    localConfig.asciiOnly ?? globalConfig.asciiOnly ?? defaultConfig.asciiOnly,
  );
  actions.setCompactWithStructuredOutput(
    localConfig.compactWithStructuredOutput ??
      globalConfig.compactWithStructuredOutput ??
      defaultConfig.compactWithStructuredOutput,
  );
  actions.setMessageQueueDelimiter(
    localConfig.messageQueueDelimiter ??
      globalConfig.messageQueueDelimiter ??
      defaultConfig.messageQueueDelimiter,
  );
  actions.setReasoning(
    localConfig.reasoning ?? globalConfig.reasoning ?? defaultConfig.reasoning,
  );
  const defaultedMcps = {
    ...defaultConfig.mcps,
    ...globalConfig.mcps,
    ...localConfig.mcps,
  };
  actions.setMcps(defaultedMcps);

  const defaultedUsageLimit = localConfig.usageLimit ?? globalConfig.usageLimit;

  if (
    defaultedUsageLimit !== undefined &&
    defaultedPricingPerModel[defaultedModel] === undefined
  ) {
    actions.appendConfigWarningMessage(
      `Usage limit is disabled because there is no \`pricingPerModel\` entry for the current model \`${defaultedModel}\``,
    );
  }

  if (defaultedContextWindowPerModel[defaultedModel] === undefined) {
    actions.appendConfigWarningMessage(
      `A default context window of 128,000 tokens is used because there is no \`contextWindowPerModel\` entry for the current model \`${defaultedModel}\``,
    );
  }

  actions.setUsageLimit(defaultedUsageLimit);

  let includeConfigCommand = false;
  if (getState().config.sdkProvider === MISSING) {
    includeConfigCommand = true;
    actions.appendConfigErrorMessage(
      "Set `sdkProvider` in your config file (`openai-compatible` or `anthropic`)",
    );
  }

  if (getState().config.model === MISSING) {
    includeConfigCommand = true;
    actions.appendConfigErrorMessage("Set `model` in your config file");
  }
  actions.setIncludeConfigInitMessage(includeConfigCommand);

  if (processDeps.env.get("LASSO_API_KEY") === undefined) {
    actions.appendConfigErrorMessage(
      "Set the `LASSO_API_KEY` environment variable, e.g. `export LASSO_API_KEY=...`",
    );
  }
}

export async function initStateFirst() {
  actions.setDebugLog(processDeps.env.get("DEBUG") === "1");

  const globalConfigStr = await readConfigFileStr(getGlobalConfigPath());
  const globalConfig = parseConfigFileStr(
    globalConfigStr,
    getGlobalConfigPath(),
  );
  actions.setGlobalConfigStr(globalConfigStr);

  const localConfigStr = await readConfigFileStr(getLocalConfigPath());
  const localConfig = parseConfigFileStr(localConfigStr, getLocalConfigPath());
  actions.setLocalConfigStr(localConfigStr);

  actions.setSuppressStartupDurations(
    localConfig.suppressStartupDurations ??
      globalConfig.suppressStartupDurations ??
      defaultConfig.suppressStartupDurations,
  );

  return { globalConfig, localConfig };
}

export function getAllPrettyConfig() {
  const globalConfigTitle = `Global config from path: ${getGlobalConfigPath()}`;
  const localConfigTitle = `Local config from path: ${getLocalConfigPath()}`;

  return `# Applied config

${markdownFence("json", stringify(getState().config))}

# ${globalConfigTitle}

${markdownFence("yaml", getState().content.globalConfigStr)}

# ${localConfigTitle}

${markdownFence("yaml", getState().content.localConfigStr)}`;
}

export function resetConfigMessages() {
  actions.resetConfigErrorMessages();
  actions.resetConfigWarningMessages();
  actions.setIncludeConfigInitMessage(false);
}

const getDefaultConfig = (
  command: "initlocal" | "initglobal",
) => `# This config was auto-generated by the /${command} command
model: claude-haiku-5-5
sdkProvider: anthropic
contextWindowPerModel:
  claude-haiku-5-5: 100000
  gpt-6-luna: 1050000
  glm-5.3-flash: 1300000
pricingPerModel:
  claude-haiku-5-5:
    inputPerMillion: 0.1
    outputPerMillion: 0.5
    cacheReadPerMillion: 0.01
    cacheWritePerMillion: 0.13
  gpt-6-luna:
    inputPerMillion: 0.1
    outputPerMillion: 0.5
    cacheReadPerMillion: 0.01
    cacheWritePerMillion: 0.13
  glm-5.3-flash:
    inputPerMillion: 0.15
    outputPerMillion: 0.5
    cacheReadPerMillion: 0.03
usageLimit:
  dollarAmount: 100
  duration: 12h

# model: gpt-6-luna
# sdkProvider: openai

# model: glm-5.3-flash
# sdkProvider: openai-compatible
# baseURL: https://opencode.ai/zen/v1
\n`;

export async function initLocalConfig() {
  const path = getLocalConfigPath();

  const pathExistsResult = tryCatch(() => fsDeps.existsSync(path));
  if (!pathExistsResult.ok) {
    print.error(
      `Failed to check if ${path} exists. Error: ${getMessageFromError(pathExistsResult.error)}`,
    );
    return;
  }
  if (pathExistsResult.value) {
    print.warning(`The local config already exists at ${path}`);
    return;
  }

  const dir = dirname(path);
  const dirExistsResult = tryCatch(() => fsDeps.existsSync(dir));
  if (!dirExistsResult.ok) {
    print.error(
      `Failed to check if ${dir} exists. Error: ${getMessageFromError(dirExistsResult.error)}`,
    );
    return;
  }
  if (!dirExistsResult.value) {
    const mkdirResult = await tryCatchAsync(
      fsDeps.mkdir(dir, { recursive: true }),
    );
    if (!mkdirResult.ok) {
      print.error(`Failed to create the directory: ${dir}`);
      return;
    }
  }

  const writeResult = await tryCatchAsync(
    fsDeps.writeFile(path, getDefaultConfig("initlocal")),
  );
  if (!writeResult.ok) {
    print.error(`Failed to write the config to ${path}`);
    return;
  }
  print.info(`Created the local config at ${path}`);
}

export async function initGlobalConfig() {
  const path = getGlobalConfigPath();

  const pathExistsResult = tryCatch(() => fsDeps.existsSync(path));
  if (!pathExistsResult.ok) {
    print.error(
      `Failed to check if ${path} exists. Error: ${getMessageFromError(pathExistsResult.error)}`,
    );
    return;
  }
  if (pathExistsResult.value) {
    print.warning(`The global config already exists at ${path}`);
    return;
  }

  const dir = dirname(path);
  const dirExistsResult = tryCatch(() => fsDeps.existsSync(dir));
  if (!dirExistsResult.ok) {
    print.error(
      `Failed to check if ${dir} exists. Error: ${getMessageFromError(dirExistsResult.error)}`,
    );
    return;
  }
  if (!dirExistsResult.value) {
    const mkdirResult = await tryCatchAsync(
      fsDeps.mkdir(dir, { recursive: true }),
    );
    if (!mkdirResult.ok) {
      print.error(`Failed to create the directory: ${dir}`);
      return;
    }
  }

  const writeResult = await tryCatchAsync(
    fsDeps.writeFile(path, getDefaultConfig("initglobal")),
  );
  if (!writeResult.ok) {
    print.error(`Failed to write the config to ${path}`);
    return;
  }
  print.info(`Created the global config at ${path}`);
}
