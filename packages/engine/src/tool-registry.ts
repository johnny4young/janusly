import { getByPath } from "./template";
import { fetchHttpTarget } from "./http-policy";

export type ToolContext = {
  input: any;
  context: Record<string, any>;
};

export type ToolSchema = {
  name: string;
  description: string;
  required?: string[];
  optional?: string[];
  inputExample?: Record<string, unknown>;
};

export type ToolHandler = (ctx: ToolContext) => Promise<Record<string, unknown>>;

export const toolSchemas: Record<string, ToolSchema> = {
  "http.request": {
    name: "http.request",
    description: "Make an HTTP request to an external API.",
    required: ["url"],
    optional: ["method", "headers", "body"],
    inputExample: { url: "https://example.com", method: "GET" },
  },
  "text.uppercase": {
    name: "text.uppercase",
    description: "Convert text to uppercase.",
    required: ["value"],
    inputExample: { value: "hello" },
  },
  "json.pick": {
    name: "json.pick",
    description: "Pick a value from workflow context using a dot path.",
    required: ["path"],
    optional: ["source"],
    inputExample: { path: "1.output.statusCode" },
  },
};

export const toolRegistry: Record<string, ToolHandler> = {
  "http.request": async ({ input }) => {
    const res = await fetchHttpTarget(input.url, {
      method: input.method ?? "GET",
      headers: input.headers,
      body: input.body ? JSON.stringify(input.body) : undefined,
    });

    const text = await res.text();

    return {
      statusCode: res.status,
      ok: res.ok,
      body: text,
    };
  },

  "text.uppercase": async ({ input }) => {
    return {
      value: String(input.value ?? "").toUpperCase(),
    };
  },

  "json.pick": async ({ input, context }) => {
    const source = input.source ?? context;
    const path = String(input.path ?? "");

    return {
      value: getByPath(source, path),
    };
  },
};

export function validateToolInput(name: string, input: any) {
  const schema = toolSchemas[name];

  if (!schema) {
    return { valid: false, issues: [`Unknown tool: ${name}`] };
  }

  const issues: string[] = [];
  const payload = input ?? {};

  for (const key of schema.required ?? []) {
    if (payload[key] === undefined || payload[key] === null || payload[key] === "") {
      issues.push(`Missing required input: ${key}`);
    }
  }

  return { valid: issues.length === 0, issues };
}

export function listTools() {
  return Object.values(toolSchemas);
}

export async function executeTool(name: string, input: any, context: Record<string, any>) {
  const tool = toolRegistry[name];

  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const validation = validateToolInput(name, input);

  if (!validation.valid) {
    throw new Error(`Invalid tool input for ${name}: ${validation.issues.join(", ")}`);
  }

  return tool({ input, context });
}
