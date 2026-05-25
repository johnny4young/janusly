import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, __resetInFlightForTests } from './api'
import { changeAppLanguage, initI18n } from './i18n'
import { useWorkflowStore } from './store'

let mockSessionToken: string | null = null
let mockActiveOrg = 'default'
let mockSupabaseAccessToken: string | null = null
const mockSupabaseClient = {
  auth: {
    getSession: async () => ({ data: { session: mockSupabaseAccessToken ? { access_token: mockSupabaseAccessToken } : null } }),
  },
}
vi.mock('./auth', () => ({
  // Falsy => Supabase mode is "off" by default. Tests that exercise
  // the Supabase JWT path set `mockSupabaseAccessToken` AND flip this
  // to the mock client via `vi.doMock` per case.
  get supabase() { return mockSupabaseAccessToken !== null ? mockSupabaseClient : null },
  getActiveOrg: () => mockActiveOrg,
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
    __resetInFlightForTests()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    useWorkflowStore.getState().clearBudgetBlocked()
    mockSessionToken = null
    mockActiveOrg = 'default'
    mockSupabaseAccessToken = null
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

  it('dedups identical GETs within the in-flight window', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const [a, b] = await Promise.all([api('/dlq'), api('/dlq')])

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(a).toEqual({ items: [] })
    expect(b).toEqual({ items: [] })
    // The two awaiters resolve from the SAME Promise — payload identity
    // confirms the shared in-flight entry was returned.
    expect(a).toBe(b)
  })

  it('does not dedup across active org changes inside the TTL window', async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const headers = init?.headers as Record<string, string>
      return new Response(JSON.stringify({ orgId: headers['x-org-id'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const defaultOrg = await api('/members')
    mockActiveOrg = 'enterprise'
    const enterpriseOrg = await api('/members')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(defaultOrg).toEqual({ orgId: 'default' })
    expect(enterpriseOrg).toEqual({ orgId: 'enterprise' })
  })

  it('does not dedup across locale changes inside the TTL window', async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const headers = init?.headers as Record<string, string>
      return new Response(JSON.stringify({ locale: headers['Accept-Language'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const english = await api('/ai/explain-workflow', { method: 'POST', body: JSON.stringify({ workflow: {} }) })
    changeAppLanguage('es')
    const spanish = await api('/ai/explain-workflow', { method: 'POST', body: JSON.stringify({ workflow: {} }) })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(english).toEqual({ locale: 'en' })
    expect(spanish).toEqual({ locale: 'es' })
  })

  it('does not dedup across Supabase access-token rotations inside the TTL window', async () => {
    // User A authenticates, makes a request; within 500ms User A logs
    // out and User B logs in (or User A's token refreshes). The
    // second call must NOT share User A's cached response.
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const headers = init?.headers as Record<string, string>
      return new Response(JSON.stringify({ token: headers['Authorization'] ?? null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    mockSupabaseAccessToken = 'jwt-user-a'
    const userA = await api('/runs')
    mockSupabaseAccessToken = 'jwt-user-b'
    const userB = await api('/runs')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(userA).toEqual({ token: 'Bearer jwt-user-a' })
    expect(userB).toEqual({ token: 'Bearer jwt-user-b' })
  })

  it('does not dedup when the request body differs', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await Promise.all([
      api('/workflows/save', { method: 'POST', body: JSON.stringify({ id: 'a' }) }),
      api('/workflows/save', { method: 'POST', body: JSON.stringify({ id: 'b' }) }),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not dedup across the TTL boundary', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await api('/runs')
    // Advance past the 500ms TTL window so the cached entry is stale.
    await vi.advanceTimersByTimeAsync(600)
    await api('/runs')

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('skips dedup when the caller passes an AbortSignal', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const ctrlA = new AbortController()
    const ctrlB = new AbortController()
    await Promise.all([
      api('/runs', { signal: ctrlA.signal }),
      api('/runs', { signal: ctrlB.signal }),
    ])

    // Two callers with distinct abort intents must get two real fetches —
    // sharing the Promise would let one caller abort the other's request.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('shares a rejected in-flight Promise across awaiters then refetches after the TTL', async () => {
    vi.useFakeTimers()
    // First call fails (still cached for TTL), parallel call sees same rejection,
    // post-TTL call goes back to the network.
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'boom' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const results = await Promise.allSettled([api('/runs'), api('/runs')])
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(600)
    const second = await api('/runs')
    expect(second).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
