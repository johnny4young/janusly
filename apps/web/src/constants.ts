import type { CSSProperties } from 'react'
import type { JsonObject } from './types'

export const nodePresets: Record<string, JsonObject> = {
  http: { url: 'https://api.github.com' },
  noop: {},
  transform: { mapping: { value: '{{context.api.output.statusCode}}' } },
  condition: { expression: 'true' },
  webhook: {},
  approval: { message: 'Please approve this workflow step.' },
  ai: { provider: 'mock', prompt: 'Summarize this workflow using {{context}}' },
  tool: { tool: 'text.uppercase', input: { value: 'hello' } },
  agent: { planner: 'rules', goal: 'uppercase this text', value: 'hello', maxSteps: 3 },
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

export const statusStyles: Record<string, CSSProperties> = {
  pending: { border: '1.5px solid #d2d6e6', background: '#fbfbfe' },
  queued: { border: '1.5px solid #f59e0b', background: '#fffbeb' },
  running: { border: '1.5px solid #3b82f6', background: '#eff6ff' },
  waiting: { border: '1.5px solid #f59e0b', background: '#fffbeb' },
  skipped: { border: '1.5px solid #94a3b8', background: '#f8fafc' },
  succeeded: { border: '1.5px solid #10b981', background: '#ecfdf5' },
  failed: { border: '1.5px solid #ef4444', background: '#fef2f2' },
}
