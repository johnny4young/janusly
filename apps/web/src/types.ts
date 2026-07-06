/**
 * Web-side type definitions consumed by the Zustand store, the React Flow
 * components, and the API call sites in `App.tsx`.
 *
 * Some types here mirror server-side schemas declared in `@janusly/shared`
 * (the workflow contract) and `packages/engine/src/tool-registry.ts` (the
 * `ToolSchema` shape). They are restated here as TypeScript types — not
 * Zod — so the browser bundle stays free of Zod runtime weight on every
 * page load. If the server-side shape changes, update both sides.
 *
 * Used by every React component in `apps/web/src/**` and the store.
 */

import type { Edge, Node } from '@xyflow/react'

export type JsonObject = Record<string, unknown>
export type RunNode = { nodeId: string; status: string; stateJson?: JsonObject | null; errorJson?: JsonObject | null }
export type RunEvent = { id: string; nodeId?: string | null; type: string; payload?: JsonObject | null; createdAt?: string }
type WorkflowNodeData = {
  label: string
  type: string
  config: JsonObject
  status?: string
  helper?: string
  hasValidationError?: boolean
}
type WorkflowEdgeData = { condition?: string }
export type ValidationIssue = { code: string; message: string; nodeId?: string; edgeId?: string }
export type ToolSchema = {
  name: string
  description: string
  /** Stable slug (`slack.post` → `slack-post`) the client uses to look up `tools.<descriptionCode>.description` in the i18n catalog. Falls back to the literal `description` when no key exists. */
  descriptionCode?: string
  required?: string[]
  optional?: string[]
  inputExample?: Record<string, unknown>
}
export type Template = {
  id: string
  name: string
  description: string
  category: string
  /** Stable code (`<id>.name`) the client uses to look up `templates.<nameCode>` in the i18n catalog. Falls back to the literal `name` when no key exists. */
  nameCode?: string
  /** Stable code (`<id>.description`). Falls back to the literal `description`. */
  descriptionCode?: string
  /** Slugified category (`Human-in-the-loop` → `human-in-the-loop`). Falls back to the literal `category`. */
  categoryCode?: string
  workflow: WorkflowDefinition
}
export type Credential = { id: string; name: string; kind: string; metadata?: JsonObject; expiresAt?: string | null }

/** One required credential a solution pack declares (name + kind + purpose; never a secret value). */
type PackRequiredCredential = { name: string; kind: string; purpose: string }
/** One required org-config key a solution pack declares. */
type PackRequiredOrgConfig = { key: string; purpose: string }
/** Catalog-safe projection of a solution pack returned by `GET /solution-packs`. */
export type SolutionPackPublic = {
  id: string
  name: string
  description: string
  category: string
  version: string
  requiredCredentials: PackRequiredCredential[]
  requiredOrgConfigs: PackRequiredOrgConfig[]
  nodeCount: number
  sampleCount: number
  failureCount: number
  samplePayloadIds: string[]
  failureFixtureIds: string[]
}
export type ReasoningMessage = { id: string; title: string; body: string; meta?: string; tone: 'info' | 'success' | 'warning' | 'error' }
export type SavedWorkflow = { id: string; orgId: string; name: string; createdBy?: string; createdAt?: string; updatedAt?: string; lastRunStatus?: string | null; runCount?: number; tags?: string[]; folder?: string | null; deletedAt?: string | null }
export type RunSummary = {
  id: string
  orgId?: string
  workflowVersionId?: string
  status: string
  createdBy?: string
  createdAt?: string
  /** Projected workflow output. Populated only when the run reached `succeeded` AND the workflow declared `outputs`. */
  outputJson?: JsonObject | null
  /**
   * Replay-mode tag. `null` (or absent) for production runs; `"validation"`
   * for sandbox runs created by the recovery dialog or the Replay Lab.
   * Drives whether the "Open in Lab" button surfaces (no nested labs).
   */
  replayMode?: string | null
}
export type OrgRole = 'viewer' | 'editor' | 'admin'
export type OrgMember = { id: string; orgId: string; userId: string; email?: string; role: OrgRole; invitedBy?: string; createdAt?: string }

export type McpTransport = 'stdio' | 'sse' | 'http'
export type McpConnectionStatus = 'pending' | 'active' | 'failed' | 'disabled'
type McpEnvRef = { kind: 'env'; name: string }
export type McpConnection = {
  id: string
  orgId: string
  alias: string
  transport: McpTransport
  command: string | null
  args: string[] | null
  url: string | null
  envRefs: Record<string, McpEnvRef>
  enabled: boolean
  status: McpConnectionStatus
  statusReason: string | null
  lastDiscoveryAt?: string | null
  toolCount?: number
  enabledToolCount?: number
  createdBy?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}
export type McpToolDescriptor = {
  id: string
  connectionId: string
  name: string
  description: string | null
  inputSchema: Record<string, unknown> | null
  writeSide: boolean
  enabled: boolean
  /**
   * Admin opt-in flag controlling whether this descriptor's description
   * is surfaced to `/ai/generate-workflow`'s system prompt. Default
   * `false`; both this AND the parent connection's `exposeToAi` flag
   * must be `true` for the tool to appear in the LLM prompt.
   */
  exposeToAi: boolean
}

export type AiMode = 'ai' | 'fallback' | 'error'
export type AiHealth = { enabled: boolean; provider?: string; model: string; timeoutMs: number; maxRetries: number }
export type ActiveTab = 'home' | 'workflows' | 'members' | 'copilot' | 'marketplace' | 'templates' | 'packs' | 'credentials' | 'inspector' | 'runs' | 'reasoning' | 'multiAgent' | 'operations'

/**
 * Tabs that NEED the React Flow canvas mounted as their main slot. Today
 * this is only the AI Studio (drag-and-drop authoring) and the Inspector
 * (node-click selection mirrored from the canvas). Every other tab is
 * configuration / admin / read-only and benefits from full main-slot
 * width without the DAG sitting behind it.
 *
 * The `home` tab is its own dedicated branch (`RecoveryCenterPanel`) and
 * is NOT considered a canvas tab — it owns the full slot independently.
 *
 * Adding a new tab that needs the canvas means appending to this tuple;
 * every other tab gains the contextual full-width layout for free.
 */
export const CANVAS_TABS = ['copilot', 'inspector'] as const

export type CanvasTab = (typeof CANVAS_TABS)[number]

/** Closed type-guard. The `as readonly string[]` cast keeps the runtime
 *  check honest while the type predicate keeps callers strict. */
export const isCanvasTab = (tab: ActiveTab): tab is CanvasTab =>
  (CANVAS_TABS as readonly string[]).includes(tab)

/**
 * Decides how the App shell mounts the canvas + contextual slot for the
 * given tab. Three closed states:
 *
 * - `home`: canvas is NOT in the DOM (the home page owns the full main
 *   slot via `RecoveryCenterPanel`). Users who only ever visit the home
 *   page never pay the React Flow runtime cost.
 * - Canvas tab (`copilot` / `inspector`): canvas mounted AND visible;
 *   contextual slot is NOT rendered (the right rail handles the panel).
 * - Any other tab: canvas mounted but HIDDEN via `display: none` so the
 *   root-level `<ReactFlowProvider>` retains viewport state across the
 *   navigation; the contextual main slot renders alongside.
 *
 * Returning a small struct (vs three boolean call sites) keeps the dispatcher
 * inside `App.tsx` legible and lets a unit test cover every tab cheaply.
 */
export type CanvasVisibility = {
  /** True when the canvas wrapper element exists in the DOM. */
  mounted: boolean
  /** True when the canvas is visible (one of `CANVAS_TABS`). */
  visible: boolean
  /** True when the contextual main slot should render alongside the canvas. */
  contextualSlot: boolean
}

export function getCanvasVisibility(activeTab: ActiveTab): CanvasVisibility {
  if (activeTab === 'home') {
    return { mounted: false, visible: false, contextualSlot: false }
  }
  const canvas = isCanvasTab(activeTab)
  return { mounted: true, visible: canvas, contextualSlot: !canvas }
}
/**
 * JSON-Schema-subset describing one input field on a workflow's declared
 * `inputs` shape. Mirrors `WorkflowInputSchemaShape` in `@janusly/shared`.
 * Restated as a TS type to keep the browser bundle free of Zod runtime weight.
 */
export type WorkflowInputSchemaShape = {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description?: string
  properties?: Record<string, WorkflowInputSchemaShape>
  required?: string[]
  items?: WorkflowInputSchemaShape
  enum?: unknown[]
}

export type WorkflowDefinition = {
  id?: string
  name?: string
  nodes: Array<{ id: string; type: string; config: JsonObject }>
  edges: Array<{ from: string; to: string; condition?: string }>
  /** Typed inputs surfaced in the Inspector + validated at run start. */
  inputs?: WorkflowInputSchemaShape
  /** Output projection map; engine renders each template at terminal `succeeded`. */
  outputs?: Record<string, string>
}
export type WorkflowGraphNode = Node<WorkflowNodeData>
export type WorkflowGraphEdge = Edge<WorkflowEdgeData>
