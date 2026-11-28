# Add file-backed channels for agent sessions

Status: ready-for-agent

## Goal

Allow two interactive Lasso sessions to coordinate through a named, file-backed channel. The agent explicitly reads from and writes to the channel using tools.

## Behavior

- Add builtin `/channel-create <name>` and `/channel-connect <name>` commands.
- Creating a channel creates its Markdown file and connects the creating session immediately.
- Connecting to a channel switches the session's single active channel. Connecting to a missing channel and creating a duplicate channel report errors without silently creating or overwriting files.
- Validate names to letters, digits, hyphens, and underscores; do not treat names as paths.
- Store channel files in a new `channels` directory under Lasso's global state directory, alongside `webpages`.
- Provide channel read and write tools only while the session is connected. Reads return the full Markdown history. Each write appends text with a timestamp and the writing session ID.
- Serialize reads and writes with the existing per-channel lockfile infrastructure.
- `/reload` preserves the active channel. A new Lasso process must connect explicitly.
- Expire channel files 24 hours after their creation timestamp, following the existing webpage-file cleanup pattern.
- Do not add live updates or a delete command in this version.

## Acceptance criteria

- A session can create a named channel and immediately read and write through the channel tools.
- Another session can connect by name and read the same accumulated history; its writes appear in later reads from either session.
- Concurrent operations use the channel lock and preserve complete messages.
- Duplicate creation and connection to a missing channel produce clear errors without data loss or implicit creation.
- Reconnecting to a different channel switches the active channel; `/reload` does not clear it.
- Expired channels are removed after 24 hours according to their creation timestamp, while newer channels remain.
- Add automated coverage for commands, tool availability and behavior, locking, and cleanup.
