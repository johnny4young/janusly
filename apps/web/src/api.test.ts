import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { changeAppLanguage, initI18n } from './i18n'
import { useWorkflowStore } from './store'

let mockSessionToken: string | null = null
vi.mock('./auth', () => ({
  supabase: null,
  getActiveOrg: () => 'default',
  getSessionToken: () => mockSessionToken,
}))

function mockJsonResponse(status: number, payload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => (
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  )))
}

describe('api', () => {
  beforeEach(() => {
    initI18n('en')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    useWorkflowStore.getState().clearBudgetBlocked()
    mockSessionToken = null
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

  it('localizes generic request failures through the active locale', async () => {
    changeAppLanguage('es')
    mockJsonResponse(500, {})

    await expect(api('/validate', { method: 'POST' })).rejects.toThrow('La solicitud falló con estado 500')
  })

  it('localizes offline failures through the active locale', async () => {
    changeAppLanguage('es')
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network unavailable')
    }))

    await expect(api('/ping')).rejects.toThrow('La API de Janusly no está disponible')
  })

  it('sends x-janusly-session instead of x-user-id when a session token is set', async () => {
    mockSessionToken = 'js-session-token-abc'
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await api('/ping')

    expect(fetchMock).toHaveBeenCalledOnce()
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['x-janusly-session']).toBe('js-session-token-abc')
    expect(headers['x-org-id']).toBe('default')
    expect(headers['x-user-id']).toBeUndefined()
    expect(headers['Authorization']).toBeUndefined()
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
