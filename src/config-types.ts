import { z } from "zod";
import { MISSING } from "./missing.ts";

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
const KeymapsSchema = z.record(z.string(), KeySchema);
const DefaultedKeymapsSchema = z
  .object({ edit: KeySchema })
  .catchall(KeySchema);
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
const AsciiOnlySchema = z.boolean();
const MessageQueueDelimiterSchema = z.string().endsWith("\n");
const ReasoningSchema = z.enum([
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
export type Reasoning = z.infer<typeof ReasoningSchema>;
const McpHeadersSchema = z.record(z.string(), z.string());
const McpSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("http"),
    url: z.string(),
    protocolVersion: z.string().optional(),
    headers: McpHeadersSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("sse"),
    url: z.string(),
    protocolVersion: z.string().optional(),
    headers: McpHeadersSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).optional(),
  }),
]);
const McpsSchema = z.record(z.string(), McpSchema);

export type Mcp = z.infer<typeof McpSchema>;

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
  asciiOnly: AsciiOnlySchema.optional(),
  messageQueueDelimiter: MessageQueueDelimiterSchema.optional(),
  reasoning: ReasoningSchema.optional(),
  mcps: McpsSchema.optional(),
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
  asciiOnly: AsciiOnlySchema,
  messageQueueDelimiter: MessageQueueDelimiterSchema,
  reasoning: ReasoningSchema,
  mcps: McpsSchema,
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
  compactTriggerRatio: 0.8,
  compactTargetRatio: 0.3,
  keymaps: {
    edit: {
      name: "g",
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
  asciiOnly: false,
  messageQueueDelimiter: "l---\n",
  reasoning: "provider-default",
  mcps: {},
  usageLimit: undefined,
};
