/**
 * Parametrised matrix test over the recovery fixtures. For each
 * failure shape we synthesize a realistic LLM-emitted suggestion
 * (`patchedConfig` + metadata), feed it through the same per-type
 * envelope schema the route uses, and through the same merge +
 * validation pipeline. The contract we pin per-fixture:
 *
 *   1. The per-type envelope schema parses the suggestion (provider
 *      strict-mode shape compatibility — caught at compile time AND at
 *      LLM-output validation time).
 *   2. Merging the suggestion's `patchedConfig` onto the failing node
 *      produces a structurally-different workflow vs the original
 *      (otherwise the dialog's diff would be empty and Apply disabled).
 *   3. The merged workflow passes `validateWorkflow` (the route's
 *      post-merge gate, including tool input validation).
 *   4. The fixture's `expectedTopApproachLabel` is one of the closed
 *      enum values — defensive against typos creeping into the catalog.
 *
 * One synthetic suggestion per fixture is enough; the broader
 * "1-3 suggestions, sorted by confidence desc, drop invalid ones"
 * contract is covered separately in `ai-patch-schema.test.ts` and the
 * route-level happy path. This file's job is breadth, not depth.
 */
import { describe, expect, it } from "vitest";
import { WorkflowSchema } from "@janusly/shared";
import { validateWorkflow } from "@janusly/engine";
import { applyConfigPatchToWorkflow } from "./patch-workflow-merge";
import {
  AiPatchAgentConfigEnvelope,
  AiPatchAiConfigEnvelope,
  AiPatchApprovalConfigEnvelope,
  AiPatchConditionConfigEnvelope,
  AiPatchGenericConfigEnvelope,
  AiPatchHttpConfigEnvelope,
  AiPatchLoopConfigEnvelope,
  AiPatchRouterConfigEnvelope,
  AiPatchToolConfigEnvelope,
  AiPatchTransformConfigEnvelope,
  patchEnvelopeForNodeType,
  type AiPatchApproachLabelValue,
} from "./ai-schemas";
import { RECOVERY_MATRIX_FIXTURES } from "./recovery-matrix-fixtures";

type ApproachLabel = AiPatchApproachLabelValue;

/**
 * Build a realistic LLM-emitted suggestions array for a fixture. The
 * fixture's expected approach drives the patch shape — we don't have to
 * cover every alternative here because the route already validates and
 * drops bad ones; this gives the matrix one strong "best guess" patch
 * per fixture so we can pin the merge + WorkflowSchema contract.
 *
 * Mirrors the per-type envelope shape the LLM would emit. Typed
 * envelopes (http/tool/agent) require every nullable field to be
 * present; generic envelopes carry only the fields being changed.
 */
function suggestionsForFixture(fixture: typeof RECOVERY_MATRIX_FIXTURES[number]): {
  envelopeKind: "http" | "tool" | "agent" | "transform" | "condition" | "ai" | "router" | "approval" | "loop" | "generic";
  parsed: { suggestions: Array<{ patchedConfig: Record<string, unknown>; rationale: string; approachLabel: ApproachLabel; confidence: number }> };
} {
  const failingNode = fixture.workflow.nodes.find((node) => node.id === fixture.failedNodeId)!;
  const nodeType = failingNode.type;
  const envelope = patchEnvelopeForNodeType(nodeType);

  // The patch shapes below are intentionally minimal but structurally
  // valid — enough to produce a non-zero diff against the original
  // workflow so the actionable-suggestion check passes. http carries
  // 7 nullable-required fields (`headers` is the array-of-pairs patch
  // form added to this envelope); tool carries 4 (`input` is the
  // equivalent array-of-pairs form).
  const baseHttp: Record<string, unknown> = {
    url: null,
    method: null,
    headers: null,
    retry: null,
    timeoutMs: null,
    maxResponseBytes: null,
    maxRedirects: null,
  };
  const baseTool: Record<string, unknown> = {
    tool: null,
    input: null,
    retry: null,
    timeoutMs: null,
  };

  let patchedConfig: Record<string, unknown>;
  switch (envelope.kind) {
    case "http": {
      switch (fixture.expectedTopApproachLabel) {
        case "fix_url":
          patchedConfig = { ...baseHttp, url: "https://api.example/fixed" };
          break;
        case "add_retry":
          patchedConfig = { ...baseHttp, retry: { maxAttempts: 3 } };
          break;
        case "raise_timeout":
          patchedConfig = { ...baseHttp, timeoutMs: 60_000 };
          break;
        case "swap_secret_ref":
          // The fix lives in the headers map — the array-of-pairs patch
          // form swaps the literal `Authorization` token to a
          // `{{secret.NAME}}` template. The merge layer folds against
          // the existing `node.config.headers` record.
          patchedConfig = {
            ...baseHttp,
            headers: [{ name: "Authorization", value: "Bearer {{secret.GITHUB_TOKEN}}" }],
          };
          break;
        case "add_approval":
          // Engine-side "add an approval upstream" isn't a config patch
          // on the failing node — closest representation is adding a
          // retry so the diff is non-empty. Structural multi-node
          // patches are outside this config-only matrix.
          patchedConfig = { ...baseHttp, retry: { maxAttempts: 2 } };
          break;
        case "other":
          if (fixture.id === "http_body_cap") {
            patchedConfig = { ...baseHttp, maxResponseBytes: 5_242_880 };
          } else if (fixture.id === "http_redirect_loop") {
            patchedConfig = { ...baseHttp, maxRedirects: 10 };
          } else {
            patchedConfig = { ...baseHttp, retry: { maxAttempts: 2 } };
          }
          break;
        default:
          patchedConfig = { ...baseHttp, retry: { maxAttempts: 2 } };
          break;
      }
      break;
    }
    case "tool": {
      if (fixture.id === "tool_input_invalid") {
        // The fix is to populate `text.replace`'s required input fields;
        // exercises the new array-of-pairs `input` patch form.
        patchedConfig = {
          ...baseTool,
          input: [
            { name: "value", value: "{{context.fetch.output.body}}" },
            { name: "search", value: "foo" },
            { name: "replacement", value: "bar" },
          ],
        };
      } else {
        patchedConfig = { ...baseTool, tool: "text.regex" };
      }
      break;
    }
    case "agent": {
      patchedConfig = { goal: null, retry: { maxAttempts: 3 }, timeoutMs: null };
      break;
    }
    case "transform": {
      // mapping is the array-of-pairs patch form. Use a non-empty array
      // so the merge fold produces a non-empty record.
      patchedConfig = {
        mapping: [
          { name: "summary", value: "{{context.fetch.output.body}}" },
        ],
      };
      break;
    }
    case "condition": {
      // Single nullable-required scalar field. Engine grammar accepts
      // `context.<id>.output.<path>` so the post-merge `validateExpression`
      // step doesn't drop the suggestion.
      patchedConfig = { expression: "context.calc.output.x > 5" };
      break;
    }
    case "ai": {
      // ai envelope: prompt + model + retry. Pick the field that
      // matters per fixture: ai_prompt_missing_grounding wants a fresh
      // prompt; ai_provider_transient wants a retry.
      if (fixture.id === "ai_prompt_missing_grounding") {
        patchedConfig = {
          prompt: "Summarize {{context.fetch.output.body}} in 2 sentences.",
          model: null,
          retry: null,
        };
      } else {
        patchedConfig = { prompt: null, model: null, retry: { maxAttempts: 3 } };
      }
      break;
    }
    case "router": {
      // candidates is a verbatim-replace array. The current
      // `router_unknown_candidate` fixture's workflow includes a real
      // node id ("real_path") so the synthesizer's hardcoded reference
      // produces a structurally-valid merge. If a future router fixture
      // doesn't include a node named "real_path", switch on `fixture.id`
      // here to pick a node id that exists in that fixture's workflow.
      patchedConfig = {
        candidates: [{ nodeId: "real_path" }],
        strategy: null,
      };
      break;
    }
    case "approval": {
      patchedConfig = { message: "Please approve the operation." };
      break;
    }
    case "loop": {
      patchedConfig = {
        items: "{{context.fetch.output.list}}",
        mapping: null,
      };
      break;
    }
    default: {
      // generic envelope is open — emit only the changed field. Pick
      // something minimal that demonstrates a patch was made.
      patchedConfig = { __recovery_marker: true };
      break;
    }
  }

  // `envelope.kind` is `PatchEnvelopeKind` (includes "structural"), but
  // `patchEnvelopeForNodeType` never returns "structural" — that envelope
  // is route-level only. Narrow at the boundary so `ENVELOPE_BY_KIND`
  // indexing stays type-safe.
  if (envelope.kind === "structural") {
    throw new Error(`patchEnvelopeForNodeType should never return "structural"; saw it for nodeType=${nodeType}`);
  }
  return {
    envelopeKind: envelope.kind,
    parsed: {
      suggestions: [{
        patchedConfig,
        rationale: `Recommended fix for ${fixture.label}.`,
        approachLabel: fixture.expectedTopApproachLabel,
        confidence: 80,
      }],
    },
  };
}

const ENVELOPE_BY_KIND = {
  http: AiPatchHttpConfigEnvelope,
  tool: AiPatchToolConfigEnvelope,
  agent: AiPatchAgentConfigEnvelope,
  transform: AiPatchTransformConfigEnvelope,
  condition: AiPatchConditionConfigEnvelope,
  ai: AiPatchAiConfigEnvelope,
  router: AiPatchRouterConfigEnvelope,
  approval: AiPatchApprovalConfigEnvelope,
  loop: AiPatchLoopConfigEnvelope,
  generic: AiPatchGenericConfigEnvelope,
} as const;

const ALL_APPROACH_LABELS: ApproachLabel[] = [
  "add_retry",
  "raise_timeout",
  "swap_secret_ref",
  "add_approval",
  "fix_url",
  "other",
];

describe("recovery matrix — per-fixture contract", () => {
  it("the catalog covers at least 8 distinct failure shapes", () => {
    expect(RECOVERY_MATRIX_FIXTURES.length).toBeGreaterThanOrEqual(8);
    const ids = new Set(RECOVERY_MATRIX_FIXTURES.map((f) => f.id));
    expect(ids.size).toBe(RECOVERY_MATRIX_FIXTURES.length);
  });

  it("every fixture's expectedTopApproachLabel is in the closed enum", () => {
    for (const fixture of RECOVERY_MATRIX_FIXTURES) {
      expect(ALL_APPROACH_LABELS).toContain(fixture.expectedTopApproachLabel);
    }
  });

  for (const fixture of RECOVERY_MATRIX_FIXTURES) {
    describe(`${fixture.id} — ${fixture.label}`, () => {
      const built = suggestionsForFixture(fixture);

      it("envelope schema parses the synthesized suggestions array", () => {
        const envelope = ENVELOPE_BY_KIND[built.envelopeKind];
        const parsed = envelope.safeParse(built.parsed);
        expect(parsed.success).toBe(true);
      });

      it("merge produces a structurally-different workflow", () => {
        const original = WorkflowSchema.safeParse(fixture.workflow);
        expect(original.success).toBe(true);
        if (!original.success) return;
        const item = built.parsed.suggestions[0]!;
        const merged = applyConfigPatchToWorkflow(original.data, fixture.failedNodeId, item.patchedConfig);
        // The merged workflow should NOT equal the original — the diff
        // surface depends on it. We compare by JSON serialisation
        // because deep-equal on Drizzle/Zod-augmented objects is noisy.
        expect(JSON.stringify(merged)).not.toBe(JSON.stringify(fixture.workflow));
      });

      it("merged workflow passes the route's post-merge workflow validation", () => {
        const original = WorkflowSchema.safeParse(fixture.workflow);
        expect(original.success).toBe(true);
        if (!original.success) return;
        const item = built.parsed.suggestions[0]!;
        const merged = applyConfigPatchToWorkflow(original.data, fixture.failedNodeId, item.patchedConfig);
        const validation = validateWorkflow(merged);
        expect(validation.issues).toEqual([]);
        expect(validation.valid).toBe(true);
      });
    });
  }
});
