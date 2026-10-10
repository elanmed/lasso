import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { getTempFileName } from "./temp-file.ts";
import { fsDeps } from "./deps.ts";
import {
  mockStdoutWrites,
  setupTestContext,
  testFs,
  RED,
  RESET,
} from "./test-helpers.ts";

describe("temp-file", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  beforeEach(() => {
    setupTestContext();
  });

  describe("getTempFileName", () => {
    it("returns temp file path without initial content", async () => {
      const result = await getTempFileName();
      assert.equal(result, "/tmp/lasso-test-uuid.txt");
    });

    it("copies initial content when initialContentPath is provided", async () => {
      testFs._files.set("/source/file.txt", "initial content");
      const result = await getTempFileName({
        initialContentPath: "/source/file.txt",
      });
      assert.equal(result, "/tmp/lasso-test-uuid.txt");
      assert.equal(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        "initial content",
      );
    });

    it("creates an empty temp file when the initial content path does not exist", async () => {
      const result = await getTempFileName({
        initialContentPath: "/missing/file.txt",
      });
      assert.equal(result, "/tmp/lasso-test-uuid.txt");
      assert.equal(testFs._files.get("/tmp/lasso-test-uuid.txt"), "");
    });

    it("returns null when reading an existing path fails", async () => {
      testFs._files.set("/source/file.txt", "initial content");
      mock.method(fsDeps, "readFile", () => Promise.reject(new Error("EIO")));
      const result = await getTempFileName({
        initialContentPath: "/source/file.txt",
      });
      assert.equal(result, null);
      assert.equal(testFs._files.has("/tmp/lasso-test-uuid.txt"), false);
    });

    it("returns null when write fails", async () => {
      testFs._files.set("/source.txt", "content");
      mock.method(fsDeps, "writeFile", () => Promise.reject(new Error("EIO")));
      const result = await getTempFileName({
        initialContentPath: "/source.txt",
      });
      assert.equal(result, null);

      const strResult = await getTempFileName({ initialContentStr: "content" });
      assert.equal(strResult, null);

      const noArgsResult = await getTempFileName();
      assert.equal(noArgsResult, null);
    });

    it("writes initialContentStr into the temp file", async () => {
      const result = await getTempFileName({
        initialContentStr: "string content",
      });
      assert.equal(result, "/tmp/lasso-test-uuid.txt");
      assert.equal(
        testFs._files.get("/tmp/lasso-test-uuid.txt"),
        "string content",
      );
    });

    it("uses the extension in the temp file path", async () => {
      const result = await getTempFileName({ extension: "wav" });
      assert.equal(result, "/tmp/lasso-test-uuid.wav");
    });

    it("uses the path prefix in the temp file path", async () => {
      const result = await getTempFileName({
        pathPrefix: "lasso-local",
        initialContentStr: "local content",
      });
      assert.equal(result, "/tmp/lasso-local-test-uuid.txt");
      assert.equal(
        testFs._files.get("/tmp/lasso-local-test-uuid.txt"),
        "local content",
      );
    });

    it("throws when both initialContentPath and initialContentStr are provided", async () => {
      await assert.rejects(
        () =>
          getTempFileName({
            initialContentPath: "/source/file.txt",
            initialContentStr: "string content",
          }),
        /falsy value/,
      );
    });
    it("prints the error when checking the initial content path fails", async () => {
      mock.method(fsDeps, "existsSync", () => {
        throw new Error("EACCES");
      });
      const writes = mockStdoutWrites();
      const result = await getTempFileName({
        initialContentPath: "/source/file.txt",
      });
      assert.equal(result, null);
      assert.deepStrictEqual(writes(), [
        `${RED}Failed to create a temp file with content from path /source/file.txt. Error: EACCES${RESET}\n`,
      ]);
    });

    it("prints the error when reading the initial content fails", async () => {
      testFs._files.set("/source/file.txt", "initial content");
      mock.method(fsDeps, "readFile", () => Promise.reject(new Error("EIO")));
      const writes = mockStdoutWrites();
      const result = await getTempFileName({
        initialContentPath: "/source/file.txt",
      });
      assert.equal(result, null);
      assert.deepStrictEqual(writes(), [
        `${RED}Failed to read the content from path /source/file.txt to prepopulate a temp file. Error: EIO${RESET}\n`,
      ]);
    });

    it("prints the error when writing the initial content path fails", async () => {
      testFs._files.set("/source/file.txt", "initial content");
      mock.method(fsDeps, "writeFile", () =>
        Promise.reject(new Error("ENOSPC")),
      );
      const writes = mockStdoutWrites();
      const result = await getTempFileName({
        initialContentPath: "/source/file.txt",
      });
      assert.equal(result, null);
      assert.deepStrictEqual(writes(), [
        `${RED}Failed to write a temp file with the content from path /source/file.txt: ENOSPC${RESET}\n`,
      ]);
    });

    it("prints the error when the temp file cannot be created", async () => {
      mock.method(fsDeps, "writeFile", () => Promise.reject(new Error("EIO")));
      const writes = mockStdoutWrites();
      const result = await getTempFileName({ initialContentStr: "content" });
      assert.equal(result, null);
      assert.deepStrictEqual(writes(), [
        `${RED}Failed to write to a temp file. Error: EIO${RESET}\n`,
      ]);
    });

    it("prints the error when the empty temp file for a missing path cannot be created", async () => {
      mock.method(fsDeps, "writeFile", () => Promise.reject(new Error("EIO")));
      const writes = mockStdoutWrites();
      const result = await getTempFileName({
        initialContentPath: "/missing/file.txt",
      });
      assert.equal(result, null);
      assert.deepStrictEqual(writes(), [
        `${RED}Failed to write an empty temp file. Error: EIO${RESET}\n`,
      ]);
    });

    it("prints the error when no initial content is given and the temp file cannot be created", async () => {
      mock.method(fsDeps, "writeFile", () => Promise.reject(new Error("EIO")));
      const writes = mockStdoutWrites();
      const result = await getTempFileName();
      assert.equal(result, null);
      assert.deepStrictEqual(writes(), [
        `${RED}Failed to create an empty temp file. Error: EIO${RESET}\n`,
      ]);
    });
  });
});
