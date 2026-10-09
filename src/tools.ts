import { extname } from "node:path";
import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import { Window } from "happy-dom";
import { Readability } from "@mozilla/readability";
import { assertAtBuildtime } from "./assert.ts";
import {
  getMessageFromError,
  isAbortError,
  safeStringify,
  stringify,
  tryCatchAsync,
  getMaxColLength,
} from "./utils.ts";
import { getUnicodeChar } from "./text.ts";
import { createToolCallDiffer } from "./differ.ts";
import { print, bold } from "./print.ts";
import { getState } from "./state.ts";
import { getLanguageModel } from "./model.ts";
import { aiDeps, childProcessDeps, fsDeps } from "./deps.ts";
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
        "Target file path of the project file being written; must point to a file, not a directory. Required when fileSystemAccessType is create-update-delete. Temporary scratch files used only as intermediates should not be listed.",
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
  const bashPromise = childProcessDeps.exec(
    bashCommand,
    signal === undefined ? undefined : { signal },
  );
  bashPromise.child.stdin?.end();
  const bashResult = await tryCatchAsync(bashPromise);
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

export const baseTimeoutSettings = {
  totalMs: 10 * 60_000,
  toolMs: 30_000,
  tools: {
    bashMs: 2 * 60_000,
    create_subagentMs: 5 * 60_000,
  },
};

export const subagentTimeoutSettings = {
  totalMs: 4 * 60_000,
  toolMs: 30_000,
  tools: {
    bashMs: 2 * 60_000,
  },
};

export async function executeWebFetchHtmlTool(
  { href }: WebFetchTool,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const headers = new Headers();
  headers.append("User-Agent", userAgent);
  headers.append("Accept", "text/html");

  const fetchResult = await tryCatchAsync(
    fetch(href, {
      headers,
      ...(signal === undefined ? {} : { signal }),
    }),
  );

  if (!fetchResult.ok) {
    if (isAbortError(fetchResult.error)) throw fetchResult.error;
    return {
      content: getMessageFromError(fetchResult.error),
      isError: true,
    };
  }

  const response = fetchResult.value;
  if (!response.ok) {
    const error = `HTTP ${String(response.status)}: ${response.statusText}`;
    print.doing(error);
    return {
      isError: true,
      content: error,
    };
  }

  const textResult = await tryCatchAsync(response.text());
  if (!textResult.ok) {
    if (isAbortError(textResult.error)) throw textResult.error;
    return {
      content: getMessageFromError(textResult.error),
      isError: true,
    };
  }
  const htmlStr = textResult.value;

  const window = new Window();
  const doc = new window.DOMParser().parseFromString(htmlStr, "text/html");
  const reader = new Readability(doc);
  const article = reader.parse();
  if (article === null) {
    const error = `Failed to parse article from ${href}`;
    print.doing(error);
    return {
      isError: true,
      content: error,
    };
  }

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

  const fetchResult = await tryCatchAsync(
    fetch(href, {
      headers,
      ...(signal === undefined ? {} : { signal }),
    }),
  );

  if (!fetchResult.ok) {
    if (isAbortError(fetchResult.error)) throw fetchResult.error;
    return {
      content: getMessageFromError(fetchResult.error),
      isError: true,
    };
  }

  const response = fetchResult.value;
  if (!response.ok) {
    const error = `HTTP ${String(response.status)}: ${response.statusText}`;
    print.doing(error);
    return {
      isError: true,
      content: error,
    };
  }

  const jsonResult = await tryCatchAsync(response.json());
  if (!jsonResult.ok) {
    if (isAbortError(jsonResult.error)) throw jsonResult.error;
    return {
      content: getMessageFromError(jsonResult.error),
      isError: true,
    };
  }
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
  const foundSkill = getState().content.skills.find(
    (skill) => skill.name === name,
  );
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
      const model = subagentSchema.model;

      const systemContent = [
        getSubagentPrompt(
          subagentSchema.access,
          Object.keys(getState().mcp.clients),
        ),
        getState().content.contextStr,
        getState().content.skillsStr,
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
          // Subagents should always use the provider's default reasoning
          model: getLanguageModel(model),
          instructions: systemContent,
          messages: [userMessage],
          tools: {
            ...subagentSafeTools,
            ...mcpResourceTools,
            ...getState().mcp.tools,
          },
          stopWhen: aiDeps.isLoopFinished(),
          ...(signal === undefined ? {} : { abortSignal: signal }),
          timeout: subagentTimeoutSettings,
          onToolExecutionStart: async ({ toolCall }) => {
            if (subagentSchema.access !== "read-write") return;
            if (toolCall.toolName !== "bash") return;

            const bashSchemaResult = bashToolInputSchema.parse(toolCall.input);
            if (
              bashSchemaResult.fileSystemAccessType === "create-update-delete"
            ) {
              await toolCallDiffer.setTempFileBefore(
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
                await toolCallDiffer.cleanupTempFileBefore(toolCall.toolCallId);
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
        await toolCallDiffer.cleanupAllTempFileBefore();

        if (isAbortError(generateTextResult.error)) {
          throw generateTextResult.error;
        }
        return {
          content: getMessageFromError(generateTextResult.error),
          isError: true,
          model,
          prompt: subagentSchema.prompt,
        };
      }

      const { usage, text } = generateTextResult.value;
      await appendModelUsage(usage, model);
      await toolCallDiffer.cleanupAllTempFileBefore();

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

const mediaTypeByExtension: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const readImageSchema = z.object({ filePath: z.string() });
export type ReadImageTool = z.infer<typeof readImageSchema>;

export const mcpListResourcesSchema = z.object({
  server: z
    .string()
    .describe("The name of the mcp server to list resources from"),
  cursor: z
    .string()
    .optional()
    .describe("The cursor from a previous list to continue paging"),
});
export type McpListResourcesTool = z.infer<typeof mcpListResourcesSchema>;

export async function executeMcpListResourcesTool({
  server,
  cursor,
}: McpListResourcesTool): Promise<ToolResult> {
  const client = getState().mcp.clients[server];
  if (client === undefined) {
    return {
      isError: true,
      content: `Unknown mcp server: ${server}`,
    };
  }
  const listResult = await tryCatchAsync(
    client.listResources(cursor === undefined ? {} : { params: { cursor } }),
  );
  if (!listResult.ok) {
    return {
      isError: true,
      content: getMessageFromError(listResult.error),
    };
  }
  return {
    isError: false,
    content: stringify({
      resources: listResult.value.resources,
      nextCursor: listResult.value.nextCursor ?? null,
    }),
  };
}

export const mcpReadResourceSchema = z.object({
  server: z
    .string()
    .describe("The name of the mcp server to read the resource from"),
  uri: z.string().describe("The uri of the resource to read"),
});
export type McpReadResourceTool = z.infer<typeof mcpReadResourceSchema>;

export async function executeMcpReadResourceTool({
  server,
  uri,
}: McpReadResourceTool): Promise<ToolResult> {
  const client = getState().mcp.clients[server];
  if (client === undefined) {
    return {
      isError: true,
      content: `Unknown mcp server: ${server}`,
    };
  }
  const readResult = await tryCatchAsync(client.readResource({ uri }));
  if (!readResult.ok) {
    return {
      isError: true,
      content: getMessageFromError(readResult.error),
    };
  }
  return {
    isError: false,
    content: stringify(
      readResult.value.contents.map((entry) => ({
        uri: entry.uri,
        mimeType: entry.mimeType ?? null,
        text: entry.text ?? null,
        blob: entry.blob ?? null,
      })),
    ),
  };
}

export type ReadImageResult =
  | { isError: true; content: string }
  | { isError: false; base64Data: string; mediaType: string };

export async function executeReadImageTool(
  { filePath }: ReadImageTool,
  signal?: AbortSignal,
): Promise<ReadImageResult> {
  const readFileResult = await tryCatchAsync(
    fsDeps.readFile(filePath, { signal }),
  );
  if (!readFileResult.ok) {
    if (isAbortError(readFileResult.error)) {
      throw readFileResult.error;
    }

    return {
      isError: true,
      content: getMessageFromError(readFileResult.error),
    };
  }
  const mediaType = mediaTypeByExtension[extname(filePath).toLowerCase()];
  if (mediaType === undefined) {
    return {
      isError: true,
      content: `Unsupported image file type: ${extname(filePath)}`,
    };
  }
  return {
    isError: false,
    base64Data: readFileResult.value.toString("base64"),
    mediaType,
  };
}

const mcpResourceTools = {
  mcp_list_resources: tool({
    description: "List the resources of an mcp server",
    inputSchema: mcpListResourcesSchema,
    execute: (args) => executeMcpListResourcesTool(args),
  }),
  mcp_read_resource: tool({
    description: "Read a resource from an mcp server",
    inputSchema: mcpReadResourceSchema,
    execute: (args) => executeMcpReadResourceTool(args),
  }),
};

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
  read_image: tool({
    description: "Read an image file from disk so you can look at it",
    inputSchema: readImageSchema,
    execute: (args, opts) => executeReadImageTool(args, opts.abortSignal),
    toModelOutput: ({ output }) => {
      if (output.isError) {
        return { type: "text", value: output.content };
      }

      return {
        type: "content",
        value: [
          {
            type: "file",
            data: { type: "data", data: output.base64Data },
            mediaType: output.mediaType,
          },
        ],
      };
    },
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
  ...mcpResourceTools,
  ...baseAgentTools,
};

export function getBaseAgentTools() {
  return { ...harnessTools, ...getState().mcp.tools };
}

export function stringifyTools() {
  return safeStringify(getBaseAgentTools());
}
