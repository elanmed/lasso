import os from "node:os";
import { join } from "node:path";
import { processDeps } from "./deps.ts";
import { assertAtRuntime, getShortId, isShellSafePath } from "./utils.ts";

export function getTempFilePath({
  pathPrefix,
  extension,
}: {
  pathPrefix?: string | undefined;
  extension?: string | undefined;
} = {}) {
  const tempFile = join(
    os.tmpdir(),
    `${pathPrefix ?? "lasso"}-${getShortId()}.${extension ?? "txt"}`,
  );
  assertAtRuntime(isShellSafePath(tempFile));
  return tempFile;
}

export function getGlobalConfigDir() {
  const configHome = processDeps.env.get("XDG_CONFIG_HOME");
  if (configHome !== undefined) return join(configHome, "lasso");
  return join(os.homedir(), ".config", "lasso");
}

export function getStateDir() {
  const stateHome = processDeps.env.get("XDG_STATE_HOME");
  if (stateHome !== undefined) return join(stateHome, "lasso");
  return join(os.homedir(), ".local", "state", "lasso");
}

export function getDataDir() {
  const dataHome = processDeps.env.get("XDG_DATA_HOME");
  if (dataHome !== undefined) return join(dataHome, "lasso");
  return join(os.homedir(), ".local", "share", "lasso");
}

export function getLocalConfigDir() {
  return join(processDeps.cwd(), ".lasso");
}

export function getGlobalConfigPath() {
  return join(getGlobalConfigDir(), "settings.yaml");
}

export function getLocalConfigPath() {
  return join(getLocalConfigDir(), "settings.yaml");
}

export function getGlobalContextDir() {
  return join(getGlobalConfigDir(), "context");
}

export function getGlobalSkillDir() {
  return join(getGlobalConfigDir(), "skills");
}

export function getLocalSkillDir() {
  return join(getLocalConfigDir(), "skills");
}

export function getLocalAgentSkillDir() {
  return join(processDeps.cwd(), ".agents", "skills");
}

export function getGlobalAgentSkillDir() {
  return join(os.homedir(), ".agents", "skills");
}

export function getLocalSlashCommandDir() {
  return join(getLocalConfigDir(), "commands");
}

export function getLocalAgentSlashCommandDir() {
  return join(processDeps.cwd(), ".agents", "commands");
}

export function getGlobalAgentSlashCommandDir() {
  return join(os.homedir(), ".agents", "commands");
}

export function getGlobalSlashCommandDir() {
  return join(getGlobalConfigDir(), "commands");
}

export function getSessionDir() {
  return join(getStateDir(), "sessions");
}

export function getWebpagesDir() {
  return join(getStateDir(), "webpages");
}

export function getDebugLogDir() {
  return join(getStateDir(), "debug");
}

export function getUsageLogPath() {
  return join(getDataDir(), "usage.json");
}

export function getUsageLogLockPath() {
  return join(getDataDir(), "usage.lock");
}
