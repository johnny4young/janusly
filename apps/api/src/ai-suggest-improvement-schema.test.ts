import { describe, expect, it } from "vitest";
import { WorkflowSchema } from "@janusly/shared";
import {
  AiSuggestApproachLabel,
  AiSuggestImprovementEnvelope,
  SUGGEST_MAX_SUGGESTIONS,
} from "./ai-schemas";

const validWorkflow = {
  id: "wf-test",
  name: "Test workflow",
  nodes: [
    { id: "fetch", type: "http", config: { url: "https://example.com/api" } },
  ],
  edges: [],
};

const validSuggestion = (overrides: Partial<{
  patchedWorkflowJson: string;
  patchedWorkflow: unknown;
  rationale: string;
  approachLabel: string;
  confidence: number;
}> = {}) => ({
  patchedWorkflowJson: overrides.patchedWorkflowJson ?? JSON.stringify(overrides.patchedWorkflow ?? validWorkflow),
  rationale: overrides.rationale ?? "Add retry to the fetch node.",
  approachLabel: overrides.approachLabel ?? "add_retry",
  confidence: overrides.confidence ?? 80,
});

describe("AiSuggestImprovementEnvelope — envelope shape", () => {
  it("accepts a single valid suggestion", () => {
    const result = AiSuggestImprovementEnvelope.safeParse({
      suggestions: [validSuggestion()],
    });
    expect(result.success).toBe(true);
  });

  it("accepts exactly SUGGEST_MAX_SUGGESTIONS items", () => {
    const result = AiSuggestImprovementEnvelope.safeParse({
      suggestions: Array.from({ length: SUGGEST_MAX_SUGGESTIONS }, (_, index) => validSuggestion({
        rationale: `Suggestion ${index + 1}`,
        confidence: 80 - index,
      })),
    });
    expect(result.success).toBe(true);
    // The suggest-improvement envelope mirrors the recovery patch
    // posture: 1-3 distinct alternatives in one repeated item schema.
    expect(SUGGEST_MAX_SUGGESTIONS).toBe(3);
  });

  it("rejects more than SUGGEST_MAX_SUGGESTIONS items", () => {
    const result = AiSuggestImprovementEnvelope.safeParse({
      suggestions: Array.from({ length: SUGGEST_MAX_SUGGESTIONS + 1 }, (_, index) => validSuggestion({
        rationale: `Suggestion ${index + 1}`,
        confidence: 80 - index,
      })),
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty suggestions array", () => {
    const result = AiSuggestImprovementEnvelope.safeParse({ suggestions: [] });
    expect(result.success).toBe(false);
  });

  it("rejects suggestions missing required fields", () => {
    const incomplete = { ...validSuggestion(), rationale: undefined };
    const result = AiSuggestImprovementEnvelope.safeParse({
      suggestions: [incomplete],
    });
    expect(result.success).toBe(false);
  });
});

describe("AiSuggestImprovementEnvelope — confidence bounds", () => {
  it("accepts integer confidence in [0, 100]", () => {
    expect(AiSuggestImprovementEnvelope.safeParse({
      suggestions: [validSuggestion({ confidence: 0 })],
    }).success).toBe(true);
    expect(AiSuggestImprovementEnvelope.safeParse({
      suggestions: [validSuggestion({ confidence: 100 })],
    }).success).toBe(true);
  });

  it("rejects confidence < 0 or > 100", () => {
    expect(AiSuggestImprovementEnvelope.safeParse({
      suggestions: [validSuggestion({ confidence: -1 })],
    }).success).toBe(false);
    expect(AiSuggestImprovementEnvelope.safeParse({
      suggestions: [validSuggestion({ confidence: 101 })],
    }).success).toBe(false);
  });

  it("rejects non-integer confidence", () => {
    expect(AiSuggestImprovementEnvelope.safeParse({
      suggestions: [validSuggestion({ confidence: 50.5 })],
    }).success).toBe(false);
  });
});

describe("AiSuggestImprovementEnvelope — approachLabel", () => {
  const validLabels = [
    "add_retry",
    "raise_timeout",
    "swap_secret_ref",
    "add_approval",
    "add_observability",
    "simplify",
    "other",
  ];

  it("accepts every documented approachLabel value", () => {
    for (const label of validLabels) {
      const result = AiSuggestImprovementEnvelope.safeParse({
        suggestions: [validSuggestion({ approachLabel: label })],
      });
      expect(result.success, `label=${label}`).toBe(true);
    }
  });

  it("rejects an unknown approachLabel", () => {
    const result = AiSuggestImprovementEnvelope.safeParse({
      suggestions: [validSuggestion({ approachLabel: "rewrite_universe" })],
    });
    expect(result.success).toBe(false);
  });

  it("AiSuggestApproachLabel enum exposes the same closed set", () => {
    expect(AiSuggestApproachLabel.options).toEqual(validLabels);
  });
});

describe("AiSuggestImprovementEnvelope — rationale length", () => {
  it("accepts a multi-paragraph rationale up to 800 chars", () => {
    const result = AiSuggestImprovementEnvelope.safeParse({
      suggestions: [validSuggestion({ rationale: "x".repeat(800) })],
    });
    expect(result.success).toBe(true);
  });

  it("rejects rationale longer than 800 chars", () => {
    const result = AiSuggestImprovementEnvelope.safeParse({
      suggestions: [validSuggestion({ rationale: "x".repeat(801) })],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty rationale", () => {
    const result = AiSuggestImprovementEnvelope.safeParse({
      suggestions: [validSuggestion({ rationale: "" })],
    });
    expect(result.success).toBe(false);
  });
});

describe("AiSuggestImprovementEnvelope — patchedWorkflowJson shape", () => {
  it("accepts a JSON-stringified workflow with mixed node types", () => {
    const flowWithMixedNodes = {
      ...validWorkflow,
      nodes: [
        { id: "fetch", type: "http", config: { url: "https://example.com" } },
        { id: "decide", type: "condition", config: { expression: "context.fetch.output.status > 200" } },
        { id: "transform", type: "transform", config: { mapping: { result: "{{context.fetch.output.body}}" } } },
        { id: "approve", type: "approval", config: { message: "Approve?" } },
      ],
      edges: [
        { from: "fetch", to: "decide" },
        { from: "decide", to: "transform" },
        { from: "transform", to: "approve" },
      ],
    };
    const result = AiSuggestImprovementEnvelope.safeParse({
      suggestions: [validSuggestion({ patchedWorkflowJson: JSON.stringify(flowWithMixedNodes) })],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty patchedWorkflowJson string", () => {
    const result = AiSuggestImprovementEnvelope.safeParse({
      suggestions: [validSuggestion({ patchedWorkflowJson: "" })],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a patchedWorkflowJson larger than 20000 chars", () => {
    const result = AiSuggestImprovementEnvelope.safeParse({
      suggestions: [validSuggestion({ patchedWorkflowJson: "x".repeat(20001) })],
    });
    expect(result.success).toBe(false);
  });

  it("envelope JSON-payload round-trips through engine WorkflowSchema for downstream validation", () => {
    const result = AiSuggestImprovementEnvelope.safeParse({
      suggestions: [validSuggestion()],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    // The route's contract: parse the JSON, then validate via engine
    // schema. Both steps must succeed for the suggestion to be returned
    // to the operator. This pins both sides at once.
    const parsed = JSON.parse(result.data.suggestions[0]!.patchedWorkflowJson) as unknown;
    const engineParse = WorkflowSchema.safeParse(parsed);
    expect(engineParse.success).toBe(true);
  });
});
