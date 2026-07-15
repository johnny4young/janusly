/**
 * Node-type catalogue + display helpers — the bridge between the runtime
 * type union (`@janusly/shared/nodeTypeValues`) and the UI's labels +
 * status styling. Adding a new node type means adding entries here AND
 * to `nodeTypeValues` (the runtime won't accept it otherwise).
 *
 * Used by `components/RightPanel.tsx` (Inspector + node-kind dropdown),
 * `components/WorkflowStepNode.tsx` (canvas rendering),
 * `components/AiCopilotPanel.tsx`, and the dashboard helpers.
 *
 * Invariants:
 * - `nodePresets` keys mirror `nodeTypeValues` exactly. A type missing
 *   here means the "Add step" UI can't seed a config.
 * - All user-facing strings flow through `i18n/runtime.t(...)` — adding a
 *   new node type means a sibling pair of `nodes.<type>.label` /
 *   `nodes.<type>.helper` keys in `apps/web/src/i18n/locales/<lng>/common.json`.
 *   The parity test catches missing translations at CI time.
 */

import type { JsonObject } from './types'
import { t } from './i18n/runtime'

// Mirrors the persisted workflow-version int4 bound. Keep this local so the
// node-summary catalogue does not pull a shared runtime barrel into the web.
const WORKFLOW_VERSION_MAX = 2_147_483_647

/** Default `config` per node type — used by the "Add step" affordance. */
export const nodePresets: Record<string, JsonObject> = {
  http: { url: 'https://api.github.com' },
  noop: {},
  transform: { mapping: { value: '{{context.api.output.statusCode}}' } },
  condition: { expression: 'true' },
  webhook: {},
  approval: {},
  human_form: {
    schema: {
      type: 'object',
      properties: {
        requester: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['requester', 'reason'],
    },
  },
  ai: {},
  tool: { tool: 'text.uppercase', input: { value: 'hello' } },
  agent: { planner: 'rules', value: 'hello', maxSteps: 3 },
  router: { candidates: [{ nodeId: 'fast_path', avgCost: 0.001, avgLatencyMs: 500, successRate: 0.9 }] },
  router_llm: { candidates: [{ nodeId: 'accurate_path', avgCost: 0.01, avgLatencyMs: 1500, successRate: 0.98 }] },
  loop: { items: 'a,b,c', mapping: { value: '{{item}}', index: '{{index}}' } },
  agent_reflection: { input: '{{context.agent.output}}' },
  multi_agent: {
    mode: 'sequential',
    planner: 'rules',
    maxSteps: 2,
    reflection: true,
    agents: [
      { name: 'analyzer' },
      { name: 'validator' },
    ],
  },
  subworkflow: { workflowId: '' },
  wait_until: { duration: 'P1D' },
  parallel_fork: { branches: [{ label: 'a' }, { label: 'b' }] },
  join: { sources: { a: '', b: '' } },
  schedule: { cronExpression: '0 9 * * *', enabled: true },
  mcp_tool: { connectionAlias: '', toolName: '', input: {} },
  email_received: { aliasKey: '', dkimRequired: true },
  file_dropped: { bucket: '', prefix: '' },
  mcp_server_event: { connectionAlias: '', resourceUri: '' },
}

/** Ordered list of supported node-type ids — derived from `nodePresets`. */
export const nodeTypes = Object.keys(nodePresets)

/** Localised default `config` per node type — used when the UI seeds a new step. */
export function getNodePreset(type: string): JsonObject {
  switch (type) {
    case 'approval':
      return { message: t('nodeDefaults.approval.message') as string }
    case 'human_form':
      return {
        ...clonePreset(nodePresets.human_form),
        title: t('nodeDefaults.humanForm.title') as string,
        description: t('nodeDefaults.humanForm.description') as string,
        schema: {
          type: 'object',
          properties: {
            requester: { type: 'string', description: t('nodeDefaults.humanForm.requester') as string },
            reason: { type: 'string', description: t('nodeDefaults.humanForm.reason') as string },
          },
          required: ['requester', 'reason'],
        },
      }
    case 'ai':
      return { prompt: t('nodeDefaults.ai.prompt') as string }
    case 'agent':
      return {
        ...clonePreset(nodePresets.agent),
        goal: t('nodeDefaults.agent.goal') as string,
      }
    case 'multi_agent':
      return {
        ...clonePreset(nodePresets.multi_agent),
        goal: t('nodeDefaults.multiAgent.goal') as string,
        agents: [
          {
            name: 'analyzer',
            role: t('nodeDefaults.multiAgent.analyzer.role') as string,
            persona: t('nodeDefaults.multiAgent.analyzer.persona') as string,
            goal: t('nodeDefaults.multiAgent.analyzer.goal') as string,
          },
          {
            name: 'validator',
            role: t('nodeDefaults.multiAgent.validator.role') as string,
            persona: t('nodeDefaults.multiAgent.validator.persona') as string,
            goal: t('nodeDefaults.multiAgent.validator.goal') as string,
          },
        ],
      }
    default:
      return clonePreset(nodePresets[type] ?? {})
  }
}

/**
 * Closed enum of node types we ship UI strings for. We keep this list
 * separate from `nodePresets` so that lookups for an unknown / experimental
 * type fall back gracefully (`label = id, helper = generic`) without
 * tripping the i18next missing-key warning for catalog noise.
 */
const KNOWN_NODE_TYPES = new Set(nodeTypes)

/** Human label for a node type (falls back to the raw id with `_` → space). */
export function getNodeLabel(type: string): string {
  if (KNOWN_NODE_TYPES.has(type)) {
    return t(`nodes.${type}.label` as never) as string
  }
  return type.replaceAll('_', ' ')
}

/** Helper / hint text for a node type (used in the step-picker subtitle). */
export function getNodeHelper(type: string): string {
  if (KNOWN_NODE_TYPES.has(type)) {
    return t(`nodes.${type}.helper` as never) as string
  }
  return t('nodes.fallbackHelper') as string
}

/** One-line config summary for the Inspector header (e.g. "GET https://api.example.com"). */
export function getNodeConfigSummary(type: string, config: JsonObject): string {
  if (type === 'http') return readString(config.url) ?? (t('nodeSummary.http.empty') as string)
  if (type === 'ai') return compact(readString(config.prompt) ?? (t('nodeSummary.ai.empty') as string))
  if (type === 'tool') return readString(config.tool) ?? (t('nodeSummary.tool.empty') as string)
  if (type === 'agent') return compact(readString(config.goal) ?? (t('nodeSummary.agent.empty') as string))
  if (type === 'multi_agent') {
    const agentCount = Array.isArray(config.agents) ? config.agents.length : 0
    const goal = compact(readString(config.goal) ?? (t('nodeSummary.multi_agent.coordinate') as string))
    return agentCount
      ? (t('nodeSummary.multi_agent.withCount', { count: agentCount, goal }) as string)
      : goal
  }
  if (type === 'approval') return compact(readString(config.message) ?? (t('nodeSummary.approval.empty') as string))
  if (type === 'human_form') return compact(readString(config.title) ?? (t('nodeSummary.human_form.empty') as string))
  if (type === 'condition') return compact(readString(config.expression) ?? (t('nodeSummary.condition.empty') as string))
  if (type === 'loop') return compact(readString(config.items) ?? (t('nodeSummary.loop.empty') as string))
  if (type === 'transform') return t('nodeSummary.transform.text') as string
  if (type === 'router' || type === 'router_llm') return t('nodeSummary.router.text') as string
  if (type === 'webhook') return t('nodeSummary.webhook.text') as string
  if (type === 'noop') return t('nodeSummary.noop.text') as string
  if (type === 'subworkflow') {
    const workflowId = readString(config.workflowId)
    if (!workflowId) return t('nodeSummary.subworkflow.empty') as string
    const version = config.version
    return typeof version === 'number'
      && Number.isSafeInteger(version)
      && version > 0
      && version <= WORKFLOW_VERSION_MAX
      ? (t('nodeSummary.subworkflow.pinned', { workflowId, version }) as string)
      : workflowId
  }
  if (type === 'wait_until') return readString(config.duration) ?? readString(config.until) ?? (t('nodeSummary.wait_until.empty') as string)
  if (type === 'parallel_fork') {
    const branches = Array.isArray(config.branches) ? config.branches.length : 0
    if (branches === 0) return t('nodeSummary.parallel_fork.empty') as string
    return t('nodeSummary.parallelForkBranches', { count: branches }) as string
  }
  if (type === 'join') {
    const sources = config.sources && typeof config.sources === 'object' && !Array.isArray(config.sources)
      ? Object.keys(config.sources as Record<string, unknown>).length
      : 0
    if (sources === 0) return t('nodeSummary.join.empty') as string
    return t('nodeSummary.joinBranches', { count: sources }) as string
  }
  if (type === 'schedule') {
    const cron = readString(config.cronExpression)
    if (!cron) return t('nodeSummary.schedule.empty') as string
    return config.enabled === false
      ? (t('nodeSummary.schedule.paused', { cron }) as string)
      : (t('nodeSummary.schedule.active', { cron }) as string)
  }
  if (type === 'mcp_tool') {
    const alias = readString(config.connectionAlias)
    const toolName = readString(config.toolName)
    if (alias && toolName) return t('nodeSummary.mcp_tool.set', { alias, tool: toolName }) as string
    return t('nodeSummary.mcp_tool.empty') as string
  }
  if (type === 'email_received') {
    const alias = readString(config.aliasKey)
    return alias ? (t('nodeSummary.email_received.set', { alias }) as string) : (t('nodeSummary.email_received.empty') as string)
  }
  if (type === 'file_dropped') {
    const bucket = readString(config.bucket)
    return bucket ? (t('nodeSummary.file_dropped.set', { bucket }) as string) : (t('nodeSummary.file_dropped.empty') as string)
  }
  if (type === 'mcp_server_event') {
    const alias = readString(config.connectionAlias)
    const resource = readString(config.resourceUri)
    if (alias && resource) return t('nodeSummary.mcp_server_event.set', { alias, resource }) as string
    return t('nodeSummary.mcp_server_event.empty') as string
  }
  return t('nodeSummary.fallback') as string
}

/** Status strings we ship UI labels for — mirrors the `status.*` i18n keys. */
const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  'created', 'draft', 'pending', 'queued', 'running', 'waiting', 'skipped',
  'succeeded', 'failed', 'cancelled', 'timed_out', 'open', 'replayed', 'resolved',
])

/** Human label for a node/run status string (e.g. `"running"` → `"Running"`). */
export function formatStatusLabel(status: string): string {
  if (KNOWN_STATUSES.has(status)) return t(`status.${status}` as never) as string
  return status.replaceAll('_', ' ')
}

/** Label for the AI mode chip — surfaces `"AI"` / `"Fallback"` / `"Error"` per AGENTS.md fallback contract. */
export function formatAiModeLabel(mode: 'ai' | 'fallback' | 'error'): string {
  return t(`aiMode.${mode}` as never) as string
}

/** Compact run-node duration (`started_at`→`finished_at`) as `42s` / `1m 20s`.
 *  Returns null when either timestamp is missing or the span is negative. */
export function formatNodeDuration(startedAt?: string | null, finishedAt?: string | null): string | null {
  if (!startedAt || !finishedAt) return null
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
}

/** Compact, locale-neutral technical duration for dense run metadata. */
export function formatCompactDuration(durationMs: number): string {
  const safeMs = Math.max(0, Math.round(durationMs))
  if (safeMs < 1_000) return `${safeMs}ms`
  const seconds = Math.floor(safeMs / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function compact(value: string): string {
  return value.length > 72 ? `${value.slice(0, 69)}...` : value
}

function clonePreset(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}
