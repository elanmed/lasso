import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";

import {
  getAvailableSlashCommands,
  getCustomSlashCommandsStr,
} from "./slash-commands.ts";
import { actions, getState } from "./state.ts";
import { fsDeps } from "./deps.ts";
import { mockStdoutWrites, setupTestContext, testFs } from "./test-helpers.ts";

describe("getAvailableSlashCommands", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  describe("returns an empty array", () => {
    it("returns empty array when no commands found", async () => {
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, []);
    });

    it("returns empty array when glob throws", async () => {
      mock.method(fsDeps, "glob", () =>
        Promise.reject(new Error("permission denied")),
      );
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, []);
    });

    it("returns empty array when glob returns empty", async () => {
      testFs._globResults.set("/test-cwd/.lasso/commands/**/*.md", []);
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, []);
    });
  });

  describe("returns commands", () => {
    it("includes custom slash command dirs", async () => {
      actions.setCustomSlashCommandDirs(["/custom-commands"]);
      testFs._globResults.set("/custom-commands/**/*.md", [
        "/custom-commands/foo.md",
      ]);
      testFs._files.set("/custom-commands/foo.md", "custom content");
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, [
        {
          name: "foo",
          filePath: "/custom-commands/foo.md",
          content: "custom content",
        },
      ]);
    });

    it("returns commands from local and global dirs", async () => {
      testFs._globResults.set("/test-cwd/.lasso/commands/**/*.md", [
        "/test-cwd/.lasso/commands/help.md",
      ]);
      testFs._globResults.set("/fake-home/.config/lasso/commands/**/*.md", [
        "/fake-home/.config/lasso/commands/status.md",
      ]);
      testFs._files.set("/test-cwd/.lasso/commands/help.md", "help content");
      testFs._files.set(
        "/fake-home/.config/lasso/commands/status.md",
        "status content",
      );
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, [
        {
          name: "help",
          filePath: "/test-cwd/.lasso/commands/help.md",
          content: "help content",
        },
        {
          name: "status",
          filePath: "/fake-home/.config/lasso/commands/status.md",
          content: "status content",
        },
      ]);
    });

    it("deduplicates by name keeping first occurrence", async () => {
      testFs._globResults.set("/test-cwd/.lasso/commands/**/*.md", [
        "/test-cwd/.lasso/commands/help.md",
      ]);
      testFs._globResults.set("/fake-home/.config/lasso/commands/**/*.md", [
        "/fake-home/.config/lasso/commands/help.md",
      ]);
      testFs._files.set("/test-cwd/.lasso/commands/help.md", "local content");
      testFs._files.set(
        "/fake-home/.config/lasso/commands/help.md",
        "global content",
      );
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, [
        {
          name: "help",
          filePath: "/test-cwd/.lasso/commands/help.md",
          content: "local content",
        },
      ]);
    });
  });

  describe("handles errors", () => {
    it("skips files that fail to read", async () => {
      mock.method(fsDeps, "readFile", (path: string) =>
        path.includes("bad")
          ? Promise.reject(new Error("read failed"))
          : Promise.resolve(Buffer.from("content").toString()),
      );
      testFs._globResults.set("/test-cwd/.lasso/commands/**/*.md", [
        "/test-cwd/.lasso/commands/good.md",
        "/test-cwd/.lasso/commands/bad.md",
      ]);
      const result = await getAvailableSlashCommands();
      assert.deepStrictEqual(result, [
        {
          name: "good",
          filePath: "/test-cwd/.lasso/commands/good.md",
          content: "content",
        },
      ]);
    });

    it("warns when glob fails", async () => {
      mock.method(fsDeps, "glob", () =>
        Promise.reject(new Error("permission denied")),
      );
      const getWrites = mockStdoutWrites();

      const result = await getAvailableSlashCommands();

      assert.deepStrictEqual(result, []);
      assert.deepStrictEqual(getWrites(), []);
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "Failed to list the slash command files in `/test-cwd/.lasso/commands`, ignoring. Error: permission denied",
        "Failed to list the slash command files in `/fake-home/.config/lasso/commands`, ignoring. Error: permission denied",
      ]);
    });

    it("warns when a slash command file cannot be read", async () => {
      mock.method(fsDeps, "readFile", (path: string) =>
        path.includes("bad")
          ? Promise.reject(new Error("read failed"))
          : Promise.resolve(Buffer.from("content").toString()),
      );
      testFs._globResults.set("/test-cwd/.lasso/commands/**/*.md", [
        "/test-cwd/.lasso/commands/bad.md",
      ]);
      const getWrites = mockStdoutWrites();

      const result = await getAvailableSlashCommands();

      assert.deepStrictEqual(result, []);
      assert.deepStrictEqual(getWrites(), []);
      assert.deepStrictEqual(getState().content.configWarningMessages, [
        "Failed to read the slash command file at `/test-cwd/.lasso/commands/bad.md`, ignoring. Error: read failed",
      ]);
    });
  });
});

describe("getCustomSlashCommandsStr", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  it("normalizes CRLF and strips trailing newlines from content", () => {
    actions.setSlashCommands([
      {
        name: "deploy",
        filePath: "/test-cwd/.lasso/commands/deploy.md",
        content: "line one\r\nline two\r\n\r\n",
      },
    ]);
    assert.strictEqual(
      getCustomSlashCommandsStr(),
      `# [lasso] Slash commands:

## /test-cwd/.lasso/commands/deploy.md

line one\r\nline two`,
    );
  });
});
