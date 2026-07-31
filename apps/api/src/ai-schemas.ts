/**
 * Structured-output Zod schemas for the AI surfaces in `apps/api/src/routes/ai-routes.ts`.
 *
 * Two surfaces, two strategies:
 *
 *   - **`/ai/generate-workflow`** — full-workflow generation. Legacy
 *     constrained mode uses `AiGenerationWorkflowSchema`, an 11-branch slim
 *     discriminated union sent to the provider. The default free-JSON path
 *     validates model text server-side through `AiGenerationWorkflowSchemaFreeJson`,
 *     the same base 11 shapes plus `parallel_fork` / `join`. Each config
 *     declares only the fields the operator MUST populate. OpenAI strict mode
 *     rejects provider-side `oneOf`; free-JSON avoids that structured-output
 *     blocker because the union is not sent to the provider.
 *
 *   - **`/ai/patch-workflow`** — failure-recovery config patch. Uses
 *     ONE non-union envelope per call, picked by failing-node type via
 *     `patchEnvelopeForNodeType`. The LLM emits only the patched config
 *     (single concrete shape, no discriminator), and the route composes
 *     the suggested workflow server-side by merging into the original.
 *     Compiles WITHOUT `oneOf` — works on both providers.
 *
 * Why two strategies: a single union schema compiled at the
 * structured-output boundary is incompatible with both providers under
 * realistic field counts. Anthropic caps compiled-grammar size; OpenAI
 * strict mode bans `oneOf` outright. Free-JSON keeps the generation route on
 * local Zod validation without sending any union to the provider. The patch
 * route knows the failing-node type at request time, so it can dispatch to a
 * single concrete schema per call.
 *
 * Used by:
 *   - `apps/api/src/routes/ai-routes.ts` — `/ai/generate-workflow` and
 *     `/ai/patch-workflow` route handlers and the free-JSON parser.
 *   - `apps/api/src/ai-patch-schema.test.ts` — pins per-envelope parse
 *     behavior and the dispatcher.
 *
 * Schema constraints to keep in mind:
 *   - Anthropic structured output rejects empty `{}` schemas
 *     (`z.unknown()`, `z.any()`) with "Empty schema that accepts any
 *     JSON value is not supported." Every typed field has a concrete
 *     type. Generic config patches stay open at the Zod boundary; provider
 *     strict-mode support for those node types needs concrete per-type fields.
 *   - OpenAI strict mode rejects root-level union/composition shapes from
 *     `discriminatedUnion` and does not support `not`. Leaf `anyOf` is fine
 *     for nullable fields when each branch is otherwise valid.
 *
 * Output is re-validated by the engine's strict `WorkflowSchema` and
 * passed through `sanitizeAiWorkflow` in `apps/api/src/ai-runtime.ts` before
 * reaching the operator. Engine `NodeSchema.config` is `Record<string,
 * unknown>`, so retry and bounds fields pass through verbatim.
 *
 * Adding a constrained-mode node type means adding a branch to `AiNodeSchema`.
 * Adding a free-JSON-only generation type means adding it to
 * `AiNodeSchemaFreeJson` without widening the provider-sent constrained union.
 * If the type has rich resilience fields the AI should be allowed to set,
 * also add a per-type patch envelope plus a branch in `patchEnvelopeForNodeType`.
 * Otherwise the generic envelope picks it up automatically.
 */

import { EdgeSchema } from "@janusly/shared";
import { z } from "zod";

const AiCandidateSchema = z.object({
  nodeId: z.string().min(1),
});

const AiRetryConfig = z.object({
  maxAttempts: z.number().int().min(2).max(10),
});

// NOTE: the constrained-mode node shapes below are compiled into the
// provider-sent structured-output grammar, which sits near Anthropic's
// compiled-grammar size cap — adding fields here breaks `constrained`
// generation outright ("compiled grammar is too large"). Resilience fields
// like `retry` therefore live ONLY on the free-JSON variants further down,
// which are validated server-side and never reach a provider grammar.
const AiHttpConfigBase = z.object({
  url: z.string().min(1),
  method: z.string().optional(),
});

const AiHttpNode = z.object({
  id: z.string().min(1),
  type: z.literal("http"),
  config: AiHttpConfigBase,
});

const AiNoopNode = z.object({
  id: z.string().min(1),
  type: z.literal("noop"),
  config: z.object({}),
});

const AiTransformNode = z.object({
  id: z.string().min(1),
  type: z.literal("transform"),
  config: z.object({
    // Structured-output description is surfaced into the provider JSON
    // schema so the model fills the mapping instead of emitting `{}`.
    // The grammar can't express "min 1 key" on a record, so an empty
    // mapping still parses here — `sanitizeAiWorkflow` demotes any
    // empty-mapping transform to a `noop` placeholder rather than
    // discarding the whole draft.
    mapping: z
      .record(z.string(), z.string())
      .describe(
        "Non-empty map of output field name -> template string (at least one entry), e.g. { city: '{{context.fetch.output.city}}' }. Do not emit an empty object.",
      ),
  }),
});

const AiConditionNode = z.object({
  id: z.string().min(1),
  type: z.literal("condition"),
  config: z.object({
    expression: z.string().min(1),
  }),
});

const AiAiNode = z.object({
  id: z.string().min(1),
  type: z.literal("ai"),
  config: z.object({
    prompt: z.string().min(1),
  }),
});

const AiToolInputScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const AiToolInputValue = z.union([
  AiToolInputScalar,
  z.array(AiToolInputScalar),
  z.record(z.string(), AiToolInputScalar),
]);

const AiToolConfigBase = z.object({
  tool: z.string().min(1),
  // Optional `input` lets the LLM forward fields the operator gave
  // verbatim in the prompt (e.g. `to`, `subject` for email.send;
  // `channel`, `text` for slack.post; `url` for http.request). The
  // record is open because per-tool Zod schemas live in
  // `packages/engine/src/tool-registry.ts` — `validateToolInput`
  // enforces them at the strict consumption surfaces (`/start`,
  // `/save`, `/validate`, `/workflows/readiness`). The draft path
  // (`/ai/generate-workflow` → `sanitizeAiWorkflow` with
  // `strictToolInputs: false`) accepts partial input so operators
  // can finish in the Inspector. Without this field the LLM-emitted
  // input would be silently stripped at Zod parse time. Values stay
  // concrete rather than `z.unknown()` because Anthropic structured
  // output rejects empty schemas.
  input: z.record(z.string(), AiToolInputValue).optional(),
});

const AiToolNode = z.object({
  id: z.string().min(1),
  type: z.literal("tool"),
  config: AiToolConfigBase,
});

const AiAgentNode = z.object({
  id: z.string().min(1),
  type: z.literal("agent"),
  config: z.object({
    goal: z.string().min(1),
  }),
});

const AiRouterNode = z.object({
  id: z.string().min(1),
  type: z.literal("router"),
  config: z.object({
    candidates: z.array(AiCandidateSchema).min(1),
    strategy: z.enum(["cheapest", "fastest", "balanced", "auto"]).optional(),
  }),
});

const AiApprovalNode = z.object({
  id: z.string().min(1),
  type: z.literal("approval"),
  config: z.object({
    message: z.string().optional(),
  }),
});

const AiHumanFormFieldSchema = z.object({
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
});

const AiHumanFormNode = z.object({
  id: z.string().min(1),
  type: z.literal("human_form"),
  config: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    schema: z.object({
      type: z.literal("object"),
      properties: z.record(z.string(), AiHumanFormFieldSchema),
      required: z.array(z.string()).optional(),
    }),
  }),
});

const AiLoopNode = z.object({
  id: z.string().min(1),
  type: z.literal("loop"),
  config: z.object({
    items: z.string().min(1),
  }),
});

// Constrained AI generation emits 11 of the engine's node types. Anthropic's
// structured-output grammar compiler caps schema size — empirically the limit
// is identical across `claude-haiku-4-5`, `claude-sonnet-4-5`, and
// `claude-opus-4-7` (all three accept up to 11 branches with the full envelope
// below; 12+ rejects with "The compiled grammar is too large"). free-JSON is
// validated server-side, so `AiNodeSchemaFreeJson` below widens only that path
// with direct `parallel_fork` / `join`. Other operator-only types stay `noop`
// placeholders named after the requested step; Pass 2 auto-promotes the wired
// placeholder families (`wait_*`, `schedule_*`, and uniquely matched exposed
// MCP `mcp_*` ids), while the remaining types are promoted manually in the
// Inspector via the type `<select>`. The engine's strict `WorkflowSchema`
// (used by /save, /start, /validate) still accepts every runtime node type, so
// once a workflow leaves AI generation it has full expressiveness.
//
// CROSS-PROVIDER NOTE: this `discriminatedUnion` compiles to JSON Schema
// `oneOf`, which OpenAI strict mode rejects (`'oneOf' is not permitted`).
// Today Anthropic works (the only registered provider that accepts
// `oneOf` for structured output). OpenAI tenants on the generation
// route degrade to `mode: "fallback"`. Attempted relaxation to an open
// node shape regressed Anthropic (the model started skipping required
// fields when the schema didn't enforce them); reverted in favour of
// keeping Anthropic functional. A real cross-provider fix needs a
// heavier design — candidate paths include intent-dispatch (operator
// picks a flow style first, each style has a single non-union schema),
// two-pass generation (loose draft + per-type fill-in), or wrapping
// the AI SDK's strict-mode toggle so OpenAI accepts the union without
// enforcing.
const AiNodeSchema = z.discriminatedUnion("type", [
  AiNoopNode,
  AiHttpNode,
  AiTransformNode,
  AiConditionNode,
  AiAiNode,
  AiToolNode,
  AiAgentNode,
  AiRouterNode,
  AiApprovalNode,
  AiHumanFormNode,
  AiLoopNode,
]);

/**
 * Workflow envelope for legacy constrained `/ai/generate-workflow` mode. Slim
 * discriminated union, 11 branches, sent to the provider, where OpenAI strict
 * mode rejects the compiled `oneOf`. The default free-JSON path uses
 * `AiGenerationWorkflowSchemaFreeJson` below. See `AiNodeSchema` above for the
 * cross-provider note.
 */
export const AiGenerationWorkflowSchema = z.object({
  dslVersion: z.literal("1.0").optional(),
  id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  nodes: z.array(AiNodeSchema),
  edges: z.array(EdgeSchema),
});

// ---------------------------------------------------------------------------
// free-JSON extension: two STRUCTURAL fan-out/fan-in node types the model can
// express directly (it designs the branches itself, so it has all the info),
// plus the five event-driven trigger types (further down — credential /
// endpoint identifiers are operator-facing names the prompt teaches, and a
// malformed config demotes to the noop placeholder in `sanitizeAiWorkflow`).
// `subworkflow` / `mcp_tool` still need org-specific ids the model can't know
// and stay `noop` placeholders.
//
// Why a SEPARATE union instead of widening `AiNodeSchema`: the 11-branch cap
// is Anthropic's compiled-grammar limit, which only bites `constrained` mode
// (`generateObject` sends the schema to the provider; 12+ branches → "compiled
// grammar too large"). free-JSON validates the model's JSON text SERVER-SIDE,
// so it has no grammar limit and can use this wider union. Keeping the two
// unions separate lets `constrained` stay grammar-safe at 11 while free-JSON
// (the default) gains direct fork/join + triggers.
// ---------------------------------------------------------------------------

/** `parallel_fork` for free-JSON direct emission. `branches` mirrors the
 *  engine's `resolveParallelForkBranches` contract: 2..10 labeled branches
 *  (an optional human description each). A parse-valid fork is also
 *  `validateWorkflow`-valid, so it survives `sanitizeAiWorkflow` without the
 *  repair pass. */
const AI_FORK_JOIN_MIN_BRANCHES = 2;
const AI_FORK_JOIN_MAX_BRANCHES = 10;
const AI_FORK_JOIN_MAX_LABEL_LENGTH = 64;
const AI_FORK_JOIN_MAX_DESCRIPTION_LENGTH = 280;

const AiForkJoinLabelSchema = z
  .string()
  .refine((label) => label.trim().length > 0, { message: "branch label must be non-empty" })
  .max(AI_FORK_JOIN_MAX_LABEL_LENGTH);

const AiParallelForkBranchSchema = z.object({
  label: AiForkJoinLabelSchema,
  description: z.string().max(AI_FORK_JOIN_MAX_DESCRIPTION_LENGTH).optional(),
});

const AiParallelForkNode = z.object({
  id: z.string().min(1),
  type: z.literal("parallel_fork"),
  config: z.object({
    branches: z
      .array(AiParallelForkBranchSchema)
      .min(AI_FORK_JOIN_MIN_BRANCHES)
      .max(AI_FORK_JOIN_MAX_BRANCHES)
      .refine(
        (branches) => new Set(branches.map((branch) => branch.label)).size === branches.length,
        { message: "parallel_fork.config.branches must use unique labels" },
      ),
  }),
});

/** `join` for free-JSON direct emission. `sources` mirrors the engine's
 *  `resolveJoinSources` contract: a map of 2..10 branch labels → the id of the
 *  node that ends that branch. The labels MUST match the paired fork's branch
 *  labels and the values MUST be real upstream node ids (the engine + the
 *  readiness gate verify reachability downstream). */
const AiJoinNode = z.object({
  id: z.string().min(1),
  type: z.literal("join"),
  config: z.object({
    sources: z
      .record(
        AiForkJoinLabelSchema,
        z.string().refine((nodeId) => nodeId.trim().length > 0, {
          message: "join.config.sources values must be non-empty predecessor node ids",
        }),
      )
      .refine((s) => Object.keys(s).length >= 2 && Object.keys(s).length <= 10, {
        message: "join.config.sources must map 2..10 branch labels to predecessor node ids",
      })
      .refine((s) => new Set(Object.values(s)).size === Object.values(s).length, {
        message: "join.config.sources must not reference the same predecessor node id more than once",
      }),
  }),
});

// Free-JSON-only http/tool variants: same shapes as the constrained ones plus
// the `retry` resilience field the generation prompt teaches for recoverable
// workflows. Server-side validation only — keeping `retry` out of the
// constrained variants keeps the provider-sent grammar under Anthropic's
// compiled-size cap (adding it there breaks `constrained` mode outright).
// `.catch(undefined)` keeps the draft path tolerant: a malformed retry (e.g.
// `maxAttempts: 1`, a string, null) is DROPPED rather than failing the whole
// workflow parse — the operator then gets the standard readiness warning for
// a missing retry instead of a dead generation.
const AiRetryConfigDraft = AiRetryConfig.optional().catch(undefined);

// Free-JSON tool inputs allow ONE extra nesting level beyond the constrained
// scalars: arrays of flat objects and objects of flat objects, so real tool inputs
// like `workingHours: [{ days: [1,2,3,4,5], start: "09:00", end: "17:00" }]`
// are representable. Depth stays bounded (no recursion) and per-tool Zod
// schemas in `tool-registry.ts` remain the authoritative contract at the
// strict consumption surfaces. Constrained mode keeps the scalar-only base —
// this union is validated server-side, never sent to a provider grammar.
const AiToolInputFlatValue = z.union([AiToolInputScalar, z.array(AiToolInputScalar)]);
const AiToolInputFlatObject = z.record(z.string(), AiToolInputFlatValue);
const AiToolInputValueFreeJson = z.union([
  AiToolInputScalar,
  z.array(z.union([AiToolInputScalar, AiToolInputFlatObject])),
  z.record(z.string(), z.union([AiToolInputFlatValue, AiToolInputFlatObject])),
]);

// Free-JSON HTTP drafts can preserve the request material the operator
// supplied. These fields stay out of the constrained provider grammar, but
// they are safe to validate server-side with the same bounded JSON depth used
// for tool inputs.
const AiHttpNodeFreeJson = AiHttpNode.extend({
  config: AiHttpConfigBase.extend({
    headers: z.record(z.string(), z.string()).optional(),
    body: AiToolInputValueFreeJson.optional(),
    retry: AiRetryConfigDraft,
  }),
});

const AiToolConfigBaseFreeJson = AiToolConfigBase.extend({
  input: z.record(z.string(), AiToolInputValueFreeJson).optional(),
});

const AiToolNodeFreeJson = AiToolNode.extend({
  config: AiToolConfigBaseFreeJson.extend({ retry: AiRetryConfigDraft }),
});

// ---------------------------------------------------------------------------
// Free-JSON-only trigger emission: the five event-driven trigger types
// are directly emittable so a prompt like "when a pager fires…" yields a real
// trigger root instead of an operator-promoted noop. Draft posture: every
// config field is optional AND `.catch(undefined)`-tolerant so a partially
// filled trigger never fails the whole workflow parse; `sanitizeAiWorkflow`
// then demotes any config that fails the authoritative
// `TRIGGER_CONFIG_SCHEMAS` parse to the existing noop placeholder (the
// operator completes it in the Inspector). Constrained mode keeps the
// TRIGGER-INTENT NAMING noop path — these branches are server-side only.
// ---------------------------------------------------------------------------
const aiDraftString = z.string().optional().catch(undefined);
const aiDraftBoolean = z.boolean().optional().catch(undefined);
const aiDraftStringArray = z.array(z.string()).optional().catch(undefined);
const aiDraftRateLimit = z.number().int().min(1).optional().catch(undefined);

const AiWebhookReceivedNode = z.object({
  id: z.string().min(1),
  type: z.literal("webhook_received"),
  config: z.object({
    endpointKey: aiDraftString,
    rateLimitPerMin: aiDraftRateLimit,
  }),
});

const AiEmailReceivedNode = z.object({
  id: z.string().min(1),
  type: z.literal("email_received"),
  config: z.object({
    aliasKey: aiDraftString,
    dkimRequired: aiDraftBoolean,
    fromDomains: aiDraftStringArray,
    rateLimitPerMin: aiDraftRateLimit,
  }),
});

const AiFileDroppedNode = z.object({
  id: z.string().min(1),
  type: z.literal("file_dropped"),
  config: z.object({
    bucket: aiDraftString,
    prefix: aiDraftString,
    extensions: aiDraftStringArray,
    rateLimitPerMin: aiDraftRateLimit,
  }),
});

const AiMcpServerEventNode = z.object({
  id: z.string().min(1),
  type: z.literal("mcp_server_event"),
  config: z.object({
    connectionAlias: aiDraftString,
    resourceUri: aiDraftString,
    eventTypes: aiDraftStringArray,
    rateLimitPerMin: aiDraftRateLimit,
  }),
});

const AiPagerDutyIncidentNode = z.object({
  id: z.string().min(1),
  type: z.literal("pagerduty_incident"),
  config: z.object({
    webhookCredential: aiDraftString,
    rateLimitPerMin: aiDraftRateLimit,
  }),
});

/** 18-branch node union for free-JSON validation: the 11 constrained shapes
 *  (http/tool widened with `retry`; tool inputs one level deeper), the
 *  structural `parallel_fork` + `join` pair, and the five event-driven
 *  trigger types. NOT sent to any provider — used only by
 *  `parseGeneratedWorkflow` server-side. */
export const AiNodeSchemaFreeJson = z.discriminatedUnion("type", [
  AiNoopNode,
  AiHttpNodeFreeJson,
  AiTransformNode,
  AiConditionNode,
  AiAiNode,
  AiToolNodeFreeJson,
  AiAgentNode,
  AiRouterNode,
  AiApprovalNode,
  AiHumanFormNode,
  AiLoopNode,
  AiParallelForkNode,
  AiJoinNode,
  AiWebhookReceivedNode,
  AiEmailReceivedNode,
  AiFileDroppedNode,
  AiMcpServerEventNode,
  AiPagerDutyIncidentNode,
]);

/**
 * Declared workflow settings the model may emit, deliberately narrower than
 * the engine's recursive `WorkflowInputSchema`: a FLAT object of primitive
 * fields, each allowed a `default`.
 *
 * That is the shape an operator means by "make it configurable" — one named
 * value, stated once, read by nodes through `{{context.input.<name>}}`. The
 * `default` is what keeps such a workflow startable from a trigger, whose
 * payload carries the event rather than the declared fields. Keeping nesting
 * out means a generated draft can't invent a schema tree the operator then has
 * to untangle; the engine still accepts the full grammar for hand-authored
 * workflows.
 */
const AiWorkflowInputFieldSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("string"),
    description: z.string().optional(),
    default: z.string().optional(),
  }),
  z.object({
    type: z.literal("number"),
    description: z.string().optional(),
    default: z.number().finite().optional(),
  }),
  z.object({
    type: z.literal("boolean"),
    description: z.string().optional(),
    default: z.boolean().optional(),
  }),
]);

const AiWorkflowInputsSchema = z.object({
  type: z.literal("object"),
  properties: z.record(z.string(), AiWorkflowInputFieldSchema),
  required: z.array(z.string()).optional(),
});

/** Workflow envelope used by the default free-JSON generation path. Same
 *  envelope as `AiGenerationWorkflowSchema` but with the wider node union
 *  (`constrained` mode keeps the 11-branch `AiGenerationWorkflowSchema`
 *  for the Anthropic grammar cap) plus declared settings. */
export const AiGenerationWorkflowSchemaFreeJson = z.object({
  dslVersion: z.literal("1.0").optional(),
  id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  inputs: AiWorkflowInputsSchema.optional(),
  nodes: z.array(AiNodeSchemaFreeJson),
  edges: z.array(EdgeSchema),
});

/**
 * Patch-route schemas — `/ai/patch-workflow`. Each LLM call uses ONE
 * concrete envelope picked by the failing-node's type. The envelope wraps
 * an array of 1-3 suggestions, each with the per-type config patch plus
 * `approachLabel` + `confidence` metadata so the recovery dialog can show
 * tabs and let the operator pick between alternative fixes. The LLM emits
 * only the patched config for the failing node, NOT a full workflow.
 * The route fan-out-merges each suggestion's `patchedConfig` onto the
 * original snapshot, validates each, returns the surviving ones sorted
 * by confidence desc. Legacy `suggestedWorkflow`/`rationale` fields on
 * the response mirror `suggestions[0]` so older callers keep working.
 *
 * Why per-type envelopes instead of a single full-workflow schema:
 *
 *   - **Anthropic** caps compiled grammar size. A multi-branch
 *     `discriminatedUnion` with resilience optionals on http/tool/agent
 *     trips "The compiled grammar is too large".
 *   - **OpenAI strict mode** rejects root-level composition generated by
 *     `discriminatedUnion` (for example `oneOf`) and does not support
 *     `not`. Leaf `anyOf` is allowed for nullable fields when each branch
 *     is otherwise valid.
 *
 * A single non-union envelope per call sidesteps both: no `oneOf`
 * keyword in the compiled JSON Schema, and the per-type schema has only
 * 3-5 leaf fields so Anthropic's cap is comfortable. The 1-3 array form
 * adds one repeated `items: <single shape>` constraint, not three branches —
 * the compiled grammar stays compact.
 *
 * The four envelopes:
 *
 *   - `AiPatchHttpConfigEnvelope` — `url` / `method` / `headers` /
 *     `retry` / `timeoutMs` / `maxResponseBytes` / `maxRedirects` (all
 *     required nullable fields; the LLM sends `null` for fields it
 *     doesn't want to change). Covers URL fixes, method swaps, header
 *     swaps (including literal-token → `{{secret.NAME}}` substitutions),
 *     retry adds, timeout raises, body-cap raises. The `headers` field
 *     uses an `Array<{ name, value }>` patch form so the merge layer
 *     can fold individual header changes against the existing config
 *     without replacing the whole object — provider-safe shape that
 *     avoids `propertyNames` (OpenAI strict-mode reject).
 *   - `AiPatchToolConfigEnvelope` — `tool` / `input` / `retry` /
 *     `timeoutMs`. The `input` field uses the same `Array<{ name,
 *     value }>` patch form for the tool's flat string-keyed input map.
 *   - `AiPatchAgentConfigEnvelope` — `goal` / `retry` / `timeoutMs`.
 *   - `AiPatchGenericConfigEnvelope` — `patchedConfig: Record<string,
 *     unknown>` for fallback node types such as multi_agent, human_form,
 *     and noop. This keeps local Zod parsing
 *     flexible, but provider strict-mode compatibility for those node types
 *     should move to concrete envelopes.
 *
 * `patchEnvelopeForNodeType(nodeType)` is the dispatch helper. The route
 * passes its result to `suggestWorkflowPatch` as the `envelopeSchema`.
 *
 * Per-suggestion metadata:
 *   - `approachLabel` — closed enum (`add_retry` / `raise_timeout` /
 *     `swap_secret_ref` / `add_approval` / `fix_url` / `other`). The
 *     dialog renders a chip per tab.
 *   - `confidence` — integer 0-100, raw LLM self-rating. Calibration
 *     against past acceptance rates lands later.
 *
 * Retry shape: `{ maxAttempts: number }` only, with `min(2)` because
 * runtime `maxAttempts: 1` means "do not retry" and the operator already
 * had at least one attempt. The engine accepts a partial `RetryPolicy`
 * and applies its own defaults for delay/backoff/jitter.
 */
// OpenAI strict-mode constraint: every property in an object schema MUST
// appear in `required`. Optional fields aren't allowed; instead each leaf
// is `.nullable()` so the LLM ALWAYS emits the field — sending `null`
// when it doesn't want to change. The route's merge step filters null
// values before applying the patch so they don't overwrite existing
// config. Anthropic accepts the same nullable-field shape, so this
// pattern unblocks both providers without per-provider code paths.
const AiPatchRetryConfig = AiRetryConfig;

/**
 * Bounded array-of-pairs patch form for fields that are normally a flat
 * record (`headers` on http nodes, `input` on tool nodes). The LLM emits
 * only the keys it wants to change. The merge layer in
 * `apps/api/src/patch-workflow-merge.ts` folds these against the
 * existing record before shallow-merging the rest of the patched config:
 * non-null `value` sets/replaces; `null` removes the key from the merged
 * record; missing keys in the array preserve whatever's already in the
 * existing config.
 *
 * Shape choice driven by provider strict modes: a `Record<string, ...>`
 * compiles to `propertyNames` which OpenAI strict mode rejects outright.
 * `Array<{ name, value }>` is one repeated `items` shape — Anthropic's
 * compiled grammar treats it as a single rule rather than N branches.
 */
const AiPatchHttpHeader = z.object({
  name: z.string().min(1),
  value: z.string().nullable(),
});

const AiPatchToolInputItem = z.object({
  name: z.string().min(1),
  value: z.string().nullable(),
});

/** Hard bound on bounded-array fields. Keeps the compiled grammar small and the merge predictable. */
const PATCH_HEADERS_MAX = 20;
const PATCH_TOOL_INPUT_MAX = 30;

const AiPatchHttpConfig = z.object({
  url: z.string().min(1).nullable(),
  method: z.string().nullable(),
  headers: z.array(AiPatchHttpHeader).max(PATCH_HEADERS_MAX).nullable(),
  retry: AiPatchRetryConfig.nullable(),
  timeoutMs: z.number().int().min(1).nullable(),
  maxResponseBytes: z.number().int().min(1).nullable(),
  maxRedirects: z.number().int().min(0).nullable(),
});

const AiPatchToolConfig = z.object({
  tool: z.string().min(1).nullable(),
  input: z.array(AiPatchToolInputItem).max(PATCH_TOOL_INPUT_MAX).nullable(),
  retry: AiPatchRetryConfig.nullable(),
  timeoutMs: z.number().int().min(1).nullable(),
});

const AiPatchAgentConfig = z.object({
  goal: z.string().min(1).nullable(),
  retry: AiPatchRetryConfig.nullable(),
  timeoutMs: z.number().int().min(1).nullable(),
});

/**
 * Concrete `patchedConfig` shapes for the non-resilience node types
 * (transform / condition / ai / router / approval / loop). Each is a
 * single non-union object with nullable-required leaf fields — same
 * provider-strict pattern as the http / tool / agent envelopes. Two
 * types intentionally fall through to the generic envelope below:
 *
 *   - `multi_agent` — the `agents` array carries structurally-complex
 *     items (`name` / `role` / `goal` / optional `persona`). Encoding
 *     it provider-strict would bloat Anthropic's compiled grammar
 *     without product value: operators rarely re-shape the crew
 *     mid-recovery; they iterate on the workflow-level `goal`.
 *   - `noop` — has no actionable runtime config; an empty patch always
 *     trips the no-op guard in `patch-workflow-merge.ts`. The
 *     fall-through to the generic envelope produces the same
 *     "always falls back" behaviour without a dedicated schema.
 */
const AiPatchTransformConfig = z.object({
  // Mapping uses the same `Array<{ name, value }>` patch form as
  // `headers` / `tool input` so the LLM emits only the keys it wants
  // changed; the merge layer folds against the existing flat record.
  // Reuses `AiPatchHttpHeader` because the shape is identical today
  // (`{ name: string.min(1), value: string.nullable() }`). If HTTP
  // headers ever grow extra constraints (e.g. a lowercase-only rule),
  // factor a shared `AiPatchKeyValueItem` instead so transform doesn't
  // silently inherit them.
  mapping: z.array(AiPatchHttpHeader).max(50).nullable(),
});

const AiPatchConditionConfig = z.object({
  // The engine's `validateExpression` runs server-side after the merge
  // (in `sanitizeAiWorkflow`). The envelope only enforces non-empty
  // string; grammar-invalid expressions are dropped per-suggestion at
  // the post-validation chain.
  expression: z.string().min(1).nullable(),
});

const AiPatchAiConfig = z.object({
  prompt: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  retry: AiPatchRetryConfig.nullable(),
});

const AiPatchRouterCandidate = z.object({
  nodeId: z.string().min(1),
});

const AiPatchRouterConfig = z.object({
  // Replace the full candidates list verbatim (no fold). Each entry
  // must reference an existing node by id; `validateWorkflow` runs
  // server-side after the merge to enforce that.
  candidates: z.array(AiPatchRouterCandidate).max(10).nullable(),
  strategy: z.enum(["cheapest", "fastest", "balanced", "auto"]).nullable(),
});

const AiPatchApprovalConfig = z.object({
  message: z.string().min(1).nullable(),
});

const AiPatchLoopConfig = z.object({
  // Items takes a comma-separated template string OR a string array
  // at the engine boundary; the patch envelope only exposes the
  // string form (most common operator fix). If the existing config
  // uses the array form the merge replaces with a string — the
  // sanitize step keeps the workflow valid because both shapes pass
  // the engine's loop-items validation.
  items: z.string().min(1).nullable(),
  // Same reuse note as transform.mapping above — `AiPatchToolInputItem`
  // is structurally identical to `AiPatchHttpHeader` today; if either
  // source diverges, factor a shared `AiPatchKeyValueItem`.
  mapping: z.array(AiPatchToolInputItem).max(30).nullable(),
});

const AiPatchGenericConfig = z.record(z.string(), z.unknown());

/**
 * Closed set of approach labels the model picks for each suggestion.
 * Used for the tab chip in the recovery dialog and for downstream
 * calibration once the feedback table lands.
 */
export const AiPatchApproachLabel = z.enum([
  "add_retry",
  "raise_timeout",
  "swap_secret_ref",
  "add_approval",
  "fix_url",
  "other",
]);
export type AiPatchApproachLabelValue = z.infer<typeof AiPatchApproachLabel>;

/** Hard upper bound on suggestions per call. Mirrors the Zod `.max(3)`. */
export const PATCH_MAX_SUGGESTIONS = 3;

const AiPatchConsideredAlternative = z.object({
  approach: z.string().min(1).max(120),
  rejectedBecause: z.string().min(1).max(280),
});

function suggestionItemSchema<T extends z.ZodTypeAny>(configSchema: T) {
  return z.object({
    patchedConfig: configSchema,
    rationale: z.string().min(1),
    approachLabel: AiPatchApproachLabel,
    // Self-rated confidence 0-100. Pre-calibration MVP: the value is the
    // LLM's own number; the dialog labels it as a self-rating so operators
    // don't over-trust raw scores. Future calibration pass will rebase
    // these against past acceptance rates per `approachLabel`.
    confidence: z.number().int().min(0).max(100),
    consideredAlternatives: z.array(AiPatchConsideredAlternative).max(2).default([]),
  });
}

function suggestionsArraySchema<T extends z.ZodTypeAny>(configSchema: T) {
  // The `items: <single shape>` constraint is the same for every position
  // in the array — Anthropic's compiled grammar treats this as one shape,
  // not N branches, so the `.max(3)` doesn't blow the size cap.
  return z.array(suggestionItemSchema(configSchema)).min(1).max(PATCH_MAX_SUGGESTIONS);
}

/** Envelope for http-typed failing nodes. Wraps 1-3 typed http suggestions. */
export const AiPatchHttpConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchHttpConfig),
});

/** Envelope for tool-typed failing nodes. */
export const AiPatchToolConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchToolConfig),
});

/** Envelope for agent-typed failing nodes. */
export const AiPatchAgentConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchAgentConfig),
});

/** Envelope for transform-typed failing nodes — `mapping` array-of-pairs. */
export const AiPatchTransformConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchTransformConfig),
});

/** Envelope for condition-typed failing nodes — single `expression` field. */
export const AiPatchConditionConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchConditionConfig),
});

/** Envelope for ai-typed failing nodes — prompt swap, model swap, retry add. */
export const AiPatchAiConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchAiConfig),
});

/** Envelope for router-typed failing nodes — replace candidates list, swap strategy. */
export const AiPatchRouterConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchRouterConfig),
});

/** Envelope for approval-typed failing nodes — message text fixes. */
export const AiPatchApprovalConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchApprovalConfig),
});

/** Envelope for loop-typed failing nodes — items expression + mapping array-of-pairs. */
export const AiPatchLoopConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchLoopConfig),
});

/**
 * Envelope for every other node type (multi_agent, human_form, noop, and any
 * unrecognised future types). The patched config is an open record —
 * the system prompt narrates valid fields per type, and the route's
 * post-validation chain catches structurally-invalid output.
 */
export const AiPatchGenericConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchGenericConfig),
});

/**
 * Structural patch envelope — emits node-graph changes instead of a
 * single-node config patch. Single non-union object shape (no `oneOf`,
 * no `propertyNames`, no open `additionalProperties`) so both Anthropic
 * compiled-grammar and OpenAI strict mode accept it. The `action`
 * literal is the extensibility hook: today only `insert_approval_upstream`
 * is wired; future structural fixes (split_for_retry, insert_error_handler)
 * add a new literal value and a new applier case without changing this
 * envelope's outer shape.
 */
const AiPatchStructuralSuggestionItem = z.object({
  action: z.literal("insert_approval_upstream"),
  // New approval node id. Operator-friendly snake_case names like
  // `approve_charge` or `approve_send` are encouraged by the system
  // prompt. The applier rejects collisions with existing node ids.
  approvalNodeId: z.string().min(1),
  // Plain operator-facing message rendered in the approval dialog.
  // Can reference upstream context via templates (`{{context.fetch.output.amount}}`)
  // — the engine resolves templates at run time; the message is not
  // executed code.
  approvalMessage: z.string().min(1),
  // Existing node id the approval gets inserted in front of. The
  // applier rewrites every edge `to === insertBeforeNodeId` to point
  // at the new approval and adds one outgoing edge from the approval
  // to the existing target.
  insertBeforeNodeId: z.string().min(1),
  rationale: z.string().min(1),
  approachLabel: z.literal("add_approval"),
  confidence: z.number().int().min(0).max(100),
  consideredAlternatives: z.array(AiPatchConsideredAlternative).max(2).default([]),
});

export const AiPatchStructuralEnvelope = z.object({
  suggestions: z.array(AiPatchStructuralSuggestionItem).min(1).max(PATCH_MAX_SUGGESTIONS),
});

export type AiPatchStructuralSuggestion = z.infer<typeof AiPatchStructuralSuggestionItem>;

/** Discriminator returned alongside the schema so callers can branch on the parsed shape. */
export type PatchEnvelopeKind =
  | "http"
  | "tool"
  | "agent"
  | "transform"
  | "condition"
  | "ai"
  | "router"
  | "approval"
  | "loop"
  | "generic"
  | "structural";

export type PatchEnvelopeChoice = {
  schema:
    | typeof AiPatchHttpConfigEnvelope
    | typeof AiPatchToolConfigEnvelope
    | typeof AiPatchAgentConfigEnvelope
    | typeof AiPatchTransformConfigEnvelope
    | typeof AiPatchConditionConfigEnvelope
    | typeof AiPatchAiConfigEnvelope
    | typeof AiPatchRouterConfigEnvelope
    | typeof AiPatchApprovalConfigEnvelope
    | typeof AiPatchLoopConfigEnvelope
    | typeof AiPatchGenericConfigEnvelope
    | typeof AiPatchStructuralEnvelope;
  kind: PatchEnvelopeKind;
};

/**
 * Pick the patch envelope for a failing-node type. Node types with compact,
 * stable config patches route to concrete envelopes; structurally broad
 * types (`multi_agent`, `human_form`, `noop`) plus any unrecognised future
 * types fall through to the open generic envelope.
 */
export function patchEnvelopeForNodeType(nodeType: string): PatchEnvelopeChoice {
  switch (nodeType) {
    case "http":
      return { schema: AiPatchHttpConfigEnvelope, kind: "http" };
    case "tool":
      return { schema: AiPatchToolConfigEnvelope, kind: "tool" };
    case "agent":
      return { schema: AiPatchAgentConfigEnvelope, kind: "agent" };
    case "transform":
      return { schema: AiPatchTransformConfigEnvelope, kind: "transform" };
    case "condition":
      return { schema: AiPatchConditionConfigEnvelope, kind: "condition" };
    case "ai":
      return { schema: AiPatchAiConfigEnvelope, kind: "ai" };
    case "router":
    case "router_llm":
      return { schema: AiPatchRouterConfigEnvelope, kind: "router" };
    case "approval":
      return { schema: AiPatchApprovalConfigEnvelope, kind: "approval" };
    case "loop":
      return { schema: AiPatchLoopConfigEnvelope, kind: "loop" };
    default:
      return { schema: AiPatchGenericConfigEnvelope, kind: "generic" };
  }
}

/**
 * Suggest-improvement schemas — `/ai/suggest-improvement`. The route
 * mirrors `/ai/patch-workflow`'s response shape (a `suggestions` array
 * of items with rationale + approachLabel + confidence) but operates
 * in authoring context (no failing-node id, no DLQ row).
 *
 * Shape choice — JSON-encoded workflow string vs typed inner schema:
 *
 *   Both `/ai/generate-workflow` and the failed exploratory shape
 *   here started by emitting `AiGenerationWorkflowSchema` directly as
 *   the structured output. Anthropic accepts the bare 11-branch
 *   schema (proven by the generation route running in production),
 *   but wrapping it in an outer object plus a `suggestions` array
 *   plus metadata fields (`rationale`, `approachLabel`, `confidence`)
 *   pushes the compiled grammar over the cap (`"The compiled grammar
 *   is too large…"`). The patch route sidesteps this by emitting
 *   tiny config-only patches (3-7 leaf fields) — but the suggest
 *   surface needs the full workflow because improvements span
 *   multiple nodes/edges.
 *
 *   The minimal grammar that fits: `patchedWorkflowJson: z.string()`.
 *   The LLM emits the proposed workflow as a JSON-stringified blob.
 *   The route runs `JSON.parse` then `WorkflowSchema.safeParse` +
 *   `sanitizeAiWorkflow` server-side. Validation moves from
 *   structured-output-time to server-time, but the safety guarantee
 *   is identical — every suggestion still passes the engine's strict
 *   schema before reaching the operator. Suggestions whose JSON or
 *   schema parse fails are dropped by the route, and the surface
 *   degrades to fallback when none survive.
 *
 * Cross-provider note: this string-payload shape works on both
 * Anthropic (no `oneOf`, no nested unions, fits the cap comfortably)
 * AND OpenAI strict mode (every property `required`, no
 * `propertyNames`, no composition). When OpenAI re-opens as a
 * supported runtime target this surface should work without changes.
 * Per AGENTS.md the supported posture is Anthropic-only until
 * further notice.
 */
export const AiSuggestApproachLabel = z.enum([
  "add_retry",
  "raise_timeout",
  "swap_secret_ref",
  "add_approval",
  "add_observability",
  "simplify",
  "other",
]);
export type AiSuggestApproachLabelValue = z.infer<typeof AiSuggestApproachLabel>;

/**
 * Hard upper bound on improvement suggestions per call. Mirrors the
 * patch-route posture: 1-3 distinct alternatives, using one repeated
 * `items` schema so Anthropic's compiled grammar stays compact.
 */
export const SUGGEST_MAX_SUGGESTIONS = 3;

const AiSuggestImprovementItem = z.object({
  // JSON-stringified workflow — see envelope docstring for the
  // grammar-cap rationale. The route runs `JSON.parse` then
  // `WorkflowSchema.safeParse` + `sanitizeAiWorkflow` before
  // returning to the operator; suggestions whose parse or schema
  // fails are dropped, and the surface degrades to fallback when
  // none survive.
  patchedWorkflowJson: z.string().min(1).max(20000),
  rationale: z.string().min(1).max(800),
  approachLabel: AiSuggestApproachLabel,
  // Self-rated confidence 0-100. Same posture as the patch route: the
  // dialog labels it as a self-rating so operators don't over-trust raw
  // scores. Future calibration pass will rebase against accept/reject
  // history if a feedback loop for this surface lands.
  confidence: z.number().int().min(0).max(100),
});

/**
 * Envelope for `/ai/suggest-improvement`. Wraps 1-3
 * improvement-suggestion items — JSON-encoded workflow + rationale +
 * approachLabel + confidence. The route post-processes each item:
 * `JSON.parse` → `WorkflowSchema.safeParse` → `sanitizeAiWorkflow`,
 * dropping the suggestion if any step fails and degrading to
 * fallback when none survive.
 */
export const AiSuggestImprovementEnvelope = z.object({
  suggestions: z.array(AiSuggestImprovementItem).min(1).max(SUGGEST_MAX_SUGGESTIONS),
});

/** Single review-finding for `/ai/review-workflow` structured output. */
const ReviewFindingSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(["info", "warn", "fail"]),
  message: z.string().min(1),
  nodeId: z.string().optional(),
  edgeId: z.string().optional(),
  rationale: z.string().min(1),
  suggestion: z.string().min(1),
});

/**
 * Envelope for `/ai/review-workflow` structured output. Each finding is
 * a concrete-typed object — no `z.unknown()` (Anthropic's
 * structured-output surface rejects empty `{}` schemas), no recursion
 * (Anthropic + AI SDK reject self-`$ref`), and a hard `max(50)` cap on
 * the issue array so a hallucinating model can't dump a wall of text.
 * The shape matches `ReviewFindings` from
 * `@janusly/engine/src/workflow-review-fallback`, so the AI-mode and
 * fallback responses are wire-compatible.
 */
export const ReviewFindingsSchema = z.object({
  status: z.enum(["pass", "warn", "fail"]),
  issues: z.array(ReviewFindingSchema).max(50),
});
