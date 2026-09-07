import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";

import { getAvailableSlashCommands } from "./slash-commands.ts";
import { actions } from "./state.ts";
import { fsDeps } from "./deps.ts";
import { setupTestContext, testFs } from "./test-helpers.ts";

describe("getAvailableSlashCommands", () => {
  beforeEach(() => {
    setupTestContext();
  });

  it("returns empty array when no commands found", () => {
    const result = getAvailableSlashCommands();
    assert.deepStrictEqual(result, []);
  });

  it("returns empty array when glob throws", () => {
    mock.method(fsDeps, "globbySync", () => {
      throw new Error("permission denied");
    });
    const result = getAvailableSlashCommands();
    assert.deepStrictEqual(result, []);
  });

  it("returns empty array when glob returns empty", () => {
    testFs._globResults.set("/test-cwd/.lasso/commands/**/*.md", []);
    const result = getAvailableSlashCommands();
    assert.deepStrictEqual(result, []);
  });

  it("includes custom slash command dirs", () => {
    actions.setCustomSlashCommandDirs(["/custom-commands"]);
    testFs._globResults.set("/custom-commands/**/*.md", [
      "/custom-commands/foo.md",
    ]);
    testFs._files.set("/custom-commands/foo.md", "custom content");
    const result = getAvailableSlashCommands();
    assert.deepStrictEqual(result, [
      {
        name: "foo",
        filePath: "/custom-commands/foo.md",
        content: "custom content",
      },
    ]);
  });

  it("returns commands from local and global dirs", () => {
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
    const result = getAvailableSlashCommands();
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

  it("deduplicates by name keeping first occurrence", () => {
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
    const result = getAvailableSlashCommands();
    assert.deepStrictEqual(result, [
      {
        name: "help",
        filePath: "/test-cwd/.lasso/commands/help.md",
        content: "local content",
      },
    ]);
  });

  it("skips files that fail to read", () => {
    mock.method(fsDeps, "readFileSync", (path: string) => {
      if (path.includes("bad")) throw new Error("read failed");
      return Buffer.from("content");
    });
    testFs._globResults.set("/test-cwd/.lasso/commands/**/*.md", [
      "/test-cwd/.lasso/commands/good.md",
      "/test-cwd/.lasso/commands/bad.md",
    ]);
    const result = getAvailableSlashCommands();
    assert.deepStrictEqual(result, [
      {
        name: "good",
        filePath: "/test-cwd/.lasso/commands/good.md",
        content: "content",
      },
    ]);
  });
});
