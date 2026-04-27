import OpenAI from "openai";
import { loadRootEnv } from "@janusly/db";

loadRootEnv();

let openai: OpenAI | null = null;

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

export type AgentPlan = {
  tool: string;
  input: Record<string, unknown>;
  reason: string;
};

export type AgentLoopStep = {
  iteration: number;
  plan: AgentPlan;
  result: Record<string, unknown>;
};

const availableTools = [
  {
    name: "http.request",
    description: "Make an HTTP request to an external API.",
    inputShape: { url: "string", method: "GET|POST", headers: "object optional", body: "object optional" }
  },
  {
    name: "text.uppercase",
    description: "Convert text to uppercase.",
    inputShape: { value: "string" }
  },
  {
    name: "json.pick",
    description: "Pick a value from workflow context using a dot path.",
    inputShape: { path: "string" }
  }
];

export function planAgentTool(config: any, context: Record<string, any>): AgentPlan {
  if (config.tool) {
    return {
      tool: config.tool,
      input: config.input ?? {},
      reason: "Explicit tool selected by node config",
    };
  }

  const goal = String(config.goal ?? "").toLowerCase();

  if (goal.includes("uppercase") || goal.includes("upper case")) {
    return {
      tool: "text.uppercase",
      input: { value: config.value ?? config.text ?? "" },
      reason: "Goal matched text uppercase transformation",
    };
  }

  if (goal.includes("pick") || goal.includes("extract")) {
    return {
      tool: "json.pick",
      input: { path: config.path ?? "" },
      reason: "Goal matched JSON extraction",
    };
  }

  if (goal.includes("http") || goal.includes("request") || goal.includes("call api")) {
    return {
      tool: "http.request",
      input: {
        url: config.url,
        method: config.method ?? "GET",
        body: config.body,
        headers: config.headers,
      },
      reason: "Goal matched HTTP/API request",
    };
  }

  return {
    tool: "text.uppercase",
    input: { value: JSON.stringify({ goal: config.goal, context }) },
    reason: "Fallback planner selected text.uppercase",
  };
}

export async function planAgentToolWithLLM(
  config: any,
  context: Record<string, any>,
  history: AgentLoopStep[] = []
): Promise<AgentPlan & { done?: boolean; finalAnswer?: string }> {
  const client = getOpenAIClient();

  if (!client) {
    return planAgentTool(config, context);
  }

  const goal = config.goal ?? "Choose the best tool for this workflow step.";

  const response = await client.responses.create({
    model: config.model ?? "gpt-4o-mini",
    input: [
      {
        role: "system",
        content: "You are a workflow agent planner. Select exactly one tool from availableTools, or return done=true if the goal is complete. Return only valid JSON."
      },
      {
        role: "user",
        content: JSON.stringify({
          goal,
          config,
          context,
          history,
          availableTools,
          requiredJsonShape: {
            done: "boolean optional",
            finalAnswer: "string optional",
            tool: "one available tool name when not done",
            input: "object with tool input when not done",
            reason: "short reason"
          }
        })
      }
    ],
    text: { format: { type: "json_object" } }
  });

  const parsed = JSON.parse(response.output_text || "{}");

  if (parsed.done) {
    return {
      tool: "done",
      input: {},
      reason: parsed.reason ?? "Goal completed",
      done: true,
      finalAnswer: parsed.finalAnswer ?? "Done",
    };
  }

  if (!parsed.tool || typeof parsed.tool !== "string") {
    throw new Error("LLM planner did not return a valid tool");
  }

  return {
    tool: parsed.tool,
    input: parsed.input ?? {},
    reason: parsed.reason ?? "LLM selected tool",
  };
}
