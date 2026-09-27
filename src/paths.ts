import os from "node:os";
import { join } from "node:path";
import { processDeps } from "./deps.ts";

export function getGlobalConfigDir() {
  const configHome = processDeps.env.get("XDG_CONFIG_HOME");
  if (configHome !== undefined) return join(configHome, "lasso");
  return join(os.homedir(), ".config", "lasso");
}

export function getLocalConfigDir() {
  return join(processDeps.cwd(), ".lasso");
}

export function getGlobalConfigPath() {
  return join(getGlobalConfigDir(), "settings.yaml");
}

export function getDebugLogDir() {
  return join(getGlobalConfigDir(), "debug");
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

export function getLocalSlashCommandDir() {
  return join(getLocalConfigDir(), "commands");
}

export function getGlobalSlashCommandDir() {
  return join(getGlobalConfigDir(), "commands");
}

export function getChatHistoryDir() {
  return join(getGlobalConfigDir(), "history");
}

export function getUsageLogPath() {
  return join(getGlobalConfigDir(), "usage.json");
}

export function getUsageLogLockPath() {
  return join(getGlobalConfigDir(), "usage.lock");
}
