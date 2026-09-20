# Changelog

## v0.7.1 - 2026-09-20

- Serialize same-process usage log updates with a queue per lock path so parallel tool calls no longer drop usage records
- Tie the compaction reset and summary re-append together to ensure summaries mirror the first messages before slicing unsummarized messages
- Return null from temp file creation on failure, tolerating missing temp files when diffing tool call changes, cleaning up diffs, and reloading editor content
- Guard `safeStringify` against an undefined stringify result for function symbols and top-level bigint values
- Drop dead prompt token bookkeeping on the abort path
- Check directory existence before creating it, and warn when directory creation fails in debug logging, chat history, prompt history, and the usage log
- Skip the root `AGENTS.md` when turning git-tracked files into context skills, so it is not listed twice
- Read global and local config files once per init instead of once per parse
- Use `isSameKey` for duplicate keymap detection so values missing modifier fields no longer collide
- Clamp uncached input tokens to zero in usage cost calculation when cached input tokens exceed the reported total
- Stop suppressing the `/usage` context window line on narrow terminals
- Write the reset state debug log entry before restoring state so it reflects the reset
- Clarify the info line shown while executing a custom slash command
- Keep mcp clients connected when one client's `tools()` call fails, and print an error instead of dropping the client
- Reject plain git diff errors with a dedicated message for the usage diff, treating missing git and fatal exit codes distinctly
- Make structured output for compaction conditional on the `compactWithStructuredOutput` config option, falling back to plain text

## v0.7.0 - 2026-09-20

- Add structured output for compaction, enforcing summary length via the output schema
- Count harness and mcp tools tokens in compaction token accounting
- Preserve older compact summaries, merging the two oldest when the summary list exceeds five entries
- Add the `/summaries` command to view conversation summaries in a pager via `LASSO_PAGER_SUMMARIES`
- Update the system prompt to bash based tool instructions, including reading images as base64 and temp files counting as reads
- Replace file write tools with the native `bash` tool using discriminated read and create-update-delete inputs, snapshotting files per tool call for diffs
- Add the `hideStartupDurations` config option, defaulting to false, and log startup durations in nanoseconds
- Warn when system instructions exceed their dedicated context window share, and remove the `compactTriggerRatio` and `compactTargetRatio` config options in favor of fixed constants
- Release the usage log lock on early exits, report `createLock` success on the final retry, and print an error when an MCP client fails to start
- Remove windows build targets from `compile.sh`
- Remove the compaction over-target warning since structured output guarantees compaction succeeds
- Fix temp file initialization for tool call diffing

## v0.6.0 - 2026-09-16

- Add the Google SDK provider via `@ai-sdk/google`
- Add the `reasoning` config option, defaulting to the provider default
- Add the `asciiOnly` config option for single-char ascii ellipsis and truncation handling
- Honor the `NO_COLOR` env var and non-tty stdout to disable ansi colors in print, bat flags, and git diff
- Add the `/messages` command to view the full message list in a pager via `LASSO_PAGER_MESSAGES`
- Add the `/lastmessage` command to view the last user message in a pager via `LASSO_PAGER_LAST_MESSAGE`, and rename the empty `pageLastResponse` message to "No llm messages"
- Add a `# [lasso] Editor content` header to pageEditStr pager content
- Compact messages before the api call so the summary and new input are sent together
- Fix narrow terminal toolprint truncation, and single-char ascii ellipsis
- Use the `DEBUG` env var for debug logging instead of a cli flag

## v0.5.0 - 2026-09-11

- Add MCP support with `mcps` configuration: HTTP, SSE, and stdio servers with parallel initialization, graceful failure handling, and tool call logging
- Add the `pageHistory` command with empty history handling
- Prepend latest messages to chat history
- Migrate the AI SDK from v6 to v7
- Bold tool call labels and fence headers
- Fit fence and tool print sections to terminal width with header truncation and overflow handling
- Hide context window usage under 80 terminal columns
- Replace globby with native file discovery for glob and git file lists
- Change the default `compactTriggerRatio` from `0.8` -> `0.7`
- Compaction improvements: approximate stale token counts, include system prompt tokens, record interrupted responses in history
- Redraw the pending question prompt after paging, editing, and reload commands
- Fix truncation and wrapping across tool and fence printing

## v0.4.0 - 2026-09-07

- Add the `/lastresponse` command for paging the last response
- Rename initialization commands to `/initlocal` and `/initglobal`
- Rename built-in pager commands to `/editpage`, `/contextpage`, and `/commandspage`
- Add an `install.sh` installation script and hashes to compiled binaries
- Improve copy and paste server error handling
- Improve interruption handling and editor input state
- Require the `edit` keymap configuration and improve configuration validation errors
- Improve reload diffs by separating sources and adding clearer diff titles

## v0.3.0 - 2026-09-04

- Add read-write subagents with configurable models, optional model selection, timeout handling, and parallel execution
- Add the `/editpage` command
- Improve reload diffs by separating filenames and only pushing diffs when stdout is available
- Add `@ai-sdk/openai` support
- Add `sdkProvider` and `gateway` configuration, and warn about missing model, `baseURL`, or API key settings
- Add `initlocal` and `initglobal` commands for initializing configuration
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
