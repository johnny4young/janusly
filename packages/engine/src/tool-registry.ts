import { getByPath } from "./template";

export type ToolContext = {
  input: any;
  context: Record<string, any>;
};

export type ToolHandler = (ctx: ToolContext) => Promise<Record<string, unknown>>;

export const toolRegistry: Record<string, ToolHandler> = {
  "http.request": async ({ input }) => {
    const res = await fetch(input.url, {
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

export async function executeTool(name: string, input: any, context: Record<string, any>) {
  const tool = toolRegistry[name];

  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  return tool({ input, context });
}
