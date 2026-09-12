import assert from "node:assert";
import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import {
  getMessageFromError,
  isAbortError,
  normalizeLine,
  stringify,
  tryCatch,
  tryCatchAsync,
  execPromise,
  getMaxColLength,
} from "./utils.ts";
import { getUnicodeChar } from "./text.ts";
import { createToolCallDiffer, execGitDiff } from "./differ.ts";
import { print, bold, fencePrint, printNewline } from "./print.ts";
import { getState } from "./state.ts";
import { BASE_SYSTEM_PROMPT } from "./prompts.ts";
import { getLanguageModel } from "./model.ts";
import { Window } from "happy-dom";
import { Readability } from "@mozilla/readability";
import { aiDeps, fsDeps } from "./deps.ts";
import { appendModelUsage } from "./usage.ts";

const userAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function toolPrint(label: string, detail: string) {
  const detailArr = detail.split("\n").filter((str) => str.length > 0);
  const colonSpaceLen = 2;
  const labelLen = label.length + colonSpaceLen;
  const indent = " ".repeat(7).concat(getUnicodeChar("┊"));
  const lines = [];

  let detailIdx = 0;
  let strIdx = 0;
  while (lines.length <= 3 && detailIdx < detailArr.length) {
    const detailLine = detailArr[detailIdx];
    assert(detailLine !== undefined);

    const maxLen = (() => {
      if (lines.length === 0) return getMaxColLength() - labelLen;
      return getMaxColLength() - indent.length;
    })();

    const splitStr = detailLine.slice(strIdx, strIdx + maxLen);
    strIdx += splitStr.length;
    if (strIdx >= detailLine.length) {
      detailIdx++;
      strIdx = 0;
    }

    const prefix = (() => {
      if (lines.length === 0) return `${bold(label)}: `;
      return indent;
    })();

    lines.push(prefix.concat(splitStr));
  }

  const overflow = lines.length === 4 && detailIdx < detailArr.length;

  if (overflow) {
    const lastLine = lines.pop();
    assert(lastLine !== undefined);

    const ellipsis = getUnicodeChar("…");
    const ellipsisLen = ellipsis.length;

    const newLastLine = (() => {
      if (lastLine.length === getMaxColLength()) {
        return lastLine.slice(0, -ellipsisLen).concat(ellipsis);
      } else {
        return lastLine.concat(ellipsis);
      }
    })();
    lines.push(newLastLine);
  }

  const linesStr = lines.join("\n");

  print.doing(linesStr);
}

export type ToolPrint = typeof toolPrint;

export interface ToolResult {
  content: string;
  isError?: boolean;
}

const bashToolInputSchema = z.object({ command: z.string() });
export type BashToolInput = z.infer<typeof bashToolInputSchema>;

export async function executeBashTool(
  { command: bashCommand }: BashToolInput,
  signal?: AbortSignal,
): Promise<ToolResult> {
  toolPrint("bash", bashCommand);

  const bashResult = await tryCatchAsync(
    execPromise(bashCommand, signal === undefined ? undefined : { signal }),
  );

  if (!bashResult.ok) {
    if (isAbortError(bashResult.error)) {
      throw bashResult.error;
    }

    const error = getMessageFromError(bashResult.error);
    return {
      content: error,
      isError: true,
    };
  }
  return {
    content: JSON.stringify({
      stdout: bashResult.value.stdout,
      stderr: bashResult.value.stderr,
    }),
  };
}

const createFileToolSchema = z.object({
  path: z.string(),
  content: z.string(),
});
export type CreateFileTool = z.infer<typeof createFileToolSchema>;

export function executeCreateFileTool(
  { content, path }: CreateFileTool,
  signal?: AbortSignal,
): ToolResult {
  toolPrint("create_file", path);

  if (fsDeps.existsSync(path)) {
    return {
      content: `${path} already exists`,
      isError: true,
    };
  }

  const createFileResult = tryCatch(() =>
    fsDeps.writeFileSync(path, content, { signal }),
  );

  if (!createFileResult.ok) {
    if (isAbortError(createFileResult.error)) {
      throw createFileResult.error;
    }

    const error = getMessageFromError(createFileResult.error);
    return {
      content: error,
      isError: true,
    };
  }
  return {
    content: `${path} created successfully`,
  };
}
const viewFileToolInputSchema = z.object({
  path: z.string(),
  start_line: z.number().int().optional(),
  end_line: z.number().int().optional(),
});
export type ViewFileToolInput = z.infer<typeof viewFileToolInputSchema>;

export function executeViewFileTool({
  path,
  start_line,
  end_line,
}: ViewFileToolInput): ToolResult {
  toolPrint("view_file", path);

  const statResult = tryCatch(() => fsDeps.statSync(path));
  if (!statResult.ok) {
    const error = getMessageFromError(statResult.error);
    return {
      content: error,
      isError: true,
    };
  }

  if (statResult.value.isDirectory()) {
    const readdirResult = tryCatch(() => fsDeps.readdirSync(path));
    if (!readdirResult.ok) {
      const error = getMessageFromError(readdirResult.error);
      return {
        content: error,
        isError: true,
      };
    }
    const listing = readdirResult.value.join("\n");
    return {
      content: listing,
    };
  }

  const readResult = tryCatch(() => fsDeps.readFileSync(path));
  if (!readResult.ok) {
    const error = getMessageFromError(readResult.error);
    return {
      content: error,
      isError: true,
    };
  }

  const lines = readResult.value.toString().split("\n");

  if (start_line !== undefined && start_line < 1) {
    return {
      content: `start_line must be at least 1, got ${String(start_line)}`,
      isError: true,
    };
  }

  if (end_line !== undefined && end_line !== -1 && end_line < 1) {
    return {
      content: `end_line must be at least 1 or -1, got ${String(end_line)}`,
      isError: true,
    };
  }

  const start = (start_line ?? 1) - 1;
  const end =
    end_line === undefined || end_line === -1 ? lines.length : end_line;

  if (start >= lines.length) {
    return {
      content: `start_line ${String(start_line)} is past end of file (file has ${String(lines.length)} lines)`,
      isError: true,
    };
  }

  if (end > lines.length) {
    return {
      content: `end_line ${String(end_line)} is past end of file (file has ${String(lines.length)} lines)`,
      isError: true,
    };
  }

  if (start >= end) {
    return {
      content: `start_line (${String(start_line)}) must be less than end_line (${String(end_line)})`,
      isError: true,
    };
  }

  const slice = lines.slice(start, end);
  const numbered = slice
    .map((line, i) => `${String(start + i + 1)}\t${line}`)
    .join("\n");

  return {
    content: numbered,
  };
}

export const objectWithPathSchema = z.object({
  path: z.string(),
});

export const strReplaceToolInputSchema = z.object({
  path: z.string(),
  old_str: z.string(),
  new_str: z.string(),
});
export type StrReplaceToolInput = z.infer<typeof strReplaceToolInputSchema>;

export function executeStrReplaceTool(
  { path, old_str, new_str }: StrReplaceToolInput,
  signal?: AbortSignal,
): ToolResult {
  toolPrint("str_replace", path);

  const readResult = tryCatch(() => fsDeps.readFileSync(path));
  if (!readResult.ok) {
    const error = getMessageFromError(readResult.error);
    return {
      content: error,
      isError: true,
    };
  }

  const content = readResult.value.toString();
  const occurrences = content.split(old_str).length - 1;

  if (occurrences === 0) {
    return {
      content: "old_str not found in file",
      isError: true,
    };
  }

  if (occurrences > 1) {
    return {
      content: `old_str matched ${String(occurrences)} times — must match exactly once`,
      isError: true,
    };
  }

  const writeResult = tryCatch(() =>
    fsDeps.writeFileSync(path, content.replace(old_str, new_str), {
      signal,
    }),
  );
  if (!writeResult.ok) {
    if (isAbortError(writeResult.error)) {
      throw writeResult.error;
    }

    const error = getMessageFromError(writeResult.error);
    return {
      content: error,
      isError: true,
    };
  }

  return {
    content: `${path} updated successfully`,
  };
}
const insertLinesToolInputSchema = z.object({
  path: z.string(),
  after_line: z.number().int(),
  content: z.string(),
});
export type InsertLinesToolInput = z.infer<typeof insertLinesToolInputSchema>;

export function executeInsertLinesTool(
  { path, after_line, content }: InsertLinesToolInput,
  signal?: AbortSignal,
): ToolResult {
  toolPrint("insert_lines", path);

  const readResult = tryCatch(() => fsDeps.readFileSync(path));
  if (!readResult.ok) {
    const error = getMessageFromError(readResult.error);
    return {
      content: error,
      isError: true,
    };
  }

  const lines = readResult.value.toString().split("\n");

  if (after_line < 0 || after_line > lines.length) {
    return {
      content: `after_line ${String(after_line)} is out of range (file has ${String(lines.length)} lines)`,
      isError: true,
    };
  }

  lines.splice(after_line, 0, content);

  const writeResult = tryCatch(() => {
    fsDeps.writeFileSync(path, lines.join("\n"), {
      signal,
    });
  });
  if (!writeResult.ok) {
    if (isAbortError(writeResult.error)) {
      throw writeResult.error;
    }

    const error = getMessageFromError(writeResult.error);
    return {
      content: error,
      isError: true,
    };
  }

  return {
    content: `${path} updated successfully`,
  };
}
const webFetchToolSchema = z.object({
  href: z.string(),
});
export type WebFetchTool = z.infer<typeof webFetchToolSchema>;

const FETCH_TIMEOUT_MS = 10 * 1_000;
const SUBAGENT_TIMEOUT_MS = 2 * 60 * 1_000;

function createTimeoutController(
  signal: AbortSignal | undefined,
  timeout: number,
) {
  const controller = new AbortController();

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);

  const onExternalAbort = () => {
    controller.abort();
  };

  if (signal !== undefined) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  return {
    controller,
    isTimedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

const getFetchTimeoutContent = (href: string) =>
  `Request to ${href} timed out after ${String(FETCH_TIMEOUT_MS / 1_000)}s`;

function resolveTimeoutError({
  error,
  content,
  isTimedOut,
}: {
  error: unknown;
  content: string;
  isTimedOut: () => boolean;
}): ToolResult {
  if (isTimedOut()) {
    return {
      isError: true,
      content,
    };
  }
  if (isAbortError(error)) throw error;
  return {
    isError: true,
    content: getMessageFromError(error),
  };
}

export async function executeWebFetchHtmlTool(
  { href }: WebFetchTool,
  signal?: AbortSignal,
): Promise<ToolResult> {
  toolPrint("web_fetch_html", href);
  const headers = new Headers();
  headers.append("User-Agent", userAgent);
  headers.append("Accept", "text/html");

  const { controller, isTimedOut, cleanup } = createTimeoutController(
    signal,
    FETCH_TIMEOUT_MS,
  );

  const fetchResult = await tryCatchAsync(
    fetch(href, {
      headers,
      signal: controller.signal,
    }),
  );

  if (!fetchResult.ok) {
    cleanup();
    return resolveTimeoutError({
      error: fetchResult.error,
      content: getFetchTimeoutContent(href),
      isTimedOut,
    });
  }

  const response = fetchResult.value;
  if (!response.ok) {
    cleanup();
    const error = `HTTP ${String(response.status)}: ${response.statusText}`;
    print.warning(error);
    return {
      isError: true,
      content: error,
    };
  }

  const textResult = await tryCatchAsync(response.text());
  if (!textResult.ok) {
    cleanup();
    return resolveTimeoutError({
      error: textResult.error,
      content: getFetchTimeoutContent(href),
      isTimedOut,
    });
  }
  const htmlStr = textResult.value;

  const window = new Window();
  const doc = new window.DOMParser().parseFromString(htmlStr, "text/html");
  const reader = new Readability(doc);
  const article = reader.parse();
  if (article === null) {
    const error = `Failed to parse article from ${href}`;
    print.warning(error);
    cleanup();
    return {
      isError: true,
      content: error,
    };
  }

  cleanup();
  return {
    content: stringify(article),
  };
}

export async function executeWebFetchJsonTool(
  { href }: WebFetchTool,
  signal?: AbortSignal,
): Promise<ToolResult> {
  toolPrint("web_fetch_json", href);
  const headers = new Headers();
  headers.append("User-Agent", userAgent);
  headers.append("Accept", "application/json");

  const { controller, isTimedOut, cleanup } = createTimeoutController(
    signal,
    FETCH_TIMEOUT_MS,
  );

  const fetchResult = await tryCatchAsync(
    fetch(href, {
      headers,
      signal: controller.signal,
    }),
  );

  if (!fetchResult.ok) {
    cleanup();
    return resolveTimeoutError({
      error: fetchResult.error,
      content: getFetchTimeoutContent(href),
      isTimedOut,
    });
  }

  const response = fetchResult.value;
  if (!response.ok) {
    cleanup();
    const error = `HTTP ${String(response.status)}: ${response.statusText}`;
    print.warning(error);
    return {
      isError: true,
      content: error,
    };
  }

  const jsonResult = await tryCatchAsync(response.json());
  if (!jsonResult.ok) {
    cleanup();
    return resolveTimeoutError({
      error: jsonResult.error,
      content: getFetchTimeoutContent(href),
      isTimedOut,
    });
  }

  cleanup();
  const json = jsonResult.value;
  return {
    content: stringify(json),
  };
}

const loadSkillToolSchema = z.object({
  name: z.string(),
});
export type LoadSkillTool = z.infer<typeof loadSkillToolSchema>;

export function loadSkillTool({ name }: LoadSkillTool): ToolResult {
  toolPrint("load_skill", name);
  const foundSkill = getState().app.skills.find((skill) => skill.name === name);
  if (foundSkill === undefined) {
    return {
      isError: true,
      content: `Could not find a skill with name: ${name}`,
    };
  }

  return {
    content: stringify(foundSkill),
  };
}

export const createSubagentTaskSchema = z.object({
  prompt: z.string(),
  access: z.enum(["read-only", "read-write"]),
  model: z
    .string()
    .min(1)
    .superRefine((value, ctx) => {
      const configuredModels = getState().app.subagentModels;
      const allowedModels = (() => {
        if (configuredModels.length > 0) return configuredModels;
        return [getState().config.model];
      })();

      if (!allowedModels.includes(value)) {
        ctx.addIssue({
          code: "custom",
          message: `Invalid model: ${value}`,
        });
      }
    }),
  timeout: z.number().optional(),
});
export const createSubagentToolSchema = z.object({
  tasks: z.array(createSubagentTaskSchema),
});
export type CreateSubagentTool = z.infer<typeof createSubagentToolSchema>;
export type CreateSubagentTask = z.infer<typeof createSubagentTaskSchema>;

type SubagentResult = {
  model?: string;
  prompt: string;
} & ToolResult;

export async function createSubagentTool(
  { tasks }: CreateSubagentTool,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const subagentPromises = tasks.map(
    async (subagentSchema): Promise<SubagentResult> => {
      const timeout = subagentSchema.timeout ?? SUBAGENT_TIMEOUT_MS;

      const { controller, isTimedOut, cleanup } = createTimeoutController(
        signal,
        timeout,
      );

      const model = subagentSchema.model;
      const accessSystemContent = (() => {
        if (subagentSchema.access === "read-only") {
          return "You are a read-only subagent. Investigate the requested task and report findings.";
        }
        return "You are a read-write subagent. Make the requested changes and report findings.";
      })();

      const systemContent = [
        BASE_SYSTEM_PROMPT,
        getState().app.contextStr,
        getState().app.skillsStr,
        accessSystemContent,
      ]
        .filter((content) => content.length > 0)
        .join("\n");

      const subagentTools = (() => {
        if (subagentSchema.access === "read-only") return readTools;
        return { ...readTools, ...writeTools, ...getState().mcp.tools };
      })();

      const toolCallDiffer = createToolCallDiffer(printGitDiff);

      const message = `[${model}] ${subagentSchema.prompt}`;
      const subagentIndent = "   ";
      toolPrint(`${subagentIndent}create_subagent`, message);

      const inputMessageParam: ModelMessage = {
        role: "user",
        content: subagentSchema.prompt,
      };

      const generateTextResult = await tryCatchAsync(
        aiDeps.generateText({
          model: getLanguageModel(model),
          // Subagents should always use the provider's default reasoning
          instructions: systemContent,
          messages: [inputMessageParam],
          tools: subagentTools,
          stopWhen: aiDeps.isLoopFinished(),
          abortSignal: controller.signal,
          onToolExecutionStart: ({
            toolCall,
          }: {
            toolCall: { toolName: string; toolCallId: string; input: unknown };
          }) => {
            if (subagentSchema.access !== "read-write") return;

            switch (toolCall.toolName as HarnessToolName) {
              case "create_file": {
                toolCallDiffer.setTempFileBefore(toolCall.toolCallId);
                break;
              }
              case "insert_lines":
              case "str_replace": {
                const { path } = objectWithPathSchema.parse(toolCall.input);
                toolCallDiffer.setTempFileBefore(toolCall.toolCallId, {
                  initialContentPath: path,
                });
                break;
              }
            }
          },
          onToolExecutionEnd: async ({
            toolCall,
            toolOutput,
          }: {
            toolCall: { toolName: string; toolCallId: string; input: unknown };
            toolOutput: { type: "tool-result" | "tool-error" };
          }) => {
            if (subagentSchema.access !== "read-write") return;
            const success = toolOutput.type === "tool-result";

            switch (toolCall.toolName as HarnessToolName) {
              case "create_file":
              case "insert_lines":
              case "str_replace": {
                if (!success) {
                  toolCallDiffer.cleanupTempFileBefore(toolCall.toolCallId);
                  return;
                }
                const { path } = objectWithPathSchema.parse(toolCall.input);
                await toolCallDiffer.diffAndCleanup(toolCall.toolCallId, path);
                break;
              }
            }
          },
        }),
      );

      if (!generateTextResult.ok) {
        toolCallDiffer.cleanupAllTempFileBefore();
        cleanup();
        const timeoutResult = resolveTimeoutError({
          error: generateTextResult.error,
          content: `Subagent timed out after ${String(timeout / 1_000)}s`,
          isTimedOut,
        });

        return {
          ...timeoutResult,
          model,
          prompt: subagentSchema.prompt,
        };
      }

      const { usage, text } = generateTextResult.value;
      await appendModelUsage(usage, model);
      toolCallDiffer.cleanupAllTempFileBefore();
      cleanup();

      return {
        model,
        prompt: subagentSchema.prompt,
        content: text,
      };
    },
  );

  const results = await Promise.allSettled(subagentPromises);

  const abortResult = results.find(
    (result) => result.status === "rejected" && isAbortError(result.reason),
  );
  if (abortResult !== undefined) {
    throw (abortResult as PromiseRejectedResult).reason;
  }

  return {
    isError: results.some(
      (result) => result.status === "rejected" || result.value.isError === true,
    ),
    content: stringify(
      results.map((result, idx) => {
        if (result.status === "rejected") {
          const task = tasks[idx];
          if (task === undefined) throw new Error("Missing subagent task");
          const model = task.model;

          return {
            model,
            prompt: task.prompt,
            isError: true,
            content: getMessageFromError(result.reason),
          } satisfies SubagentResult;
        }
        return result.value;
      }),
    ),
  };
}

const readTools = {
  web_fetch_html: tool({
    description:
      "Fetch a web page by URL and return its readable content, parsed to extract the main article.",
    inputSchema: webFetchToolSchema,
    execute: (args, opts) => executeWebFetchHtmlTool(args, opts.abortSignal),
  }),
  web_fetch_json: tool({
    description:
      "Fetch a JSON API endpoint by URL and return the parsed JSON response.",
    inputSchema: webFetchToolSchema,
    execute: (args, opts) => executeWebFetchJsonTool(args, opts.abortSignal),
  }),
  view_file: tool({
    description:
      "View the contents of a file or list a directory. File contents are returned with line numbers. Optional start_line and end_line are 1-based and inclusive; end_line -1 (or omitted) reads to end of file.",
    inputSchema: viewFileToolInputSchema,
    execute: (args) => executeViewFileTool(args),
  }),
  load_skill: tool({
    description: "Load a skill to get specialized instructions",
    inputSchema: loadSkillToolSchema,
    execute: (args) => loadSkillTool(args),
  }),
};

const writeTools = {
  create_file: tool({
    description:
      "Create a new file with the given content. Fails if the file already exists.",
    inputSchema: createFileToolSchema,
    execute: (args, opts) => executeCreateFileTool(args, opts.abortSignal),
  }),
  str_replace: tool({
    description:
      "Replace an exact string in a file. The old_str must match exactly once. Include enough surrounding lines to make the match unique.",
    inputSchema: strReplaceToolInputSchema,
    execute: (args, opts) => executeStrReplaceTool(args, opts.abortSignal),
  }),
  insert_lines: tool({
    description:
      "Insert text after a specific line number in a file. Use line 0 to insert at the beginning of the file.",
    inputSchema: insertLinesToolInputSchema,
    execute: (args, opts) => executeInsertLinesTool(args, opts.abortSignal),
  }),
  bash: tool({
    description: "Execute a bash command and return its output.",
    inputSchema: bashToolInputSchema,
    execute: (args, opts) => executeBashTool(args, opts.abortSignal),
  }),
};

const baseAgentTools = {
  create_subagent: tool({
    description:
      "Launch parallel subagents for independent investigation or implementation. Prefer read-only subagents for parallel work to avoid conflicts. Read-only subagents can fetch web content, inspect files, and load skills; read-write subagents can modify files or execute commands.",
    inputSchema: createSubagentToolSchema,
    execute: (args, opts) => createSubagentTool(args, opts.abortSignal),
  }),
};

export const harnessTools = {
  ...readTools,
  ...writeTools,
  ...baseAgentTools,
};

export type HarnessToolName = keyof typeof harnessTools;

export async function printGitDiff({
  path,
  tempFileAfterPath,
  tempFileBeforePath,
}: {
  tempFileBeforePath: string;
  tempFileAfterPath: string;
  path: string;
}) {
  const diffResult = await tryCatchAsync(
    execGitDiff({
      tempFileBeforePath,
      tempFileAfterPath,
    }),
  );

  if (!diffResult.ok) {
    print.error(
      `An error occurred when getting the diff for ${path}: ${getMessageFromError(diffResult.error)}`,
    );
    return;
  }

  if (diffResult.value.stdout.length > 0) {
    printNewline();
    fencePrint(`File change: ${path}`);
    print(normalizeLine(diffResult.value.stdout));
    printNewline();
  }
}
