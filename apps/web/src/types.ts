import type { Edge, Node } from '@xyflow/react'

export type JsonObject = Record<string, unknown>
export type RunNode = { nodeId: string; status: string; stateJson?: JsonObject | null; errorJson?: JsonObject | null }
export type RunEvent = { id: string; nodeId?: string | null; type: string; payload?: JsonObject | null; createdAt?: string }
export type WorkflowNodeData = { label: string; type: string; config: JsonObject }
export type WorkflowEdgeData = { condition?: string }
export type ValidationIssue = { code: string; message: string; nodeId?: string; edgeId?: string }
export type ToolSchema = { name: string; description: string; required?: string[]; optional?: string[]; inputExample?: Record<string, unknown> }
export type Template = { id: string; name: string; description: string; category: string; workflow: WorkflowDefinition }
export type Credential = { id: string; name: string; kind: string; secretRef: string; metadata?: JsonObject }
export type ReasoningMessage = { id: string; title: string; body: string; meta?: string; tone: 'info' | 'success' | 'warning' | 'error' }
export type SavedWorkflow = { id: string; orgId: string; name: string; createdBy?: string; createdAt?: string; updatedAt?: string }
export type RunSummary = { id: string; orgId?: string; workflowVersionId?: string; status: string; createdBy?: string; createdAt?: string }
export type OrgRole = 'viewer' | 'editor' | 'admin'
export type OrgMember = { id: string; orgId: string; userId: string; email?: string; role: OrgRole; invitedBy?: string; createdAt?: string }
export type ActiveTab = 'workflows' | 'members' | 'copilot' | 'marketplace' | 'templates' | 'credentials' | 'inspector' | 'runs' | 'reasoning' | 'crew'
export type WorkflowDefinition = {
  id?: string
  name?: string
  nodes: Array<{ id: string; type: string; config: JsonObject }>
  edges: Array<{ from: string; to: string; condition?: string }>
}
export type WorkflowGraphNode = Node<WorkflowNodeData>
export type WorkflowGraphEdge = Edge<WorkflowEdgeData>
