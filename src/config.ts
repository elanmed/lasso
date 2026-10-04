import { join } from "node:path";
import * as YAML from "yaml";
import { getShortId, stringify, tryCatch, tryCatchAsync } from "./utils.ts";
import { getAvailableSlashCommands } from "./slash-commands.ts";
import {
  getContextEntries,
  getContextFilesStr,
  getSkillsStr,
  getSkills,
} from "./context.ts";
import { actions, getState, promptDeps } from "./state.ts";
import {
  ConfigSchema,
  defaultConfig,
  isSameKey,
  type Config,
} from "./config-types.ts";
import { MISSING } from "./missing.ts";
import { fsDeps, processDeps } from "./deps.ts";
import {
  getDebugLogDir,
  getGlobalConfigPath,
  getLocalConfigPath,
} from "./paths.ts";
import { syncInitialModelUsageForLimitWindow } from "./usage.ts";
import {
  createParallelPerformanceLogger,
  print,
  type LogIdToLabel,
  type ParallelPerformanceLogger,
} from "./print.ts";
import { initMcpState } from "./mcp.ts";
import { stringifyTools } from "./tools.ts";
import { deleteExpiredSessionFiles, initSessionFile } from "./log.ts";

export async function readConfigFileStr(path: string) {
  if (!fsDeps.existsSync(path)) return "{}";

  const readResult = await tryCatchAsync(fsDeps.readFile(path, "utf8"));
  if (!readResult.ok) return "{}";

  return readResult.value;
}

export function parseConfigFileStr(
  configFileStr: string,
  path: string,
): Partial<Config> {
  const parseResult = tryCatch((): unknown => YAML.parse(configFileStr));
  if (!parseResult.ok) {
    throw new Error(`\`${path}\` is invalid YAML!`);
  }

  const configResult = ConfigSchema.safeParse(parseResult.value);
  if (configResult.success) return configResult.data;
  throw new Error(`Config at \`${path}\` has an invalid option!

${configResult.error}

Update your config and try again.
`);
}

export function blockOnMissingConfig() {
  const apiKey = processDeps.env.get("LASSO_API_KEY");

  const warningMessages: string[] = [];
  let includeConfigCommand = false;

  if (apiKey === undefined) {
    warningMessages.push(
      "Set the `LASSO_API_KEY` environment variable, e.g. `export LASSO_API_KEY=...`",
    );
  }

  if (getState().config.sdkProvider === MISSING) {
    includeConfigCommand = true;
    warningMessages.push(
      "Set `sdkProvider` in your config file (`openai-compatible` or `anthropic`)",
    );
  }

  if (getState().config.model === MISSING) {
    includeConfigCommand = true;
    warningMessages.push("Set `model` in your config file");
  }

  if (warningMessages.length > 0) {
    let formattedMessages = warningMessages
      .map((message) => `- ${message}`)
      .join("\n");

    if (includeConfigCommand) {
      formattedMessages = formattedMessages.concat(
        "\n\nRun /initlocal or /initglobal to generate a sample config in `./.lasso` or `~/.config/lasso` respectively.",
      );
    }

    const warning = `Warning! You're missing required configuration options.
${formattedMessages}`;

    print.warning(warning);
    return true;
  }

  return false;
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
    throw new Error(
      `A \`baseURL\` is required when \`sdkProvider=openai-compatible\` in either ${getLocalConfigPath()} or ${getGlobalConfigPath()}`,
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
      throw new Error(
        `keymaps must be unique: \`${commandA}\` and \`${commandB}\` are both bound to \`${stringify(keymapA)}\``,
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
  actions.setSuppressBatUnavailableWarning(
    localConfig.suppressBatUnavailableWarning ??
      globalConfig.suppressBatUnavailableWarning ??
      defaultConfig.suppressBatUnavailableWarning,
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
    print.warning(
      `- Warning: usage limit is disabled because there is no \`pricingPerModel\` entry for the current model \`${defaultedModel}\``,
    );
  }

  if (defaultedContextWindowPerModel[defaultedModel] === undefined) {
    print.warning(
      `- Warning: using a default context window of 128,000 tokens because there is no \`contextWindowPerModel\` entry for the current model \`${defaultedModel}\``,
    );
  }

  actions.setUsageLimit(defaultedUsageLimit);
}

export async function initStateFromFs({
  performanceLogger,
}: {
  performanceLogger: ParallelPerformanceLogger;
}) {
  await syncInitialModelUsageForLimitWindow();

  performanceLogger.start("context");
  const contextEntries = await getContextEntries();
  actions.setContextEntries(contextEntries);
  actions.setContextStr(getContextFilesStr(contextEntries));
  performanceLogger.end("context");

  performanceLogger.start("skills");
  const skills = await getSkills();
  actions.setSkills(skills);
  actions.setSkillsStr(getSkillsStr(skills));
  performanceLogger.end("skills");

  performanceLogger.start("commands");
  const slashCommands = await getAvailableSlashCommands();
  actions.setSlashCommands(slashCommands);
  performanceLogger.end("commands");
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

export async function initStateRepeatable() {
  const { globalConfig, localConfig } = await initStateFirst();
  initStateFromConfig({ globalConfig, localConfig });
  promptDeps.getToolsContentStr = stringifyTools;

  const performanceLogger = createParallelPerformanceLogger({
    logDuration: !getState().config.suppressStartupDurations,
    logIdToLabel: getMcpLogIdToLabel(),
  });
  performanceLogger.printAllLabels();

  await Promise.all([
    initMcpState({ performanceLogger }),
    initStateFromFs({ performanceLogger }),
  ]);
}

export function getMcpLogIdToLabel(): LogIdToLabel {
  const serverEntries = Object.entries(getState().config.mcps);
  return serverEntries.map(([name]) => [name, `Starting ${name} mcp server: `]);
}

export async function initState() {
  const { globalConfig, localConfig } = await initStateFirst();
  const debugLogPath = join(getDebugLogDir(), `debug-${getShortId()}.log`);
  actions.setDebugLogPath(debugLogPath);

  initStateFromConfig({ globalConfig, localConfig });
  promptDeps.getToolsContentStr = stringifyTools;

  const logIdToLabel: LogIdToLabel = getMcpLogIdToLabel().concat([
    ["context", "Reading context files: "],
    ["skills", "Reading skills: "],
    ["commands", "Reading slash commands: "],
  ]);

  const performanceLogger = createParallelPerformanceLogger({
    logDuration: !getState().config.suppressStartupDurations,
    logIdToLabel,
  });
  performanceLogger.printAllLabels();

  await Promise.all([
    initMcpState({ performanceLogger }),
    initStateFromFs({ performanceLogger }),
    deleteExpiredSessionFiles(),
    initSessionFile(),
  ]);
}
