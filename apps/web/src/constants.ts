import type { CSSProperties } from 'react'
import type { JsonObject } from './types'

export const nodePresets: Record<string, JsonObject> = {
  http: { url: 'https://api.github.com' },
  noop: {},
  transform: { mapping: { value: '{{context.api.output.statusCode}}' } },
  condition: { expression: 'true' },
  webhook: {},
  approval: { message: 'Please approve this workflow step.' },
  ai: { prompt: 'Summarize the latest workflow result and suggest the next action.' },
  tool: { tool: 'text.uppercase', input: { value: 'hello' } },
  agent: { planner: 'rules', goal: 'uppercase this text', value: 'hello', maxSteps: 3 },
  router: { candidates: [{ nodeId: 'fast_path', avgCost: 0.001, avgLatencyMs: 500, successRate: 0.9 }] },
  router_llm: { candidates: [{ nodeId: 'accurate_path', avgCost: 0.01, avgLatencyMs: 1500, successRate: 0.98 }] },
  loop: { items: 'a,b,c', mapping: { value: '{{item}}', index: '{{index}}' } },
  agent_reflection: { input: '{{context.agent.output}}' },
  multi_agent: {
    mode: 'sequential',
    goal: 'Analyze and validate the workflow result',
    planner: 'rules',
    maxSteps: 2,
    reflection: true,
    agents: [
      { name: 'analyzer', role: 'Data analyst', persona: 'Careful and concise analyst', goal: 'Analyze the current context and produce a useful summary' },
      { name: 'validator', role: 'QA reviewer', persona: 'Skeptical reviewer', goal: 'Validate the previous agent output and identify issues' },
    ],
  },
}

export const nodeTypes = Object.keys(nodePresets)

export const nodeUi: Record<string, { label: string; helper: string }> = {
  http: { label: 'Call an API', helper: 'Fetch data from a service' },
  noop: { label: 'Do nothing', helper: 'Start or finish cleanly' },
  transform: { label: 'Shape data', helper: 'Map fields for the next step' },
  condition: { label: 'Branch rule', helper: 'Continue only when true' },
  webhook: { label: 'Wait for webhook', helper: 'Pause for an external event' },
  approval: { label: 'Ask approval', helper: 'Pause for a person' },
  ai: { label: 'AI prompt', helper: 'Ask Janusly to summarize or decide' },
  tool: { label: 'Run a tool', helper: 'Use a registered backend action' },
  agent: { label: 'Agent', helper: 'Plan tool calls toward a goal' },
  router: { label: 'Smart router', helper: 'Pick the best path from scores' },
  router_llm: { label: 'AI router', helper: 'Route with AI-ready context' },
  loop: { label: 'Repeat list', helper: 'Run a mapping for each item' },
  agent_reflection: { label: 'Review result', helper: 'Accept or retry a result' },
  multi_agent: { label: 'Agent team', helper: 'Coordinate multiple agents' },
}

export function getNodeLabel(type: string) {
  return nodeUi[type]?.label ?? type.replaceAll('_', ' ')
}

export function getNodeHelper(type: string) {
  return nodeUi[type]?.helper ?? 'Workflow step'
}

export function getNodeConfigSummary(type: string, config: JsonObject) {
  if (type === 'http') return readString(config.url) ?? 'Add a request URL'
  if (type === 'ai') return compact(readString(config.prompt) ?? 'Add a prompt for Janusly')
  if (type === 'tool') return readString(config.tool) ?? 'Choose a backend tool'
  if (type === 'agent') return compact(readString(config.goal) ?? 'Define the agent goal')
  if (type === 'multi_agent') {
    const agentCount = Array.isArray(config.agents) ? config.agents.length : 0
    const goal = compact(readString(config.goal) ?? 'Coordinate a team goal')
    return agentCount ? `${agentCount} agents - ${goal}` : goal
  }
  if (type === 'approval') return compact(readString(config.message) ?? 'Add an approval message')
  if (type === 'condition') return compact(readString(config.expression) ?? 'Add a branch rule')
  if (type === 'loop') return compact(readString(config.items) ?? 'Add list items')
  if (type === 'transform') return 'Map output fields'
  if (type === 'router' || type === 'router_llm') return 'Rank candidate paths'
  if (type === 'webhook') return 'Wait for an external event'
  if (type === 'noop') return 'No setup needed'
  return 'Review step settings'
}

export function formatStatusLabel(status: string) {
  const labels: Record<string, string> = {
    draft: 'Draft',
    pending: 'Ready',
    queued: 'Queued',
    running: 'Running',
    waiting: 'Needs approval',
    skipped: 'Skipped',
    succeeded: 'Done',
    failed: 'Needs attention',
    canceled: 'Canceled',
    open: 'Open',
    replayed: 'Retried',
    resolved: 'Resolved',
  }

  return labels[status] ?? status.replaceAll('_', ' ')
}

export function formatAiModeLabel(mode: 'ai' | 'fallback' | 'error') {
  if (mode === 'ai') return 'AI'
  if (mode === 'fallback') return 'Local mode'
  return 'Needs attention'
}

export const statusStyles: Record<string, CSSProperties> = {
  pending: { border: '1.5px solid var(--we-line-strong)', background: 'var(--we-surface-2)' },
  queued: { border: '1.5px solid var(--we-warning)', background: 'var(--we-warning-soft)' },
  running: { border: '1.5px solid var(--we-info)', background: 'var(--we-info-soft)' },
  waiting: { border: '1.5px solid var(--we-warning)', background: 'var(--we-warning-soft)' },
  skipped: { border: '1.5px solid var(--we-faint)', background: 'var(--we-surface-muted)' },
  succeeded: { border: '1.5px solid var(--we-success)', background: 'var(--we-success-soft)' },
  failed: { border: '1.5px solid var(--we-danger)', background: 'var(--we-danger-soft)' },
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function compact(value: string) {
  return value.length > 72 ? `${value.slice(0, 69)}...` : value
}
