import { describe, expect, it } from 'vitest'
import { planAgentTool } from './agent-planner'

describe('planAgentTool (heuristic planner)', () => {
  it('respects an explicit tool defined in config', () => {
    const plan = planAgentTool({ tool: 'json.pick', input: { path: 'a.b' } }, {})
    expect(plan.tool).toBe('json.pick')
    expect(plan.input).toEqual({ path: 'a.b' })
    expect(plan.reason).toMatch(/explicit/i)
  })

  it('detects an uppercase intent', () => {
    const plan = planAgentTool({ goal: 'Please uppercase this text', value: 'hello' }, {})
    expect(plan.tool).toBe('text.uppercase')
    expect(plan.input).toEqual({ value: 'hello' })
  })

  it('detects JSON extraction', () => {
    const plan = planAgentTool({ goal: 'pick a value from response', path: 'data.id' }, {})
    expect(plan.tool).toBe('json.pick')
  })

  it('detects HTTP calls', () => {
    const plan = planAgentTool({ goal: 'call api', url: 'https://example.com' }, {})
    expect(plan.tool).toBe('http.request')
    expect(plan.input).toEqual({ url: 'https://example.com', method: 'GET', body: undefined, headers: undefined })
  })

  it('falls back to text.uppercase when nothing matches', () => {
    const plan = planAgentTool({ goal: 'do something custom' }, {})
    expect(plan.tool).toBe('text.uppercase')
    expect(plan.reason).toMatch(/fallback/i)
  })
})
