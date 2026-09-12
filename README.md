# `lasso`

_A minimal agent harness to rein in your llm_

![logo](./logo.png)

## Features

- **Minimal**: ~4,800 lines of source code, ~9,400 lines of tests
  - Responses are piped through `bat` to render markdown
  - Multi-line input is supported by spawning an editor of your choice
  - Messages can be queued by typing a custom delimiter (default `l---`) in the spawned editor
- **Tools**: 9 tools to execute bash, fetch from the web, edit files, and launch subagents
  - A `git diff` with `delta` is output whenever a tool changes a file
- **Multiple providers**: Anthropic, OpenAI, or OpenAI-compatible APIs
- **MCP support**: Connect HTTP, SSE, and stdio servers
- **AGENTS.md support**: The root file is included in context, nested files are internally represented as skills
- **Slash commands**: Change agent settings or execute reusable prompts
- **Token usage tracking**: Track spending per model within a configurable time window
- **Context compaction**: The conversation is automatically compacted when nearing the model's context window limit
  - Triggered at `compactTriggerRatio`, down to `compactTargetRatio`
- **Session history**: Transcripts are persisted per session and past sessions can be resumed with `/resume`
- **Keymaps**: Customizable shortcuts for executing built-in slash commands

## Installation

Install the latest release on macOS or Linux:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/elanmed/lasso/master/scripts/install.sh | bash
```

> You should always read a script before curling and executing it!

The installer detects your operating system and architecture, downloads the matching GitHub release binary, and symlinks `lasso` into `~/.local/bin`. Add that directory to `PATH` if needed. Set `XDG_BIN_HOME` or `XDG_DATA_HOME` to override the install locations.

To run the script immediately without adding `~/.local/bin` to `PATH`, export your API key and invoke the symlink directly:

```sh
export LASSO_API_KEY=your-api-key && ~/.local/bin/lasso
```

### Manual installation

> Note that manual installation requires Node.js 24 and pnpm 11.1.0:

```sh
git clone https://github.com/elanmed/lasso.git
cd lasso
pnpm install
node src/index.ts
```

## Configuration

Settings live in `~/.config/lasso/settings.yaml` (global) and `./.lasso/settings.yaml` (local overrides), parsed as YAML 1.2 (the `yaml` package default).

If `model`, `baseURL`, or `LASSO_API_KEY` are missing at startup, lasso warns and suggests `/initlocal` or `/initglobal`, which create a starter `settings.yaml` with a sample model and base URL.

### Config Options

| Option                          | Type                                                                                     | Default                  | Description                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------- |
| `model`                         | `string`                                                                                 | —                        | Model name (required in the merged config)                                 |
| `sdkProvider`                   | `"anthropic"` \| `"openai"` \| `"openai-compatible"`                                     | `openai-compatible`      | AI SDK provider                                                            |
| `gateway`                       | `"opencode"`                                                                             | —                        | Used to append gateway-specific headers                                    |
| `baseURL`                       | `string`                                                                                 | `null`                   | API base URL (required for `openai-compatible`)                            |
| `pricingPerModel`               | `object`                                                                                 | `{}`                     | Token pricing per model per million                                        |
| `contextWindowPerModel`         | `object`                                                                                 | `{}`                     | Context window size in tokens per model                                    |
| `compactTriggerRatio`           | `number`                                                                                 | `0.7`                    | Compact when context usage exceeds this ratio                              |
| `compactTargetRatio`            | `number`                                                                                 | `0.3`                    | Compact down to this context ratio                                         |
| `keymaps`                       | `object`                                                                                 | see below                | Custom keybindings                                                         |
| `customSlashCommandDirs`        | `string[]`                                                                               | `[]`                     | Additional directories for custom slash commands                           |
| `customSkillDirs`               | `string[]`                                                                               | `[]`                     | Additional directories for skills                                          |
| `subagentModels`                | `string[]`                                                                               | `[]`                     | Models available to subagents                                              |
| `loadingStateFrames`            | `string[]`                                                                               | `["\|", "/", "-", "\\"]` | Custom spinner frames                                                      |
| `loadingStateFrameDuration`     | `number`                                                                                 | `80`                     | Spinner frame interval in ms                                               |
| `promptPrefix`                  | `string`                                                                                 | `"> "`                   | Prompt prefix string                                                       |
| `suppressBatUnavailableWarning` | `boolean`                                                                                | `false`                  | Suppress the startup warning when `bat` is missing                         |
| `messageQueueDelimiter`         | `string`                                                                                 | `l---\\n`                | Delimiter line separating multiple messages in the editor input            |
| `reasoning`                     | `"provider-default" \| "none" \| "minimal" \| "low" \|<br>"medium" \| "high" \| "xhigh"` | `provider-default`       | Reasoning effort (`provider-default` uses the provider's default behavior) |
| `mcps`                          | `object`                                                                                 | `{}`                     | Named MCP servers                                                          |
| `usageLimit`                    | `object`                                                                                 | `undefined`              | Dollar limit and tracking window                                           |

### Local Overwrite vs Extend

The local config either overwrites or extends the global config per option:

- **Overwrite**: scalar options (`model`, `sdkProvider`, `gateway`, `baseURL`, `compactTriggerRatio`, `compactTargetRatio`, `loadingStateFrameDuration`, `promptPrefix`, `suppressBatUnavailableWarning`, `messageQueueDelimiter`, `reasoning`, `usageLimit`) and arrays (`customSlashCommandDirs`, `customSkillDirs`, `subagentModels`, `loadingStateFrames`) replace the global value wholesale — arrays are not merged.
- **Extend**: `keymaps`, `mcps`, `pricingPerModel`, and `contextWindowPerModel` merge entry-by-entry with the default and global entries, the local entry winning on conflicts. `pricingPerModel` and `contextWindowPerModel` entries set to `null` cancel the global or default entry (see the relevant sections below).

### MCP Servers

The `mcps` option maps server names to MCP server configurations. The `type` field selects one of the supported transports; `protocolVersion` is optional for HTTP and SSE transports.

| Transport | Required fields | Optional fields              |
| --------- | --------------- | ---------------------------- |
| `http`    | `url`           | `protocolVersion`, `headers` |
| `sse`     | `url`           | `protocolVersion`, `headers` |
| `stdio`   | `command`       | `args`                       |

`headers` is an object mapping strings to strings. `args` is an array of strings passed to the stdio command. MCP server entries merge by name across the default, global, and local configurations, with local entries winning on conflicts.

Example:

```yaml
mcps:
  remote-http:
    type: http
    url: https://mcp.example.com/mcp
    protocolVersion: "2025-03-26"
    headers:
      Authorization: Bearer token
  remote-sse:
    type: sse
    url: https://sse.example.com
    protocolVersion: "2024-11-05"
  local-tools:
    type: stdio
    command: /usr/local/bin/mcp-server
    args:
      - --verbose
```

### Usage Limits

When `usageLimit` is set, the agent tracks the running dollar cost of usage within the configured time window:

| Field          | Type     | Default  | Description                                    |
| -------------- | -------- | -------- | ---------------------------------------------- |
| `duration`     | `string` | required | Time window, e.g. `"5h"` (`[number][s,m,h,d]`) |
| `dollarAmount` | `number` | required | Maximum dollar spend in the window             |

Previous usages are loaded from `~/.config/lasso/usage.json` on startup and entries older than `duration` are filtered out.

If the current model has no `pricingPerModel` entry, usage limiting is disabled for that model and a warning is printed at startup.

The current spend is shown as `$<cost> of $<limit>` in the status line.

Example:

```yaml
usageLimit:
  duration: "5h"
  dollarAmount: 10
```

### Pricing Per Model

Token pricing per model per million tokens:

Each model maps to a pricing object with:

| Field                  | Type     | Default  |
| ---------------------- | -------- | -------- |
| `inputPerMillion`      | `number` | required |
| `outputPerMillion`     | `number` | required |
| `cacheReadPerMillion`  | `number` | optional |
| `cacheWritePerMillion` | `number` | optional |

Example:

```yaml
pricingPerModel:
  claude-sonnet-4-6:
    inputPerMillion: 2.5
    outputPerMillion: 10
    cacheReadPerMillion: 1.25
    cacheWritePerMillion: 3.75
```

Set a model's pricing to `null` to remove it, e.g. to cancel pricing inherited from the global config.

### Context Window Per Model

Context window size in tokens per model, used to decide when to compact the conversation:

Each entry maps a model name to its context window size in tokens:

| Field          | Type     | Default  |
| -------------- | -------- | -------- |
| `<model name>` | `number` | required |

Example:

```yaml
contextWindowPerModel:
  claude-sonnet-4-6: 200000
```

Set a model's context window to `null` to remove it, e.g. to cancel a window inherited from the global config.

### Keymaps

Any slash command (builtin or custom) can be bound to a key via the `keymaps` config, e.g.:

```yaml
keymaps:
  history:
    name: "o"
    ctrl: true
  clear:
    name: "x"
    ctrl: true
```

`edit` has a required default keymap:

| Key    | Type  | Default                     | Description                                                          |
| ------ | ----- | --------------------------- | -------------------------------------------------------------------- |
| `edit` | `Key` | `{ name: "g", ctrl: true }` | Call `$LASSO_EDIT` or `$EDITOR __FILE__` to input multi-line prompts |

Pressing a bound key runs the command directly for `edit`/`paste` (editor) and pager commands (`editpage`, `history`, `config`, `contextpage`, `commandspage`); all other commands, builtin or custom, are typed into the prompt. Custom command keymaps use the command's name (its filename without extension).

Keymaps must be unique across the merged default, global, and local configs — two commands bound to the same key cause a startup validation error.

The default keymaps are chosen as not to conflict with Node `readline`s [builtin](https://nodejs.org/api/readline.html#tty-keybindings) keybindings

Each `Key` object has:

| Field   | Type      | Default  |
| ------- | --------- | -------- |
| `name`  | `string`  | required |
| `ctrl`  | `boolean` | `false`  |
| `meta`  | `boolean` | `false`  |
| `shift` | `boolean` | `false`  |

You can configure individual keymaps while keeping the required `edit` keymap and any other configured defaults.

Example:

```yaml
keymaps:
  edit:
    name: x
    ctrl: true
  history:
    name: o
    ctrl: true
```

### Example settings.yaml

A complete example including every option:

```yaml
model: claude-sonnet-4-6
sdkProvider: openai-compatible
gateway: opencode
baseURL: https://api.example.com/v1
compactTriggerRatio: 0.8
compactTargetRatio: 0.3
keymaps:
  edit:
    name: x
    ctrl: true
  history:
    name: o
    ctrl: true
  # custom command
  commit:
    name: x
    ctrl: true
pricingPerModel:
  claude-sonnet-4-6:
    inputPerMillion: 2.5
    outputPerMillion: 10
    cacheReadPerMillion: 1.25
    cacheWritePerMillion: 3.75
contextWindowPerModel:
  claude-sonnet-4-6: 200000
customSlashCommandDirs:
  - /home/me/my-commands
customSkillDirs:
  - /home/me/my-skills
subagentModels:
  - claude-haiku-4-5
loadingStateFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
loadingStateFrameDuration: 100
promptPrefix: "🤖 "
messageQueueDelimiter: "l---\n"
reasoning: "high"
mcps:
  local-tools:
    type: stdio
    command: /usr/local/bin/mcp-server
    args: [--verbose]
usageLimit:
  duration: "5h"
  dollarAmount: 10
```

## Environment Variables

| Variable                | Description                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `LASSO_API_KEY`         | API key for the configured provider (required)                                                                         |
| `LASSO_EDIT`            | Editor command with `__FILE__` placeholder for multi-line input (fallback: `$EDITOR __FILE__`)                         |
| `LASSO_PAGER_EDIT`      | Pager command with `__FILE__` placeholder for viewing the current editor input (fallback: `$LASSO_PAGER`)              |
| `LASSO_PAGER_HISTORY`   | Pager command with `__FILE__` placeholder for viewing chat history (fallback: `$LASSO_PAGER`)                          |
| `LASSO_PAGER_CONFIG`    | Pager command with `__FILE__` placeholder for viewing config (fallback: `$LASSO_PAGER`)                                |
| `LASSO_PAGER_CONTEXT`   | Pager command with `__FILE__` placeholder for viewing context (fallback: `$LASSO_PAGER`)                               |
| `LASSO_PAGER_COMMANDS`  | Pager command with `__FILE__` placeholder for viewing custom commands (fallback: `$LASSO_PAGER`)                       |
| `LASSO_PAGER_RELOAD`    | Pager command with `__FILE__` placeholder for viewing the reload config diff (fallback: `$LASSO_PAGER`)                |
| `LASSO_PAGER`           | Default pager command with `__FILE__` placeholder (fallback: `$PAGER`, then `bat`, then `less`)                        |
| `LASSO_CLIPBOARD_PASTE` | Command used by `/paste` to read the clipboard (default: `pbpaste` on macOS, `xclip -selection clipboard -o` on Linux) |

## CLI Arguments

| Flag      | Description          |
| --------- | -------------------- |
| `--debug` | Enable debug logging |

## Builtin Slash Commands

Slash commands are triggered with `/command` at the prompt.

| Command         | Description                                                                |
| --------------- | -------------------------------------------------------------------------- |
| `/edit`         | Call the `edit` keymap                                                     |
| `/editpage`     | View the current editor input in a pager                                   |
| `/clear`        | Clear conversation context                                                 |
| `/history`      | View chat history in a pager                                               |
| `/lastresponse` | View the latest assistant response in a pager                              |
| `/paste`        | Call the `paste` keymap                                                    |
| `/model`        | Switch the model at runtime (e.g. `/model kimi-k2.6`)                      |
| `/skills`       | List available skills                                                      |
| `/context`      | List available context files                                               |
| `/contextpage`  | View the raw context string in a pager                                     |
| `/commands`     | List available slash commands (builtin and custom)                         |
| `/commandspage` | View custom slash command contents in a pager                              |
| `/keymaps`      | List configured keybindings                                                |
| `/usage`        | Show current session usage                                                 |
| `/config`       | View global, local, and applied config in a pager                          |
| `/reload`       | Reload config and context, diff the result in a pager                      |
| `/initlocal`    | Create `./.lasso/settings.yaml` if it doesn't exist                        |
| `/initglobal`   | Create `~/.config/lasso/settings.yaml` if it doesn't exist                 |
| `/resume`       | Continue a past session from its start date (e.g. `/resume 1754000000000`) |

### Custom Slash Commands

Create custom commands by adding markdown files (`.md`) to `./.lasso/commands/` (local), `~/.config/lasso/commands/` (global), or any directory specified in `customSlashCommandDirs`. Nested subdirectories are supported via `**/*.md` glob. Commands with the same filename are deduplicated with the first occurrence taking precedence, in this priority order: custom dirs → local → global.

Running `/command` sends the command's markdown content as a message. Extra content can be passed after the command name: `/command <extra content>` sends the command's instructions followed by the extra content as context, letting you parameterize a command without editing its file, e.g. `/refactor extract the config parsing into a module`.

#### Directory Structure

```
./.lasso/commands/              # local commands
  help.md
  refactor.md
~/.config/lasso/commands/      # global commands
  status.md
/home/me/my-commands/              # custom commands (via customSlashCommandDirs)
  custom.md
```

### Message Queue

The editor input (`edit` keymap or `/edit`) supports queuing multiple messages in one go: separate them with a line containing exactly the `messageQueueDelimiter` (default `l---`). On save, the first message is sent immediately; the rest are sent automatically one per assistant turn, without re-prompting. Re-opening the editor while messages are queued prefills them, so you can keep appending.

```text
First prompt
l---
Second prompt
l---
Third prompt
```

The three messages above are sent one per turn, in order. Empty lines between messages are ignored. A delimiter line with nothing but the delimiter (or an empty file) sends nothing.

Set a custom delimiter in `settings.yaml` (must end with a newline, so it occupies its own line):

```yaml
messageQueueDelimiter: "ll\n"
```

## AGENTS.md Context

`AGENTS.md` files provide project context to the agent. The root `AGENTS.md` files are always included in the system prompt, while nested `AGENTS.md` files are progressively disclosed as skills.

### Directory Structure

```
./
  AGENTS.md                        # always in context
  src/
    AGENTS.md                      # loaded as a skill on demand
~/.config/lasso/context/       # global context dir
  AGENTS.md                        # always in context
```

### Discovery

- **Root files** — `./AGENTS.md` and `~/.config/lasso/context/AGENTS.md` are always included in the system prompt
- **Nested files** — all `*/**/AGENTS.md` files under the current working directory are registered as skills. The agent can call `load_skill` to progressively disclose their content when needed

## Skills

### Directory Structure

```
~/.config/lasso/skills/   # global skills
  my-skill/
    SKILL.md
  category/
    nested-skill/
      SKILL.md
./.lasso/skills/            # local skills
  project-skill/
    SKILL.md
/custom/skills/                # custom skills (via customSkillDirs)
  custom-skill/
    SKILL.md
```

### Discovery

Skills are discovered via `**/SKILL.md` glob from three sources in priority order:

1. **Custom skill dirs** — directories specified in `customSkillDirs`
2. **Local skills** — `./.lasso/skills/`
3. **Global skills** — `~/.config/lasso/skills/`

Skills with duplicate names are deduplicated, with the first occurrence taking precedence.

### SKILL.md Format

Each `SKILL.md` must have front matter with `name` and `description`:

```markdown
---
name: my-skill
description: Does something useful
---

# My Skill

Skill body with instructions the agent will use when this skill is loaded.
```

Available skills are listed in the system prompt, the LLM can use the `load_skill` tool to load a skill's full instructions.

## Tools

- `bash` — run bash commands
- `create_file` — create new files
- `view_file` — view files or list directories
- `str_replace` — replace strings in files
- `insert_lines` — insert text at a line
- `web_fetch_html` — fetch a URL and return extracted article content
- `web_fetch_json` — fetch a JSON API endpoint and return parsed data
- `load_skill` — load a skill to get specialized instructions
- `create_subagent` — launch parallel subagents for independent investigation or implementation

## Dependencies

Minimal runtime dependencies (9 total):

| Package                     | Purpose                                 |
| --------------------------- | --------------------------------------- |
| `ai`                        | AI SDK core                             |
| `@ai-sdk/anthropic`         | Anthropic provider                      |
| `@ai-sdk/openai`            | OpenAI provider                         |
| `@ai-sdk/openai-compatible` | OpenAI-compatible provider              |
| `zod`                       | Schema validation                       |
| `happy-dom`                 | DOM parsing for `web_fetch_html`        |
| `@mozilla/readability`      | Content extraction for `web_fetch_html` |
| `prettier`                  | Markdown formatting                     |
| `yaml`                      | Parsing Skill metadata                  |

- This project uses **pnpm v11** for package management, which helps [mitigate the risk of supply chain attacks](https://pnpm.io/supply-chain-security)
- All tests are written with the Node.js native test runner and mocks i.e. no Jest
- TypeScript is executed directly via `node` (no build step), keeping the toolchain minimal

## Running in a container

The `scripts/copy-server.ts` and `scripts/paste-server.ts` helpers bridge the host clipboard to a container using the following flow:

## Paste server

1. `scripts/paste-server.ts` runs on the host, printing its port to stdout
2. The host captures the port and passes it to the container via a `PASTE_PORT` env variable
3. In the container, putting (pasting) from the unnamed register runs `nc --recv-only host.docker.internal vim.env.PASTE_PORT`. This makes a request to the paste server asking for the content to paste
4. The paste server on the host executes `paste_cmd`, captures its output, and responds back to the container with the output
5. The container pastes the response

## Copy server

1. `scripts/copy-server.ts` runs on the host, printing its port to stdout
2. The host captures the port and passes it to the container via a `COPY_PORT` env variable
3. In the container, yanking to the unnamed register runs `nc --send-only host.docker.internal vim.env.COPY_PORT`. This makes a request to the copy server informing it of the content to copy
4. The copy server on the host executes `copy_cmd` with the content in the request

```bash
agent() {
  paste_fifo=$(mktemp -u /tmp/paste-fifo.XXXXXX)
  rm -f "$paste_fifo"
  mkfifo "$paste_fifo"
  node "/path/to/lasso/scripts/paste-server.ts" "$paste_cmd" >"$paste_fifo" &
  paste_server_pid="$!"
  read -r PASTE_PORT <"$paste_fifo"
  rm -f "$paste_fifo"

  copy_fifo=$(mktemp -u /tmp/copy-fifo.XXXXXX)
  rm -f "$copy_fifo"
  mkfifo "$copy_fifo"
  node "/path/to/lasso/scripts/copy-server.ts" "$copy_cmd" >"$copy_fifo" &
  copy_server_pid="$!"
  read -r COPY_PORT <"$copy_fifo"
  rm -f "$copy_fifo"

  trap "kill $paste_server_pid $copy_server_pid 2>/dev/null" EXIT INT TERM

  local podman_args=(
    --env LASSO_EDIT='nvim -c "normal! G$" -c startinsert! __FILE__'
    --env LASSO_PAGER_HISTORY='nvim -c "normal! G$" __FILE__'
    --env LASSO_CLIPBOARD_PASTE="nc --recv-only host.docker.internal $PASTE_PORT"
    --env COPY_PORT="$COPY_PORT"
    --env PASTE_PORT="$PASTE_PORT"
  )

  # ...
}
```

```lua
-- the vim config running in the container
vim.g.clipboard = {
  name = "lasso-clipboard",
  copy = {
    ["+"] = { "nc", "--send-only", "host.docker.internal", vim.env.COPY_PORT, },
    ["*"] = { "nc", "--send-only", "host.docker.internal", vim.env.COPY_PORT, },
  },
  paste = {
    ["+"] = { "nc", "--recv-only", "host.docker.internal", vim.env.PASTE_PORT, },
    ["*"] = { "nc", "--recv-only", "host.docker.internal", vim.env.PASTE_PORT, },
  }
}
```

## TODO (soon)

- [ ] Use native v7 timeouts
- [ ] `asciiOnly` config option

## TODO (later)

- [ ] Support code-mode
- [ ] Support Windows-style newlines
