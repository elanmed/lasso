# Changelog

## v0.3.0 - 2026-09-04

- Add read-write subagents with configurable models, optional model selection, timeout handling, and parallel execution
- Add the `/editpage` command
- Improve reload diffs by separating filenames and only pushing diffs when stdout is available
- Add `@ai-sdk/openai` support
- Add `sdkProvider` and `gateway` configuration, and warn about missing model, `baseURL`, or API key settings
- Add `init-local` and `init-global` commands for initializing configuration
- Improve paged output with command overviews and rendered context and skills sections

## v0.2.0 - 2026-09-01

- Queue multiple prompts in the spawned editor, split automatically on lines with a slash command or via the `messageQueueDelimiter` config option
- Detect and resolve slash commands from the spawned editor
- Validate keymap bindings are unique
- Append extra content after a custom slash command name as context for the llm
- Allow `null` config values to cancel inherited `keymaps`, `pricingPerModel`, and `contextWindowPerModel`
- Warn when `bat` is missing at startup, suppressible with the `suppressBatUnavailableWarning` config option
- Respect `XDG_CONFIG_HOME` for the global config dir

## v0.1.1 - 2026-08-31

- Rename project from `agent-js` to `lasso`
- Rename config dirs from `agent-js` to `lasso` (global `~/.config/agent-js` and local `.agent-js`)
- Rename `AGENT_JS_*` env variables and temp file prefix to `LASSO_*`

## v0.1.0 - 2026-08-31

- Initial release
