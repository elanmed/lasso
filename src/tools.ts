import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import { Window } from "happy-dom";
import { Readability } from "@mozilla/readability";
import { assertAtBuildtime } from "./assert.ts";
import {
  getMessageFromError,
  isAbortError,
  stringify,
  tryCatchAsync,
  execPromise,
  getMaxColLength,
  normalizeNewline,
} from "./utils.ts";
import { getUnicodeChar } from "./text.ts";
import { createToolCallDiffer } from "./differ.ts";
import { print, bold } from "./print.ts";
import { getState } from "./state.ts";
import { getLanguageModel } from "./model.ts";
import { aiDeps } from "./deps.ts";
import { appendModelUsage } from "./usage.ts";
import { getSubagentPrompt } from "./prompts.ts";

const userAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function toolPrint(label: string, detail: string) {
  const detailArr = detail.split("\n").filter((str) => str.length > 0);
  const colonSpaceLen = 2;
  const labelLen = label.length + colonSpaceLen;
  const indent = " ".repeat(7).concat(getUnicodeChar("┊"));
  const lines = [];
  const maxLines = 5;

  let detailIdx = 0;
  let strIdx = 0;
  while (lines.length < maxLines && detailIdx < detailArr.length) {
    const detailLine = detailArr[detailIdx];
    assertAtBuildtime(detailLine !== undefined);

    let maxLen = (() => {
      if (lines.length === 0) return getMaxColLength() - labelLen;
      return getMaxColLength() - indent.length;
    })();
    maxLen = Math.max(1, maxLen);

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

  const overflow = lines.length === maxLines && detailIdx < detailArr.length;

  if (overflow) {
    const lastLine = lines.pop();
    assertAtBuildtime(lastLine !== undefined);

    const ellipsis = getUnicodeChar("…");
    const newLastLine = (() => {
      if (lastLine.length >= getMaxColLength()) {
        return lastLine.slice(0, -1).concat(ellipsis);
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

export type BashToolInput =
  | {
      fileSystemAccessType: "read";
      command: string;
    }
  | {
      fileSystemAccessType: "create-update-delete";
      filePath: string;
      command: string;
    };

export const bashToolInputSchema = z
  .object({
    fileSystemAccessType: z
      .enum(["read", "create-update-delete"])
      .describe(
        "Use read for commands that only read project files. Use create-update-delete when the command creates, updates, or deletes a project file.",
      ),
    filePath: z
      .string()
      .optional()
      .describe(
        "Target file path; required when fileSystemAccessType is create-update-delete. Temporary files used only as intermediates do not count.",
      ),
    command: z.string().describe("The bash command to run"),
  })
  .describe(
    "Run a bash command. Commands writing only to temporary files count as read; otherwise specify the target file path and use create-update-delete.",
  )
  .refine(
    (input): input is BashToolInput => {
      if (input.fileSystemAccessType === "create-update-delete") {
        return input.filePath !== undefined;
      } else {
        return true;
      }
    },
    {
      message:
        "filePath is required when fileSystemAccessType is create-update-delete",
    },
  );

export async function executeBashTool(
  { command: bashCommand }: BashToolInput,
  signal?: AbortSignal,
): Promise<ToolResult> {
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

export const webFetchToolSchema = z.object({
  href: z.string().describe("The URL of the web page or JSON API to fetch"),
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

export const loadSkillToolSchema = z.object({
  name: z.string().describe("The name of the skill to load"),
});
export type LoadSkillTool = z.infer<typeof loadSkillToolSchema>;

export function loadSkillTool({ name }: LoadSkillTool): ToolResult {
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
  prompt: z
    .string()
    .describe("The prompt describing the task for the subagent"),
  access: z
    .enum(["read-only", "read-write"])
    .describe(
      "Whether the subagent may make changes (read-write) or only investigate (read-only)",
    ),
  model: z
    .string()
    .min(1)
    .describe("The model the subagent runs on")
    .superRefine((value, ctx) => {
      const configuredModels = getState().config.subagentModels;
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
  timeout: z
    .number()
    .optional()
    .describe("Maximum milliseconds the subagent may run before timing out"),
});
export const createSubagentToolSchema = z.object({
  tasks: z
    .array(createSubagentTaskSchema)
    .describe("The independent subagent tasks to run in parallel"),
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
        getSubagentPrompt(subagentSchema.access),
        normalizeNewline(getState().app.contextStr),
        normalizeNewline(getState().app.skillsStr),
        accessSystemContent,
      ]
        .filter((content) => content.length > 0)
        .join("\n\n");

      const toolCallDiffer = createToolCallDiffer();

      const userMessage: ModelMessage = {
        role: "user",
        content: subagentSchema.prompt,
      };

      const generateTextResult = await tryCatchAsync(
        aiDeps.generateText({
          model: getLanguageModel(model),
          // Subagents should always use the provider's default reasoning
          instructions: systemContent,
          messages: [userMessage],
          tools: { ...subagentSafeTools, ...getState().mcp.tools },
          stopWhen: aiDeps.isLoopFinished(),
          abortSignal: controller.signal,
          onToolExecutionStart: ({ toolCall }) => {
            if (subagentSchema.access !== "read-write") return;
            if (toolCall.toolName !== "bash") return;

            const bashSchemaResult = bashToolInputSchema.parse(toolCall.input);
            if (
              bashSchemaResult.fileSystemAccessType === "create-update-delete"
            ) {
              toolCallDiffer.setTempFileBefore(
                toolCall.toolCallId,
                bashSchemaResult.filePath,
              );
            }
          },
          onToolExecutionEnd: async ({ toolCall, toolOutput }) => {
            if (subagentSchema.access !== "read-write") return;
            if (toolCall.toolName !== "bash") return;
            const success = toolOutput.type === "tool-result";

            const bashSchemaResult = bashToolInputSchema.parse(toolCall.input);

            if (
              bashSchemaResult.fileSystemAccessType === "create-update-delete"
            ) {
              if (!success) {
                toolCallDiffer.cleanupTempFileBefore(toolCall.toolCallId);
                return;
              }
              await toolCallDiffer.diffAndCleanup(
                toolCall.toolCallId,
                bashSchemaResult.filePath,
              );
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

const subagentSafeTools = {
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
  load_skill: tool({
    description: "Load a skill to get specialized instructions",
    inputSchema: loadSkillToolSchema,
    execute: (args) => loadSkillTool(args),
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
  ...subagentSafeTools,
  ...baseAgentTools,
};

export function getTools() {
  return { ...harnessTools, ...getState().mcp.tools };
}
