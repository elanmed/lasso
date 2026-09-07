import { z } from "zod";
import { getShortId, stringify, tryCatch } from "./utils.ts";
import { getAvailableSlashCommands } from "./input.ts";
import {
  getContextEntries,
  getContextFilesStr,
  getSkillsStr,
  getSkills,
} from "./context.ts";
import { actions, getState } from "./state.ts";
import { parseCliArgs } from "./args.ts";
import { fsDeps, processDeps, MISSING } from "./deps.ts";
import {
  getDebugLogDir,
  getGlobalConfigPath,
  getLocalConfigPath,
} from "./paths.ts";
import { syncInitialModelUsageForLimitWindow } from "./usage.ts";
import { print } from "./print.ts";
import { join } from "node:path";
import * as YAML from "yaml";

const KeySchema = z.object({
  name: z.string().length(1),
  ctrl: z.boolean().optional(),
  meta: z.boolean().optional(),
  shift: z.boolean().optional(),
});

const ModelPricingSchema = z.object({
  inputPerMillion: z.number(),
  outputPerMillion: z.number(),
  cacheReadPerMillion: z.number().optional(),
  cacheWritePerMillion: z.number().optional(),
});

export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export const UsageLimitSchema = z.strictObject({
  duration: z.string().refine(
    (duration) => {
      if (duration.length < 2) return false;
      const suffix = duration.slice(-1);
      if (!["s", "m", "h", "d"].includes(suffix)) return false;
      const prefix = duration.slice(0, -1);
      if (Number.isNaN(Number(prefix))) return false;
      if (Number(prefix) < 0) return false;
      return true;
    },
    {
      message: "usageLimit.duration must be of the format '[>= 0][s,m,h,d]'",
    },
  ),
  dollarAmount: z.number(),
});

export type UsageLimit = z.infer<typeof UsageLimitSchema>;

const SdkProviderSchema = z.enum([
  "anthropic",
  "openai-compatible",
  "openai",
  MISSING,
]);
export type SdkProvider = z.infer<typeof SdkProviderSchema>;

const ModelSchema = z.string();
const BaseURLSchema = z.string();
const GatewaySchema = z.enum(["opencode"]);
const PricingPerModelSchema = z.record(
  z.string(),
  ModelPricingSchema.nullable(),
);
const ContextWindowPerModelSchema = z.record(z.string(), z.number().nullable());
const DefaultedPricingPerModelSchema = z.record(z.string(), ModelPricingSchema);
const DefaultedContextWindowPerModelSchema = z.record(z.string(), z.number());
const CompactTriggerRatioSchema = z.number().min(0).max(1);
const CompactTargetRatioSchema = z.number().min(0).max(1);
const KeymapsSchema = z.record(z.string(), KeySchema.nullable());
const DefaultedKeymapsSchema = z.record(z.string(), KeySchema);
const CustomSlashCommandDirsSchema = z.array(z.string());
const CustomSkillDirsSchema = z.array(z.string());
const SubagentModelsSchema = z.array(z.string());
const LoadingStateFrameDurationSchema = z.number();
const LoadingStateFramesSchema = z
  .array(z.string())
  .refine(
    (frames) => {
      if (frames.length === 0) return true;
      return new Set(frames.map((f) => f.length)).size === 1;
    },
    { message: "All loadingStateFrames strings must be the same length" },
  )
  .refine((frames) => frames.length >= 2, {
    message: "loadingStateFrames must be at least length 2",
  });
const PromptPrefixSchema = z.string();
const SuppressBatUnavailableWarningSchema = z.boolean();
const MessageQueueDelimiterSchema = z.string().endsWith("\n");

export const ConfigSchema = z.strictObject({
  model: ModelSchema.optional(),
  baseURL: BaseURLSchema.optional(),
  sdkProvider: SdkProviderSchema.optional(),
  gateway: GatewaySchema.optional(),
  pricingPerModel: PricingPerModelSchema.optional(),
  contextWindowPerModel: ContextWindowPerModelSchema.optional(),
  compactTriggerRatio: CompactTriggerRatioSchema.optional(),
  compactTargetRatio: CompactTargetRatioSchema.optional(),
  keymaps: KeymapsSchema.optional(),
  customSlashCommandDirs: CustomSlashCommandDirsSchema.optional(),
  customSkillDirs: CustomSkillDirsSchema.optional(),
  subagentModels: SubagentModelsSchema.optional(),
  loadingStateFrameDuration: LoadingStateFrameDurationSchema.optional(),
  loadingStateFrames: LoadingStateFramesSchema.optional(),
  promptPrefix: PromptPrefixSchema.optional(),
  suppressBatUnavailableWarning: SuppressBatUnavailableWarningSchema.optional(),
  messageQueueDelimiter: MessageQueueDelimiterSchema.optional(),
  usageLimit: UsageLimitSchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DefaultedConfigSchema = z.strictObject({
  model: ModelSchema,
  baseURL: BaseURLSchema.optional(),
  sdkProvider: SdkProviderSchema,
  gateway: GatewaySchema.optional(),
  pricingPerModel: DefaultedPricingPerModelSchema,
  contextWindowPerModel: DefaultedContextWindowPerModelSchema,
  compactTriggerRatio: CompactTriggerRatioSchema,
  compactTargetRatio: CompactTargetRatioSchema,
  keymaps: DefaultedKeymapsSchema,
  customSlashCommandDirs: CustomSlashCommandDirsSchema,
  customSkillDirs: CustomSkillDirsSchema,
  subagentModels: SubagentModelsSchema,
  loadingStateFrameDuration: LoadingStateFrameDurationSchema,
  loadingStateFrames: LoadingStateFramesSchema,
  promptPrefix: PromptPrefixSchema,
  suppressBatUnavailableWarning: SuppressBatUnavailableWarningSchema,
  messageQueueDelimiter: MessageQueueDelimiterSchema,
  usageLimit: UsageLimitSchema.optional(),
});

export type DefaultedConfig = z.infer<typeof DefaultedConfigSchema>;

export type Key = z.infer<typeof KeySchema>;

export const defaultConfig: DefaultedConfig = {
  model: MISSING,
  sdkProvider: MISSING,
  gateway: undefined,
  pricingPerModel: {},
  contextWindowPerModel: {},
  compactTriggerRatio: 0.7,
  compactTargetRatio: 0.3,
  keymaps: {
    edit: {
      name: "g",
      ctrl: true,
    },
    paste: {
      name: "v",
      ctrl: true,
    },
  },
  customSlashCommandDirs: [],
  customSkillDirs: [],
  subagentModels: [],
  loadingStateFrameDuration: 80,
  loadingStateFrames: ["|", "/", "-", "\\"],
  promptPrefix: "> ",
  suppressBatUnavailableWarning: false,
  messageQueueDelimiter: "l---\n",
  usageLimit: undefined,
};

export function readConfigFileStr(path: string) {
  if (!fsDeps.existsSync(path)) return "{}";

  const readResult = tryCatch(() => fsDeps.readFileSync(path).toString());
  if (!readResult.ok) return "{}";

  return readResult.value;
}

export function readConfigFile(path: string): Partial<Config> {
  const configFileStr = readConfigFileStr(path);

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
        "\n\nRun /init-local or /init-global to generate a sample config in `./.lasso` or `~/.local/config/lasso` respectively.",
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

export function initStateFromConfig() {
  const globalConfig = readConfigFile(getGlobalConfigPath());
  const localConfig = readConfigFile(getLocalConfigPath());
  actions.setGlobalConfigStr(readConfigFileStr(getGlobalConfigPath()));
  actions.setLocalConfigStr(readConfigFileStr(getLocalConfigPath()));

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
  const defaultedCompactTriggerRatio =
    localConfig.compactTriggerRatio ??
    globalConfig.compactTriggerRatio ??
    defaultConfig.compactTriggerRatio;
  const defaultedCompactTargetRatio =
    localConfig.compactTargetRatio ??
    globalConfig.compactTargetRatio ??
    defaultConfig.compactTargetRatio;
  if (defaultedCompactTriggerRatio <= defaultedCompactTargetRatio) {
    throw new Error(
      `compactTriggerRatio (${String(defaultedCompactTriggerRatio)}) must be greater than compactTargetRatio (${String(defaultedCompactTargetRatio)})`,
    );
  }
  actions.setCompactTriggerRatio(defaultedCompactTriggerRatio);
  actions.setCompactTargetRatio(defaultedCompactTargetRatio);

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
  const defaultedKeymaps = filterNulls({
    ...defaultConfig.keymaps,
    ...globalConfig.keymaps,
    ...localConfig.keymaps,
  });
  const hashableKeymaps = Object.entries(defaultedKeymaps).map(
    ([command, keymap]) => ({
      command,
      keymapStr: stringify(keymap),
    }),
  );
  const keymapCommandsByValue = new Map<string, string>();
  for (const { command, keymapStr } of hashableKeymaps) {
    const existingCommand = keymapCommandsByValue.get(keymapStr);
    if (existingCommand !== undefined) {
      throw new Error(
        `keymaps must be unique: \`${existingCommand}\` and \`${command}\` are both bound to \`${keymapStr}\``,
      );
    }
    keymapCommandsByValue.set(keymapStr, command);
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
  actions.setMessageQueueDelimiter(
    localConfig.messageQueueDelimiter ??
      globalConfig.messageQueueDelimiter ??
      defaultConfig.messageQueueDelimiter,
  );

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

export async function initStateFromFs() {
  await syncInitialModelUsageForLimitWindow();

  const contextEntries = getContextEntries();
  actions.setContextEntries(contextEntries);
  actions.setContextStr(getContextFilesStr(contextEntries));

  const skills = getSkills();
  actions.setSkills(skills);
  actions.setSkillsStr(getSkillsStr(skills));

  const slashCommands = getAvailableSlashCommands();
  actions.setSlashCommands(slashCommands);
}

export function initStateForDebug() {
  const args = parseCliArgs();
  actions.setDebugLog(args.debug);
}

export async function initStateRepeatable() {
  initStateForDebug();
  initStateFromConfig();
  await initStateFromFs();
}

export async function initState() {
  initStateForDebug();
  const debugLogPath = join(getDebugLogDir(), `debug-${getShortId()}.log`);
  actions.setDebugLogPath(debugLogPath);

  initStateFromConfig();
  await initStateFromFs();
}
