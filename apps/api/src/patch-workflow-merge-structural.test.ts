/**
 * Unit tests for `applyStructuralPatchToWorkflow` — the structural
 * patch applier that inserts an approval node upstream of a failing
 * write-side action.
 *
 * The applier is pure and side-effect-free; tests build small
 * workflows directly without touching the helper, the LLM, or the DB.
 * Route dispatch stays in `ai-routes`; these tests pin the structural
 * merge contract that route relies on.
 */
import { describe, expect, it } from "vitest";
import { WorkflowSchema, type Workflow } from "@janusly/shared";
import {
  AiPatchStructuralEnvelope,
} from "./ai-schemas";
import { applyStructuralPatchToWorkflow } from "./patch-workflow-merge";

function chargeWorkflow(extra?: Partial<Workflow>): Workflow {
  return {
    dslVersion: "1.0",
    id: "billing_flow",
    name: "Billing flow",
    nodes: [
      { id: "start", type: "noop", config: {} },
      { id: "lookup", type: "http", config: { url: "https://api.example/customers", method: "GET" } },
      { id: "charge", type: "http", config: { url: "https://api.example/charges", method: "POST" } },
    ],
    edges: [
      { from: "start", to: "lookup" },
      { from: "lookup", to: "charge" },
    ],
    ...extra,
  } as Workflow;
}

describe("applyStructuralPatchToWorkflow — happy path", () => {
  it("inserts an approval node and rewires the single incoming edge", () => {
    const merged = applyStructuralPatchToWorkflow(chargeWorkflow(), {
      action: "insert_approval_upstream",
      approvalNodeId: "approve_charge",
      approvalMessage: "Approve charging this customer?",
      insertBeforeNodeId: "charge",
    });

    expect(merged.nodes.map((n) => n.id).sort()).toEqual(["approve_charge", "charge", "lookup", "start"]);
    const approval = merged.nodes.find((n) => n.id === "approve_charge")!;
    expect(approval.type).toBe("approval");
    expect(approval.config).toEqual({ message: "Approve charging this customer?" });

    // Original `lookup → charge` rewrites to `lookup → approve_charge`;
    // a fresh `approve_charge → charge` edge is appended.
    expect(merged.edges).toEqual([
      { from: "start", to: "lookup" },
      { from: "lookup", to: "approve_charge" },
      { from: "approve_charge", to: "charge" },
    ]);
  });

  it("re-parses cleanly through the strict engine WorkflowSchema", () => {
    const merged = applyStructuralPatchToWorkflow(chargeWorkflow(), {
      action: "insert_approval_upstream",
      approvalNodeId: "approve_charge",
      approvalMessage: "Approve charge?",
      insertBeforeNodeId: "charge",
    });

    const parsed = WorkflowSchema.safeParse(merged);
    expect(parsed.success).toBe(true);
  });

  it("inserts an approval upstream of an mcp_tool failing-node target (type-agnostic merger)", () => {
    // Merger only inspects edges + node ids; the failing node's `type`
    // is opaque to it. Pinning this contract prevents a future regression
    // that would special-case `http` in the merger and silently miss
    // `mcp_tool` targets the dispatcher now routes through.
    const workflow: Workflow = {
      dslVersion: "1.0",
      id: "notion_flow",
      name: "Notion flow",
      nodes: [
        { id: "intent", type: "noop", config: {} },
        {
          id: "edit_page",
          type: "mcp_tool",
          config: {
            connectionAlias: "notion",
            toolName: "pages.update",
            input: { pageId: "{{context.intent.output.pageId}}" },
          },
        },
      ],
      edges: [{ from: "intent", to: "edit_page" }],
    } as Workflow;

    const merged = applyStructuralPatchToWorkflow(workflow, {
      action: "insert_approval_upstream",
      approvalNodeId: "approve_edit",
      approvalMessage: "Approve editing the Notion page?",
      insertBeforeNodeId: "edit_page",
    });

    expect(merged.nodes.map((n) => n.id).sort()).toEqual(["approve_edit", "edit_page", "intent"]);
    const approval = merged.nodes.find((n) => n.id === "approve_edit")!;
    expect(approval.type).toBe("approval");
    expect(merged.edges).toEqual([
      { from: "intent", to: "approve_edit" },
      { from: "approve_edit", to: "edit_page" },
    ]);
    const parsed = WorkflowSchema.safeParse(merged);
    expect(parsed.success).toBe(true);
  });
});

describe("applyStructuralPatchToWorkflow — multi-predecessor rewiring", () => {
  it("rewires every edge whose `to` is the failing node, leaving outgoing edges intact", () => {
    const workflow: Workflow = {
      dslVersion: "1.0",
      nodes: [
        { id: "pick_a", type: "noop", config: {} },
        { id: "pick_b", type: "noop", config: {} },
        { id: "charge", type: "http", config: { url: "https://api.example/charges", method: "POST" } },
        { id: "notify", type: "noop", config: {} },
      ],
      edges: [
        { from: "pick_a", to: "charge" },
        { from: "pick_b", to: "charge" },
        { from: "charge", to: "notify" },
      ],
    } as Workflow;

    const merged = applyStructuralPatchToWorkflow(workflow, {
      action: "insert_approval_upstream",
      approvalNodeId: "approve_charge",
      approvalMessage: "Confirm before charging.",
      insertBeforeNodeId: "charge",
    });

    // BOTH incoming edges flow through the approval; the outgoing edge
    // from `charge` is untouched.
    expect(merged.edges).toEqual([
      { from: "pick_a", to: "approve_charge" },
      { from: "pick_b", to: "approve_charge" },
      { from: "charge", to: "notify" },
      { from: "approve_charge", to: "charge" },
    ]);
  });

  it("handles a workflow where the failing node has no incoming edges (root write-side)", () => {
    // Edge-case: charge is the first node. Structural patch adds the
    // approval but there are no incoming edges to rewrite. The new
    // approval becomes the root node and gates the former root write.
    const workflow: Workflow = {
      dslVersion: "1.0",
      nodes: [
        { id: "charge", type: "http", config: { url: "https://api.example/charges", method: "POST" } },
      ],
      edges: [],
    } as Workflow;

    const merged = applyStructuralPatchToWorkflow(workflow, {
      action: "insert_approval_upstream",
      approvalNodeId: "approve_charge",
      approvalMessage: "Confirm.",
      insertBeforeNodeId: "charge",
    });

    expect(merged.nodes).toHaveLength(2);
    expect(merged.edges).toEqual([{ from: "approve_charge", to: "charge" }]);
  });
});

describe("applyStructuralPatchToWorkflow — rejection paths", () => {
  it("rejects when the target node id does not exist", () => {
    expect(() =>
      applyStructuralPatchToWorkflow(chargeWorkflow(), {
        action: "insert_approval_upstream",
        approvalNodeId: "approve_x",
        approvalMessage: "Approve?",
        insertBeforeNodeId: "missing_node",
      }),
    ).toThrow(/does not exist in the workflow/);
  });

  it("rejects when the approval node id collides with an existing node", () => {
    expect(() =>
      applyStructuralPatchToWorkflow(chargeWorkflow(), {
        action: "insert_approval_upstream",
        // Collides with the existing "lookup" node.
        approvalNodeId: "lookup",
        approvalMessage: "Approve?",
        insertBeforeNodeId: "charge",
      }),
    ).toThrow(/collides with an existing node/);
  });

  it("rejects when the suggested target does not match the failing node", () => {
    expect(() =>
      applyStructuralPatchToWorkflow(chargeWorkflow(), {
        action: "insert_approval_upstream",
        approvalNodeId: "approve_charge",
        approvalMessage: "Approve?",
        insertBeforeNodeId: "lookup",
      }, "charge"),
    ).toThrow(/does not match failing node/);
  });

  it("rejects an unknown action literal as a defensive guard", () => {
    expect(() =>
      applyStructuralPatchToWorkflow(chargeWorkflow(), {
        // @ts-expect-error — defense in depth against malformed input
        action: "unknown_action",
        approvalNodeId: "approve_charge",
        approvalMessage: "Approve?",
        insertBeforeNodeId: "charge",
      }),
    ).toThrow(/Unknown structural patch action/);
  });
});

describe("AiPatchStructuralEnvelope schema", () => {
  it("accepts a single well-formed suggestion", () => {
    const parsed = AiPatchStructuralEnvelope.safeParse({
      suggestions: [{
        action: "insert_approval_upstream",
        approvalNodeId: "approve_charge",
        approvalMessage: "Approve charge of {{context.intent.output.amount}}?",
        insertBeforeNodeId: "charge",
        rationale: "Charges should be human-reviewed before firing.",
        approachLabel: "add_approval",
        confidence: 92,
      }],
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts up to 3 alternative suggestions", () => {
    const item = (id: string, message: string, confidence: number) => ({
      action: "insert_approval_upstream",
      approvalNodeId: id,
      approvalMessage: message,
      insertBeforeNodeId: "charge",
      rationale: "Approval required before charge fires.",
      approachLabel: "add_approval",
      confidence,
    });
    const parsed = AiPatchStructuralEnvelope.safeParse({
      suggestions: [
        item("approve_charge", "Approve the charge?", 90),
        item("review_charge", "Review before billing.", 70),
        item("manager_approve", "Manager approval required.", 55),
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty suggestions array", () => {
    const parsed = AiPatchStructuralEnvelope.safeParse({ suggestions: [] });
    expect(parsed.success).toBe(false);
  });

  it("rejects more than 3 suggestions (the closed cap)", () => {
    const filler = {
      action: "insert_approval_upstream",
      approvalNodeId: "id",
      approvalMessage: "msg",
      insertBeforeNodeId: "charge",
      rationale: "r",
      approachLabel: "add_approval",
      confidence: 50,
    };
    const parsed = AiPatchStructuralEnvelope.safeParse({
      suggestions: [filler, filler, filler, filler],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an approachLabel other than add_approval", () => {
    const parsed = AiPatchStructuralEnvelope.safeParse({
      suggestions: [{
        action: "insert_approval_upstream",
        approvalNodeId: "approve_charge",
        approvalMessage: "Approve?",
        insertBeforeNodeId: "charge",
        rationale: "r",
        approachLabel: "add_retry",
        confidence: 50,
      }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an action literal other than insert_approval_upstream", () => {
    const parsed = AiPatchStructuralEnvelope.safeParse({
      suggestions: [{
        action: "split_for_retry",
        approvalNodeId: "approve_charge",
        approvalMessage: "Approve?",
        insertBeforeNodeId: "charge",
        rationale: "r",
        approachLabel: "add_approval",
        confidence: 50,
      }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects confidence outside 0-100", () => {
    const baseSuggestion = {
      action: "insert_approval_upstream",
      approvalNodeId: "id",
      approvalMessage: "m",
      insertBeforeNodeId: "charge",
      rationale: "r",
      approachLabel: "add_approval",
    };
    expect(AiPatchStructuralEnvelope.safeParse({
      suggestions: [{ ...baseSuggestion, confidence: -5 }],
    }).success).toBe(false);
    expect(AiPatchStructuralEnvelope.safeParse({
      suggestions: [{ ...baseSuggestion, confidence: 200 }],
    }).success).toBe(false);
  });

  it("rejects empty-string required fields", () => {
    const baseSuggestion = {
      action: "insert_approval_upstream",
      approvalNodeId: "id",
      approvalMessage: "m",
      insertBeforeNodeId: "charge",
      rationale: "r",
      approachLabel: "add_approval",
      confidence: 50,
    };
    expect(AiPatchStructuralEnvelope.safeParse({
      suggestions: [{ ...baseSuggestion, approvalNodeId: "" }],
    }).success).toBe(false);
    expect(AiPatchStructuralEnvelope.safeParse({
      suggestions: [{ ...baseSuggestion, approvalMessage: "" }],
    }).success).toBe(false);
  });
});
