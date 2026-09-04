/**
 * Shared reads over `ApiError` (`src/api.ts`). Three components used to carry
 * their own copy of the 403 check and one read `.status` — a field the error
 * never had — so its permission-denied branch was dead and non-readers got a
 * permanent error banner for a feature they cannot use.
 */

export function apiErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined
  const status = (error as { statusCode?: unknown }).statusCode
  return typeof status === 'number' ? status : undefined
}

/** True for the API's permission-denied response, whatever wrapped it. */
export function isForbiddenApiError(error: unknown): boolean {
  return apiErrorStatus(error) === 403
}
