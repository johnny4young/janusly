import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'

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
  })

  it('returns /start field validation envelopes so the run input form can map errors', async () => {
    mockJsonResponse(400, { errors: ['$.invoiceId is required'] })

    await expect(api('/start', { method: 'POST' })).resolves.toEqual({
      errors: ['$.invoiceId is required'],
    })
  })

  it('throws field-error-shaped 400 responses outside /start', async () => {
    mockJsonResponse(400, { errors: ['$.invoiceId is required'] })

    await expect(api('/validate', { method: 'POST' })).rejects.toThrow('Request failed with 400')
  })
})
