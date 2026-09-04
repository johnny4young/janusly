import { describe, expect, it } from 'vitest'
import { ApiError } from '../api'
import { apiErrorStatus, isForbiddenApiError } from './api-error'

describe('isForbiddenApiError', () => {
  it('recognises the API error the transport actually throws', () => {
    expect(isForbiddenApiError(new ApiError('nope', { statusCode: 403, code: 'forbidden' }))).toBe(true)
    expect(isForbiddenApiError(new ApiError('down', { statusCode: 503 }))).toBe(false)
  })

  it('never reads a `status` field — ApiError does not have one', () => {
    expect(isForbiddenApiError({ status: 403 })).toBe(false)
    expect(isForbiddenApiError(new Error('plain'))).toBe(false)
    expect(isForbiddenApiError(null)).toBe(false)
    expect(apiErrorStatus(undefined)).toBeUndefined()
  })
})
