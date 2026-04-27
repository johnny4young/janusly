export type RunExplanationInput = {
  run: unknown;
  events: unknown[];
  question?: string;
};

export type RunExplanation = {
  answer: string;
  mode: "ai" | "fallback";
  model?: string;
  aiError?: string;
};

export type OpenAIResponseClient = {
  responses: {
    create: (input: { model: string; input: string }) => Promise<{ output_text: string }>;
  };
};

export function buildRunExplanationPrompt(input: RunExplanationInput) {
  return `You are an AI workflow observability assistant.

Explain the workflow run in clear, concise terms.
Focus on:
- what happened
- why decisions were made
- failures/retries/rollbacks
- what the user should do next

User question:
${input.question ?? "Explain this run"}

Run:
${JSON.stringify(input.run, null, 2)}

Events:
${JSON.stringify(input.events, null, 2)}

Return a concise answer with bullet points.`;
}

export async function explainRun({
  openai,
  run,
  events,
  question,
  model,
}: RunExplanationInput & {
  openai?: OpenAIResponseClient;
  model?: string;
}): Promise<RunExplanation> {
  if (!openai) {
    return {
      answer: fallbackExplainRun({ run, events, question }),
      mode: "fallback",
    };
  }

  const chosenModel = model ?? "gpt-4o-mini";
  try {
    const response = await openai.responses.create({
      model: chosenModel,
      input: buildRunExplanationPrompt({ run, events, question }),
    });

    return {
      answer: response.output_text,
      mode: "ai",
      model: chosenModel,
    };
  } catch (error) {
    return {
      answer: fallbackExplainRun({ run, events, question }),
      mode: "fallback",
      aiError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function fallbackExplainRun(input: RunExplanationInput): string {
  const events = input.events as Array<{ type?: string }>;
  const failed = events.filter((event) => event.type?.includes("failed"));
  const retries = events.filter((event) => event.type?.includes("retry"));
  const decisions = events.filter((event) => event.type === "decision.made");
  const rollbacks = events.filter((event) => event.type?.startsWith("rollback."));
  const skipped = events.filter((event) => event.type === "node.skipped");

  return [
    `Run summary: ${events.length} events observed.`,
    decisions.length ? `Decisions made: ${decisions.length}.` : "No routing decisions were recorded.",
    retries.length ? `Retries scheduled/executed: ${retries.length}.` : "No retries were recorded.",
    failed.length ? `Failures detected: ${failed.length}.` : "No failures were detected.",
    skipped.length ? `Nodes skipped by edge conditions: ${skipped.length}.` : "All reachable nodes ran.",
    rollbacks.length ? `Rollback activity detected: ${rollbacks.length}.` : "No rollback activity detected.",
  ].join("\n");
}
