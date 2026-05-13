import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { useWorkflowStore } from './store'

vi.mock('./auth', () => ({ supabase: null }))

function mockJsonResponse(status: number, payload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => (
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  )))
}

describe('api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    useWorkflowStore.getState().clearBudgetBlocked()
  })

  it('returns /start field validation envelopes so the run input form can map errors', async () => {
    mockJsonResponse(400, { errors: ['$.invoiceId is required'] })

    await expect(api('/start', { method: 'POST' })).resolves.toEqual({
      errors: ['$.invoiceId is required'],
    })
  })

  it('returns /resume field validation envelopes so human forms can map errors', async () => {
    mockJsonResponse(400, { errors: ['$.requester is required'] })

    await expect(api('/resume', { method: 'POST' })).resolves.toEqual({
      errors: ['$.requester is required'],
    })
  })

  it('throws field-error-shaped 400 responses outside /start and /resume', async () => {
    mockJsonResponse(400, { errors: ['$.invoiceId is required'] })

    await expect(api('/validate', { method: 'POST' })).rejects.toThrow('Request failed with 400')
  })

  it('stores the budget envelope on AI 402 responses before throwing', async () => {
    const budget = {
      allowed: false,
      monthlyUsdSpent: 12,
      monthlyUsdLimit: 10,
      policy: 'block',
      warningPercent: 80,
      warningThresholdCrossed: true,
      exceededAt: 'org',
      resolvedScope: 'org',
    }
    mockJsonResponse(402, { error: 'budget_exceeded', budget })

    await expect(api('/ai/generate-workflow', { method: 'POST' })).rejects.toThrow('budget_exceeded')
    expect(useWorkflowStore.getState().budgetBlocked).toEqual(budget)
  })
})
