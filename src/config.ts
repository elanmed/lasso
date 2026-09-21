import { join } from "node:path";
import * as YAML from "yaml";
import { getShortId, safeStringify, stringify, tryCatch } from "./utils.ts";
import { getAvailableSlashCommands } from "./slash-commands.ts";
import {
  getContextEntries,
  getContextFilesStr,
  getSkillsStr,
  getSkills,
} from "./context.ts";
import { actions, createPerformanceLogger, getState } from "./state.ts";
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
import { print } from "./print.ts";
import { initMcpState } from "./mcp.ts";
import { getTools } from "./tools.ts";

export function readConfigFileStr(path: string) {
  if (!fsDeps.existsSync(path)) return "{}";

  const readResult = tryCatch(() => fsDeps.readFileSync(path).toString());
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

  if (
    defaultedBaseURL === undefined &&
    defaultedSdkProvider === "openai-compatible"
  ) {
    throw new Error(
      `A \`baseURL\` is required when \`sdkProvider=openai-compatible\` in either ${getLocalConfigPath()} or ${getGlobalConfigPath()}`,
    );
  }

  if (defaultedBaseURL !== undefined && defaultedSdkProvider === "anthropic") {
    print.warning(
      `The \`baseURL\` option is not used when \`sdkProvider=anthropic\``,
    );
  }

  actions.setModel(defaultedModel);
  if (defaultedBaseURL !== undefined) actions.setBaseURL(defaultedBaseURL);
  actions.setSdkProvider(defaultedSdkProvider);
  actions.setGateway(defaultedGateway);

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
      `usage limit disabled: no \`pricingPerModel\` entry for the current model \`${defaultedModel}\``,
    );
  }

  actions.setUsageLimit(defaultedUsageLimit);
}

export async function initStateFromFs({
  logDuration = false,
}: { logDuration?: boolean } = {}) {
  const shouldLogDuration =
    logDuration && !getState().config.hideStartupDurations;
  const performanceLogger = createPerformanceLogger({
    logDuration: shouldLogDuration,
  });
  await syncInitialModelUsageForLimitWindow();

  performanceLogger.start();
  const contextEntries = getContextEntries();
  actions.setContextEntries(contextEntries);
  actions.setContextStr(getContextFilesStr(contextEntries));
  performanceLogger.end((duration) =>
    print.doing(`Reading context files: ${duration}`),
  );

  performanceLogger.start();
  const skills = getSkills();
  actions.setSkills(skills);
  actions.setSkillsStr(getSkillsStr(skills));
  performanceLogger.end(
    (duration) => logDuration && print.doing(`Reading skills: ${duration}`),
  );

  performanceLogger.start();
  const slashCommands = getAvailableSlashCommands();
  actions.setSlashCommands(slashCommands);
  performanceLogger.end(
    (duration) =>
      logDuration && print.doing(`Reading slash commands: ${duration}`),
  );
}

export function initStateFirst() {
  actions.setDebugLog(processDeps.env.get("DEBUG") === "1");

  const globalConfigStr = readConfigFileStr(getGlobalConfigPath());
  const globalConfig = parseConfigFileStr(
    globalConfigStr,
    getGlobalConfigPath(),
  );
  actions.setGlobalConfigStr(globalConfigStr);

  const localConfigStr = readConfigFileStr(getLocalConfigPath());
  const localConfig = parseConfigFileStr(localConfigStr, getLocalConfigPath());
  actions.setLocalConfigStr(localConfigStr);

  actions.setHideStartupDurations(
    localConfig.hideStartupDurations ??
      globalConfig.hideStartupDurations ??
      defaultConfig.hideStartupDurations,
  );

  return { globalConfig, localConfig };
}

export async function initStateRepeatable() {
  const { globalConfig, localConfig } = initStateFirst();
  initStateFromConfig({ globalConfig, localConfig });
  await initMcpState();
  actions.setToolsContentStr(safeStringify(getTools()));
  await initStateFromFs();
}

export async function initState() {
  const { globalConfig, localConfig } = initStateFirst();
  const debugLogPath = join(getDebugLogDir(), `debug-${getShortId()}.log`);
  actions.setDebugLogPath(debugLogPath);

  initStateFromConfig({ globalConfig, localConfig });
  await initMcpState();
  actions.setToolsContentStr(safeStringify(getTools()));
  await initStateFromFs({ logDuration: true });
}
