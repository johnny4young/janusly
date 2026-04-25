export type AgentPlan = {
  tool: string;
  input: Record<string, unknown>;
  reason: string;
};

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
      input: {
        value: config.value ?? config.text ?? "",
      },
      reason: "Goal matched text uppercase transformation",
    };
  }

  if (goal.includes("pick") || goal.includes("extract")) {
    return {
      tool: "json.pick",
      input: {
        path: config.path ?? "",
      },
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
    input: {
      value: JSON.stringify({ goal: config.goal, context }),
    },
    reason: "Fallback planner selected text.uppercase",
  };
}
