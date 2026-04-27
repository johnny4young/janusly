import type { Workflow } from "@janusly/shared";

export type WorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  category: string;
  workflow: Workflow;
};

export const workflowTemplates: WorkflowTemplate[] = [
  {
    id: "http-ai-summary",
    name: "HTTP → AI Summary",
    description: "Call an API and summarize the response with an AI/agent step.",
    category: "AI",
    workflow: {
      dslVersion: "1.0",
      id: "http-ai-summary",
      name: "HTTP → AI Summary",
      nodes: [
        { id: "api", type: "http", config: { url: "https://api.github.com" } },
        { id: "summary", type: "ai", config: { prompt: "Summarize the API response for an operator and suggest the next action: {{context.api.output.body}}" } }
      ],
      edges: [{ from: "api", to: "summary" }]
    }
  },
  {
    id: "api-transform-tool",
    name: "API → Transform → Tool",
    description: "Fetch data, map outputs, and run a backend tool.",
    category: "Data",
    workflow: {
      dslVersion: "1.0",
      id: "api-transform-tool",
      name: "API → Transform → Tool",
      nodes: [
        { id: "api", type: "http", config: { url: "https://api.github.com" } },
        { id: "transform", type: "transform", config: { mapping: { statusCode: "{{context.api.output.statusCode}}", ok: "{{context.api.output.ok}}" } } },
        { id: "tool", type: "tool", config: { tool: "text.uppercase", input: { value: "status {{context.transform.output.statusCode}}" } } }
      ],
      edges: [{ from: "api", to: "transform" }, { from: "transform", to: "tool" }]
    }
  },
  {
    id: "approval-gate",
    name: "Human Approval Gate",
    description: "Pause execution until a human approves the run.",
    category: "Human-in-the-loop",
    workflow: {
      dslVersion: "1.0",
      id: "approval-gate",
      name: "Human Approval Gate",
      nodes: [
        { id: "start", type: "noop", config: {} },
        { id: "approval", type: "approval", config: { message: "Approve to continue." } },
        { id: "done", type: "noop", config: {} }
      ],
      edges: [{ from: "start", to: "approval" }, { from: "approval", to: "done" }]
    }
  }
];
