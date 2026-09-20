# Bug / Code-Quality Findings for `lasso`

Each item includes the file(s) involved and the reasoning behind the finding.

### 1. `usage.ts` — usage-log lock is keyed by PID, so parallel subagents in the _same process_ self-block

`createLockUtils`'s `writeLock()` steals the lock from dead processes by checking `process.kill(pid, 0)`. But if two async calls to `syncNewModelUsageForLimitWindow` race **within the same Node process** (e.g. `createSubagentTool` runs tasks in parallel via `Promise.all`, each calling `appendModelUsage`), the second call sees a lock file written by its _own_ process. `process.kill(currentPid, 0)` trivially succeeds (the process is obviously alive), so `writeLock()` returns `false` — the second call believes the lock is legitimately held and gives up after ~250ms, printing "Failed to acquire a lock" and **silently dropping that subagent's usage from `modelUsageForLimitWindow`**, undermining the `usageLimit` dollar-cap feature exactly in the scenario (parallel subagents) the codebase explicitly supports.

---
