/**
 * Pure structural diff between two workflow definitions. Used by the web
 * surface when an operator wants to see what changed between two saved
 * versions, or between a saved version and a proposed AI patch — added
 * nodes, removed edges, config tweaks, retry / timeout / secret-ref /
 * approval additions.
 *
 * Lives in `@janusly/shared` (zero runtime deps, no DB) so the web bundle
 * can import it without pulling the full `@janusly/engine` graph. The
 * persistence chokepoint (`packages/engine/src/safe-persist.ts`)
 * re-exports the same `SENSITIVE_KEY_PATTERN` from here so the diff's
 * secret-ref classifier and the runtime redactor stay in lockstep —
 * adding a new key shape in `sensitive-keys.ts` improves both surfaces
 * automatically.
 *
 * Tag classifier (drives the UI's severity treatment):
 *   - `secret_ref` — field path's last segment matches the sensitive-key
 *     regex, OR the value uses a supported `{{secret.X}}` / `{{env.X}}`
 *     template.
 *   - `retry` / `timeout` / `bounds` — config knobs governing an
 *     external call's resilience.
 *   - `approval` — a node of type `approval` was added or removed.
 *   - `rationale` — workflow-level metadata field that affects
 *     readability (`name`, `metadata.*`). Identity, template policy, and
 *     Recovery policy changes are also retained even when they have no
 *     presentation tag.
 *
 * Pure — no I/O, no network, no DB access. Easy to unit-test.
 */

import { SENSITIVE_KEY_PATTERN } from "./sensitive-keys";

/** Minimum shape the diff cares about — both engine + web types satisfy structurally. */
export type DiffableNode = {
  id: string;
  type: string;
  label?: string;
  config?: unknown;
};

export type DiffableEdge = {
  id?: string;
  from: string;
  to: string;
  condition?: string;
};

export type DiffableWorkflow = {
  id?: string;
  dslVersion?: string;
  name?: string;
  metadata?: unknown;
  inputs?: unknown;
  outputs?: unknown;
  templatePolicy?: unknown;
  recovery?: unknown;
  nodes?: DiffableNode[];
  edges?: DiffableEdge[];
};

/** Closed taxonomy of severity tags surfaced on field changes. */
export type ChangeTag =
  | "secret_ref"
  | "retry"
  | "timeout"
  | "approval"
  | "bounds"
  | "rationale";

/** A single field change inside a workflow / node / edge object. */
export type FieldChange = {
  /** Dotted path inside the workflow / node / edge: `name`, `metadata.description`, `config.retry.maxAttempts`, `condition`. */
  path: string;
  before: unknown;
  after: unknown;
  /** Tag for severity treatment in the UI. `null` when no rule matched. */
  tag: ChangeTag | null;
};

/** One node-level diff entry. */
export type NodeChange =
  | { kind: "added"; node: DiffableNode; tag: ChangeTag | null }
  | { kind: "removed"; node: DiffableNode; tag: ChangeTag | null }
  | {
      kind: "changed";
      nodeId: string;
      nodeType: string;
      before: DiffableNode;
      after: DiffableNode;
      fields: FieldChange[];
    };

/** One edge-level diff entry. */
export type EdgeChange =
  | { kind: "added"; edgeKey: string; edge: DiffableEdge }
  | { kind: "removed"; edgeKey: string; edge: DiffableEdge }
  | {
      kind: "changed";
      edgeKey: string;
      before: DiffableEdge;
      after: DiffableEdge;
      fields: FieldChange[];
    };

/** Workflow-level summary aggregates surfaced to the UI's header line. */
export type DiffSummary = {
  nodesAdded: number;
  nodesRemoved: number;
  nodesChanged: number;
  edgesAdded: number;
  edgesRemoved: number;
  edgesChanged: number;
  totalChanges: number;
};

/** Full structural diff between two workflows. */
export type WorkflowDiff = {
  /** Top-level workflow fields (`name`, `metadata.*`, `inputs`, `outputs`, `templatePolicy`, `dslVersion`). */
  workflow: FieldChange[];
  nodes: NodeChange[];
  edges: EdgeChange[];
  summary: DiffSummary;
};

/** Compute a structural diff between two workflow snapshots. */
export function computeWorkflowDiff(before: DiffableWorkflow, after: DiffableWorkflow): WorkflowDiff {
  const workflowFields = diffWorkflowLevel(before, after);
  const nodes = diffNodes(before.nodes ?? [], after.nodes ?? []);
  const edges = diffEdges(before.edges ?? [], after.edges ?? []);

  const summary: DiffSummary = {
    nodesAdded: nodes.filter((n) => n.kind === "added").length,
    nodesRemoved: nodes.filter((n) => n.kind === "removed").length,
    nodesChanged: nodes.filter((n) => n.kind === "changed").length,
    edgesAdded: edges.filter((e) => e.kind === "added").length,
    edgesRemoved: edges.filter((e) => e.kind === "removed").length,
    edgesChanged: edges.filter((e) => e.kind === "changed").length,
    totalChanges: 0,
  };
  summary.totalChanges =
    workflowFields.length +
    summary.nodesAdded +
    summary.nodesRemoved +
    summary.nodesChanged +
    summary.edgesAdded +
    summary.edgesRemoved +
    summary.edgesChanged;

  return { workflow: workflowFields, nodes, edges, summary };
}

/* ----------------------------- Workflow-level ----------------------------- */

const WORKFLOW_LEVEL_FIELDS = [
  "id",
  "dslVersion",
  "name",
  "metadata",
  "inputs",
  "outputs",
  "templatePolicy",
  "recovery",
] as const;

function diffWorkflowLevel(before: DiffableWorkflow, after: DiffableWorkflow): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of WORKFLOW_LEVEL_FIELDS) {
    const before_ = (before as Record<string, unknown>)[field];
    const after_ = (after as Record<string, unknown>)[field];
    walkValue(field, before_, after_, changes);
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}

/* ----------------------------- Node + edge diff ---------------------------- */

function diffNodes(before: DiffableNode[], after: DiffableNode[]): NodeChange[] {
  const beforeMap = new Map<string, DiffableNode>();
  const afterMap = new Map<string, DiffableNode>();
  for (const node of before) beforeMap.set(node.id, node);
  for (const node of after) afterMap.set(node.id, node);

  const changes: NodeChange[] = [];

  // Added.
  for (const [id, node] of afterMap) {
    if (!beforeMap.has(id)) {
      changes.push({
        kind: "added",
        node,
        tag: node.type === "approval" ? "approval" : null,
      });
    }
  }
  // Removed.
  for (const [id, node] of beforeMap) {
    if (!afterMap.has(id)) {
      changes.push({
        kind: "removed",
        node,
        tag: node.type === "approval" ? "approval" : null,
      });
    }
  }
  // Changed.
  for (const [id, beforeNode] of beforeMap) {
    const afterNode = afterMap.get(id);
    if (!afterNode) continue;
    const fields: FieldChange[] = [];
    walkValue("type", beforeNode.type, afterNode.type, fields);
    walkValue("label", beforeNode.label, afterNode.label, fields);
    walkValue("config", beforeNode.config, afterNode.config, fields);
    if (fields.length > 0) {
      fields.sort((a, b) => a.path.localeCompare(b.path));
      changes.push({
        kind: "changed",
        nodeId: id,
        nodeType: afterNode.type,
        before: beforeNode,
        after: afterNode,
        fields,
      });
    }
  }

  changes.sort(compareNodeChange);
  return changes;
}

function diffEdges(before: DiffableEdge[], after: DiffableEdge[]): EdgeChange[] {
  const beforeMap = new Map<string, DiffableEdge>();
  const afterMap = new Map<string, DiffableEdge>();
  for (const edge of before) beforeMap.set(edgeKeyFor(edge), edge);
  for (const edge of after) afterMap.set(edgeKeyFor(edge), edge);

  const changes: EdgeChange[] = [];

  for (const [key, edge] of afterMap) {
    if (!beforeMap.has(key)) changes.push({ kind: "added", edgeKey: key, edge });
  }
  for (const [key, edge] of beforeMap) {
    if (!afterMap.has(key)) changes.push({ kind: "removed", edgeKey: key, edge });
  }
  for (const [key, beforeEdge] of beforeMap) {
    const afterEdge = afterMap.get(key);
    if (!afterEdge) continue;
    const fields: FieldChange[] = [];
    walkValue("from", beforeEdge.from, afterEdge.from, fields);
    walkValue("to", beforeEdge.to, afterEdge.to, fields);
    walkValue("condition", beforeEdge.condition, afterEdge.condition, fields);
    if (fields.length > 0) {
      fields.sort((a, b) => a.path.localeCompare(b.path));
      changes.push({
        kind: "changed",
        edgeKey: key,
        before: beforeEdge,
        after: afterEdge,
        fields,
      });
    }
  }

  changes.sort((a, b) => a.edgeKey.localeCompare(b.edgeKey));
  return changes;
}

/** Edge key — explicit `id` wins; fallback to `from->to` for unkeyed edges. */
function edgeKeyFor(edge: DiffableEdge): string {
  return edge.id && edge.id.length > 0 ? edge.id : `${edge.from}->${edge.to}`;
}

/** Stable sort: added then removed then changed; within each, by id. */
function compareNodeChange(a: NodeChange, b: NodeChange): number {
  const order: Record<NodeChange["kind"], number> = { added: 0, removed: 1, changed: 2 };
  if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
  const idA = a.kind === "changed" ? a.nodeId : a.node.id;
  const idB = b.kind === "changed" ? b.nodeId : b.node.id;
  return idA.localeCompare(idB);
}

/* ----------------------------- Deep walk ---------------------------------- */

/**
 * Recursive structural compare. Pushes a `FieldChange` for every leaf where
 * `before !== after`. Tags each change via `classifyTag(path, before, after)`.
 * Treats arrays as length-then-index; objects as key-union; primitives via
 * strict equality.
 */
function walkValue(path: string, before: unknown, after: unknown, out: FieldChange[]): void {
  if (before === after) return;

  // Both primitives, undefined, or null → record as a leaf change.
  if (!isWalkable(before) && !isWalkable(after)) {
    out.push({ path, before, after, tag: classifyTag(path, before, after) });
    return;
  }

  // One side walkable, the other not — record as leaf so the UI shows the
  // whole-object replacement rather than per-field churn.
  if (isWalkable(before) !== isWalkable(after)) {
    out.push({ path, before, after, tag: classifyTag(path, before, after) });
    return;
  }

  // Both arrays.
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      out.push({ path, before, after, tag: classifyTag(path, before, after) });
      return;
    }
    for (let i = 0; i < before.length; i++) {
      walkValue(`${path}[${i}]`, before[i], after[i], out);
    }
    return;
  }

  // Both plain objects.
  if (typeof before === "object" && typeof after === "object" && before !== null && after !== null) {
    const beforeObj = before as Record<string, unknown>;
    const afterObj = after as Record<string, unknown>;
    const keys = new Set<string>([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
    for (const key of keys) {
      walkValue(`${path}.${key}`, beforeObj[key], afterObj[key], out);
    }
    return;
  }

  // Mixed shape (e.g. array vs object) — record as one leaf change.
  out.push({ path, before, after, tag: classifyTag(path, before, after) });
}

function isWalkable(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return true;
  return typeof value === "object";
}

/* ----------------------------- Tag classifier ----------------------------- */

const SECRET_TEMPLATE_PATTERN = /\{\{(?:secret|env)\.[^}]+\}\}/;

/** Return the tag for a field change, or null when no rule matches. */
export function classifyTag(path: string, before: unknown, after: unknown): ChangeTag | null {
  // 1. Retry / timeout / bounds — config-resilience knobs.
  if (path === "config.retry" || path.startsWith("config.retry.")) return "retry";
  if (path === "config.timeoutMs" || path === "config.decisionTimeoutMs") return "timeout";
  if (path === "config.maxResponseBytes" || path === "config.maxRedirects") return "bounds";

  // 2. Secret-ref — by key name (last segment matches the chokepoint
  //    pattern) OR by template value on either side.
  if (matchesSensitiveKey(path)) return "secret_ref";
  if (matchesSecretTemplate(before) || matchesSecretTemplate(after)) return "secret_ref";

  // 3. Rationale-only — workflow-level cosmetic fields.
  if (path === "name") return "rationale";
  if (path === "metadata" || path.startsWith("metadata.")) return "rationale";

  return null;
}

function matchesSensitiveKey(path: string): boolean {
  const segments = path.split(/[.[\]]/).filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  if (!last) return false;
  return SENSITIVE_KEY_PATTERN.test(last);
}

function matchesSecretTemplate(value: unknown): boolean {
  return typeof value === "string" && SECRET_TEMPLATE_PATTERN.test(value);
}
