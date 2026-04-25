export const nodePresets: Record<string, Record<string, any>> = {
  http: { url: 'https://api.github.com' },
  noop: {},
  transform: { mapping: { value: '{{context.1.output.statusCode}}' } },
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
      { name: 'validator', role: 'QA reviewer', persona: 'Skeptical reviewer', goal: 'Validate the previous agent output and identify issues' }
    ]
  },
}

export const nodeTypes = Object.keys(nodePresets)

export const statusStyles: Record<string, React.CSSProperties> = {
  pending: { border: '2px solid #94a3b8', background: '#f8fafc' },
  queued: { border: '2px solid #f59e0b', background: '#fffbeb' },
  running: { border: '2px solid #3b82f6', background: '#eff6ff' },
  waiting: { border: '2px solid #a855f7', background: '#faf5ff' },
  skipped: { border: '2px solid #64748b', background: '#f1f5f9' },
  succeeded: { border: '2px solid #22c55e', background: '#f0fdf4' },
  failed: { border: '2px solid #ef4444', background: '#fef2f2' },
}
