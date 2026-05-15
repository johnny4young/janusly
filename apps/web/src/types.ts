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
export type WorkflowNodeData = {
  label: string
  type: string
  config: JsonObject
  status?: string
  helper?: string
  hasValidationError?: boolean
}
export type WorkflowEdgeData = { condition?: string }
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
export type Credential = { id: string; name: string; kind: string; secretRef: string; metadata?: JsonObject }
export type ReasoningMessage = { id: string; title: string; body: string; meta?: string; tone: 'info' | 'success' | 'warning' | 'error' }
export type SavedWorkflow = { id: string; orgId: string; name: string; createdBy?: string; createdAt?: string; updatedAt?: string }
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

export type McpTransport = 'stdio' | 'sse'
export type McpConnectionStatus = 'pending' | 'active' | 'failed' | 'disabled'
export type McpEnvRef = { kind: 'env'; name: string }
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
}

export type AiMode = 'ai' | 'fallback' | 'error'
export type AiHealth = { enabled: boolean; provider?: string; model: string; timeoutMs: number; maxRetries: number }
export type ActiveTab = 'home' | 'workflows' | 'members' | 'copilot' | 'marketplace' | 'templates' | 'credentials' | 'inspector' | 'runs' | 'reasoning' | 'multiAgent' | 'operations'
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
