import { extname, join } from "node:path";
import TurndownService from "turndown";
import { tool } from "ai";
import { z } from "zod";
import { childProcessDeps, fsDeps } from "./deps.ts";
import { getState } from "./state.ts";
import { getWebpagesDir } from "./paths.ts";
import {
  getMessageFromError,
  getTimeoutError,
  isAbortError,
  tryCatchAsync,
  strToApproxTokens,
  stringify,
} from "./utils.ts";

export interface ToolOutput {
  toolPrint: (label: string, detail: string) => void;
  printDoing: (text: string) => void;
}

const userAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface ToolResult {
  content: string;
  isError: boolean;
}

export type BashToolInput =
  | {
      fileSystemAccessType: "read";
      command: string;
    }
  | {
      fileSystemAccessType: "create-update-delete";
      filePaths: string[];
      command: string;
    };

export const bashToolInputSchema = z
  .object({
    fileSystemAccessType: z
      .enum(["read", "create-update-delete"])
      .describe(
        "Use read for commands that only read project files. Use create-update-delete when the command creates, updates, or deletes a project file.",
      ),
    filePaths: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        "List of affected project file paths; each must point to a file, not a directory. Required when fileSystemAccessType is create-update-delete. Temporary scratch files used only as intermediates should not be listed.",
      ),
    command: z.string().describe("The bash command to run"),
  })
  .describe(
    "Run a bash command. Commands writing only to temporary files count as read; otherwise specify the target file path and use create-update-delete.",
  )
  .refine(
    (input): input is BashToolInput => {
      if (input.fileSystemAccessType === "create-update-delete") {
        return input.filePaths !== undefined;
      } else {
        return true;
      }
    },
    {
      message:
        "filePaths is required when fileSystemAccessType is create-update-delete",
    },
  );

export async function executeBashTool(
  { command: bashCommand }: BashToolInput,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const bashPromise = childProcessDeps.exec(bashCommand, {
    shell: "/bin/bash",
    ...(signal === undefined ? undefined : { signal }),
  });
  bashPromise.child.stdin?.end();
  const bashResult = await tryCatchAsync(bashPromise);
  if (!bashResult.ok) {
    if (isAbortError(bashResult.error)) {
      const timeoutError = getTimeoutError(signal);
      if (timeoutError !== null) {
        return { content: getMessageFromError(timeoutError), isError: true };
      }
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
    isError: false,
  };
}

export const webFetchToolSchema = z.object({
  href: z.string().describe("The URL of the web page or JSON API to fetch"),
});

export type WebFetchTool = z.infer<typeof webFetchToolSchema>;

export const timeoutSettings = {
  tools: {
    bashMs: 3 * 60_000,
    web_fetch_htmlMs: 30_000,
    web_fetch_jsonMs: 30_000,
    load_skillMs: 30_000,
    read_imageMs: 30_000,
    mcp_list_resourcesMs: 30_000,
    mcp_read_resourceMs: 30_000,
  },
};

type WebFetchHtmlResult = ToolResult & {
  filePath?: string;
  type?: "inline-markdown" | "file-path";
};

export async function executeWebFetchHtmlTool(
  { href }: WebFetchTool,
  signal: AbortSignal | undefined,
  output: ToolOutput,
): Promise<WebFetchHtmlResult> {
  if (!URL.canParse(href)) {
    return {
      isError: true,
      content: `Cannot parse href ${href} as a URL`,
    };
  }

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
    if (isAbortError(fetchResult.error)) {
      const timeoutError = getTimeoutError(signal);
      if (timeoutError !== null) {
        return { isError: true, content: getMessageFromError(timeoutError) };
      }
      throw fetchResult.error;
    }
    return {
      isError: true,
      content: getMessageFromError(fetchResult.error),
    };
  }

  const response = fetchResult.value;
  if (!response.ok) {
    const error = `HTTP ${String(response.status)}: ${response.statusText} when fetching ${href}`;
    output.toolPrint("web_fetch_html", error);
    output.printDoing(error);
    return {
      isError: true,
      content: error,
    };
  }

  const textResult = await tryCatchAsync(response.text());
  if (!textResult.ok) {
    if (isAbortError(textResult.error)) {
      const timeoutError = getTimeoutError(signal);
      if (timeoutError !== null) {
        return { isError: true, content: getMessageFromError(timeoutError) };
      }
      throw textResult.error;
    }
    return {
      isError: true,
      content: getMessageFromError(textResult.error),
    };
  }
  const htmlStr = textResult.value;

  const turndownService = new TurndownService({ hr: "---" });
  turndownService.remove([
    "script",
    "style",
    "nav",
    "footer",
    "svg",
    "iframe",
    "noscript",
    "template",
    "canvas",
    "video",
    "audio",
    "object",
    "embed",
    "dialog",
    "form",
    "button",
    "input",
    "select",
    "textarea",
    "aside",
    "img",
    "picture",
  ]);
  const markdown = turndownService.turndown(htmlStr);

  const maxTokensForInlineFetch = 10_000;
  const markdownTokensApprox = strToApproxTokens(markdown);
  if (markdownTokensApprox <= maxTokensForInlineFetch) {
    return {
      content: markdown,
      isError: false,
      type: "inline-markdown",
    };
  }

  const url = new URL(href);
  const slug = `${url.host}${url.pathname}`.replace(/[^a-zA-Z0-9]/g, "-");
  const fileName = `${slug}-${String(Date.now())}.md`;
  const filePath = join(getWebpagesDir(), fileName);
  const mkdirResult = await tryCatchAsync(
    fsDeps.mkdir(getWebpagesDir(), { recursive: true }),
  );
  if (!mkdirResult.ok) {
    return {
      isError: true,
      content: `Error while creating the local webpages directory. Error: ${getMessageFromError(mkdirResult.error)}`,
    };
  }
  const writeResult = await tryCatchAsync(fsDeps.writeFile(filePath, markdown));
  if (!writeResult.ok) {
    return {
      isError: true,
      content: `Error while writing the markdown to a local file. Error: ${getMessageFromError(writeResult.error)}`,
    };
  }

  output.toolPrint(
    "web_fetch_html",
    `Webpage markdown written to ${filePath} because it exceeded ${maxTokensForInlineFetch.toLocaleString()} tokens`,
  );
  return {
    content: `The page contains approximately ${markdownTokensApprox.toLocaleString()} tokens. Its Markdown has been saved to \`${filePath}\` rather than included in this response. Use the \`bash\` tool to search the file or read selected lines.`,
    filePath,
    isError: false,
    type: "file-path",
  };
}

export async function executeWebFetchJsonTool(
  { href }: WebFetchTool,
  signal: AbortSignal | undefined,
  output: ToolOutput,
): Promise<ToolResult> {
  if (!URL.canParse(href)) {
    return {
      isError: true,
      content: `Cannot parse href ${href} as a URL`,
    };
  }

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
    if (isAbortError(fetchResult.error)) {
      const timeoutError = getTimeoutError(signal);
      if (timeoutError !== null) {
        return { isError: true, content: getMessageFromError(timeoutError) };
      }
      throw fetchResult.error;
    }
    return {
      content: getMessageFromError(fetchResult.error),
      isError: true,
    };
  }

  const response = fetchResult.value;
  if (!response.ok) {
    const error = `HTTP ${String(response.status)}: ${response.statusText} when fetching ${href}`;
    output.toolPrint("web_fetch_json", error);
    return {
      isError: true,
      content: error,
    };
  }

  const jsonResult = await tryCatchAsync(response.json());
  if (!jsonResult.ok) {
    if (isAbortError(jsonResult.error)) {
      const timeoutError = getTimeoutError(signal);
      if (timeoutError !== null) {
        return { isError: true, content: getMessageFromError(timeoutError) };
      }
      throw jsonResult.error;
    }
    return {
      content: getMessageFromError(jsonResult.error),
      isError: true,
    };
  }
  const json = jsonResult.value;
  return {
    content: stringify(json),
    isError: false,
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
    isError: false,
  };
}

const mediaTypeByExtension: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export const readImageSchema = z.object({ filePath: z.string() });

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
      const timeoutError = getTimeoutError(signal);
      if (timeoutError !== null) {
        return { isError: true, content: getMessageFromError(timeoutError) };
      }
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

export const mcpResourceTools = {
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

export function createSubagentSafeTools(output: ToolOutput) {
  return {
    web_fetch_html: tool({
      description:
        "Fetch a web page by URL and return its readable content, parsed to extract the main article.",
      inputSchema: webFetchToolSchema,
      execute: (args, opts) =>
        executeWebFetchHtmlTool(args, opts.abortSignal, output),
    }),
    web_fetch_json: tool({
      description:
        "Fetch a JSON API endpoint by URL and return the parsed JSON response.",
      inputSchema: webFetchToolSchema,
      execute: (args, opts) =>
        executeWebFetchJsonTool(args, opts.abortSignal, output),
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
}
