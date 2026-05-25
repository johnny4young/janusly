/**
 * Typed `fetch` wrapper for the Janusly API. Auto-injects either the
 * Supabase JWT (when a session exists) or the dev-headers fallback
 * (`x-org-id: default` / `x-user-id: dev-user`). Falls offline-cleanly
 * when the API isn't reachable, surfacing a user-friendly message.
 *
 * Used by every async data path in `apps/web/src` (App.tsx, store.ts,
 * components/*).
 *
 * Invariants:
 * - Dev-header values match `apps/api/src/auth.ts`'s expected
 *   header names. Don't drift.
 * - JSON body assumed; binary uploads aren't supported here.
 * - **In-flight dedup is part of the contract.** Two callers issuing
 *   the same `(scope, method, path, body)` tuple while a request is in
 *   flight (and for up to `DEDUP_TTL_MS` after it resolves) share ONE
 *   network round-trip and receive the same payload object. Scope covers
 *   active org + locale + Janusly session token + Supabase access token
 *   because every one of those headers can change the server response.
 *   The Supabase JWT especially carries the user identity — without it
 *   in the key, a fast logout/login within the TTL window could serve
 *   the prior user's response to the new caller. Skipped when the caller
 *   passes an `AbortSignal` (sharing a Promise across abort intents
 *   would silently drop one fetch). For mutating verbs this collapses
 *   an accidental double-click within the window into a single
 *   mutation — intentional double-click prevention.
 */

import { getActiveOrg, getSessionToken, supabase } from './auth'
import { getResolvedLocale, t } from './i18n/runtime'
import { useWorkflowStore } from './store'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'

/**
 * Window during which a resolved (or rejected) in-flight request is
 * still shared with subsequent callers. Picked at 500ms so a burst of
 * panel useEffects firing inside the same React tick (the common
 * `platformVersion`-bump trigger pattern) collapse to one fetch
 * without holding onto stale data across slow navigations.
 */
const DEDUP_TTL_MS = 500

type InFlightEntry = { promise: Promise<unknown>; expiresAt: number }
const inFlight = new Map<string, InFlightEntry>()

type ApiRequestScope = {
  activeOrg: string
  resolvedLocale: string
  sessionToken: string | null
  /**
   * Supabase Bearer JWT (when the user is in Supabase mode, i.e. no
   * SSO session token). Carries the user identity end-to-end — a
   * different access_token means a different user / refreshed token
   * and must NOT share a cached response with the prior call.
   * `null` in SSO mode (sessionToken takes over) and in dev mode
   * (no Supabase configured).
   */
  supabaseAccessToken: string | null
}

/**
 * Build a stable key for the in-flight map. Returns null when the
 * body shape can't be reduced to a string (FormData, Blob, etc.) —
 * the caller treats null as "skip dedup, fall through to a fresh
 * fetch". Functions / BigInt / circular refs reach JSON.stringify on
 * a Record body and the try/catch covers that too.
 */
function dedupKey(scope: ApiRequestScope, method: string, path: string, body: BodyInit | null | undefined): string | null {
  try {
    let serialized: string
    if (body === undefined || body === null) {
      serialized = ''
    } else if (typeof body === 'string') {
      serialized = body
    } else {
      // Non-string BodyInit (FormData, Blob, ArrayBuffer,
      // URLSearchParams, ReadableStream). The web app uses JSON bodies
      // exclusively today, so this branch is defensive — bail out and
      // let the fresh fetch run.
      return null
    }
    return `${scope.activeOrg}:${scope.resolvedLocale}:${scope.sessionToken ?? ''}:${scope.supabaseAccessToken ?? ''}:${method}:${path}:${serialized}`
  } catch {
    return null
  }
}

/**
 * Thrown by `api()` when the server returns a non-2xx body. Carries
 * the stable `code` + structured `params` from the server's
 * `{ error, code, params? }` envelope so call sites can pass the
 * whole error to `tApiError` for client-side translation. Plain `Error`
 * call sites still work — `tApiError` falls back to `message` then to
 * `serverEvents.fallback`.
 */
export class ApiError extends Error {
  /** Stable snake_case code from `apps/api/src/error-codes.ts`. */
  readonly code?: string
  /** Structured interpolation values for `apiErrors.<code>` catalog templates. */
  readonly params?: Record<string, unknown>
  /** HTTP status code (4xx / 5xx). Optional — request-failed paths omit it. */
  readonly statusCode?: number

  constructor(message: string, opts: { code?: string; params?: Record<string, unknown>; statusCode?: number } = {}) {
    super(message)
    this.name = 'ApiError'
    if (opts.code !== undefined) this.code = opts.code
    if (opts.params !== undefined) this.params = opts.params
    if (opts.statusCode !== undefined) this.statusCode = opts.statusCode
  }
}

/**
 * Make an authenticated request to the API; resolves the parsed body or
 * throws on non-2xx.
 *
 * Exception: `POST /start` and `POST /resume` 400 responses whose body matches
 * `{ errors: string[] }` are resolved (not thrown) and returned as-is.
 * This is the field-level validation envelope the API emits when a workflow
 * declares typed `inputs` and the payload doesn't satisfy them — the
 * run-input form needs to surface those errors next to the right field
 * rather than losing them in a toast. Other 400 bodies still throw.
 *
 * Dedup behavior: identical `(scope, method, path, body)` tuples
 * issued while a request is in flight share that fetch and resolve
 * from the same Promise; after the underlying fetch settles (success
 * OR failure) the entry stays shareable for `DEDUP_TTL_MS` and is then
 * evicted. Pass `options.signal` to bypass dedup when caller-specific
 * abort semantics matter.
 */
export async function api(path: string, options: RequestInit = {}): Promise<unknown> {
  const method = (options.method ?? 'GET').toUpperCase()
  const hasSignal = options.signal !== undefined && options.signal !== null
  const sessionToken = getSessionToken()
  // Resolve the Supabase JWT BEFORE building the cache key so user
  // identity is part of the dedup tuple. In Supabase v2 the hot path
  // resolves synchronously from the in-memory cache (no network round
  // trip), so the extra `await` costs microseconds. SSO mode + dev
  // mode skip this branch entirely.
  const supabaseAccessToken = !sessionToken && supabase
    ? (await supabase.auth.getSession()).data.session?.access_token ?? null
    : null
  const requestScope: ApiRequestScope = {
    activeOrg: getActiveOrg(),
    resolvedLocale: getResolvedLocale(),
    sessionToken,
    supabaseAccessToken,
  }
  const key = hasSignal ? null : dedupKey(requestScope, method, path, options.body)

  if (key !== null) {
    const cached = inFlight.get(key)
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.promise
    }
  }

  const promise = doApiFetch(path, options, requestScope)

  if (key !== null) {
    const entry: InFlightEntry = { promise, expiresAt: Number.POSITIVE_INFINITY }
    inFlight.set(key, entry)
    // Settle the TTL once the request resolves OR rejects. The catch
    // swallow only protects the chained .finally — the original
    // rejection still surfaces to every awaiter via the shared
    // Promise above.
    promise
      .catch(() => undefined)
      .finally(() => {
        entry.expiresAt = Date.now() + DEDUP_TTL_MS
        // Schedule a single eviction so the map doesn't accumulate
        // stale entries across the SPA's lifetime. Identity check
        // protects a NEW entry that may have replaced this one during
        // the TTL window.
        setTimeout(() => {
          const current = inFlight.get(key)
          if (current === entry) inFlight.delete(key)
        }, DEDUP_TTL_MS)
      })
  }

  return promise
}

/**
 * Internal helper — the actual auth resolution + fetch + envelope
 * handling that used to live directly inside `api()`. Extracted so
 * the dedup wrapper can cache the resulting Promise without changing
 * the existing behavior.
 */
async function doApiFetch(path: string, options: RequestInit, requestScope: ApiRequestScope): Promise<unknown> {
  // SSO-issued Janusly session token wins over Supabase JWT — when the
  // user logged in via WorkOS, the callback set this localStorage entry
  // and the API's `extractJanuslySession` provider reads it as the 4th
  // auth mode. Both tokens were resolved into `requestScope` by the
  // outer `api()` so the cache key and these headers see the same
  // snapshot (no second `supabase.auth.getSession()` call here).
  const sessionToken = requestScope.sessionToken
  const token = requestScope.supabaseAccessToken

  // `x-org-id` ships on every request — it's the scope hint the API
  // resolver uses to pick a membership when the user belongs to multiple
  // orgs. In dev mode (no Supabase / no SSO) it's the authoritative org.
  // In Supabase mode it's an untrusted hint — the API resolves the actual
  // grant through `org_members`. With an SSO session, the token's
  // signed payload already carries orgId.
  const headers = {
    'Content-Type': 'application/json',
    'x-org-id': requestScope.activeOrg,
    // The API's AI helpers (`/ai/patch-workflow`, `/ai/suggest-improvement`,
    // `/ai/explain-workflow`, `/ai/explain-run`, `/ai/review-workflow`)
    // read this header (`apps/api/src/locale.ts:localeFromRequest`) and
    // append a one-line "respond in <language>" instruction to the LLM
    // system prompt so the operator-facing free-form fields (rationale,
    // explanation, message) come back in the user's UI locale. Other
    // routes ignore the header.
    'Accept-Language': requestScope.resolvedLocale,
    ...(sessionToken ? { 'x-janusly-session': sessionToken } : {}),
    ...(!sessionToken && token ? { Authorization: `Bearer ${token}` } : {}),
    ...(!sessionToken && !token ? { 'x-user-id': 'dev-user' } : {}),
    ...(options.headers ?? {})
  }

  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, { ...options, headers })
  } catch {
    throw new Error(t('api.error.offline') as string)
  }
  const payload = await res.json().catch(() => ({}))

  if (!res.ok) {
    if ((path === '/start' || path === '/resume') && res.status === 400 && isFieldErrorEnvelope(payload)) {
      return payload
    }
    // AI cost budget block — surface the envelope in the store so the
    // top-of-canvas BudgetBlockedBanner can render. We still throw so the
    // calling code's error-handling path runs; the banner is an additive
    // signal alongside the toast / inline error.
    if (res.status === 402 && payload && typeof payload === 'object' && 'budget' in payload) {
      try {
        const setter = useWorkflowStore.getState().setBudgetBlocked
        setter((payload as { budget?: unknown }).budget as Parameters<typeof setter>[0])
      } catch {
        // Non-fatal — the throw below still surfaces the original 402.
      }
    }
    const message = typeof payload?.error === 'string' ? payload.error : t('api.error.requestFailed', { status: res.status }) as string
    // Preserve the structured envelope on the thrown error so toast
    // call sites can translate via `tApiError(err)`. Plain string-message
    // consumers (`err.message`) keep working unchanged — the new fields
    // are additive.
    const code = typeof payload?.code === 'string' ? payload.code : undefined
    const rawParams = payload?.params
    const params = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
      ? (rawParams as Record<string, unknown>)
      : undefined
    throw new ApiError(message, { code, params, statusCode: res.status })
  }

  return payload
}

function isFieldErrorEnvelope(value: unknown): value is { errors: string[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { errors?: unknown }).errors) &&
    (value as { errors: unknown[] }).errors.every((entry) => typeof entry === 'string')
  )
}

/**
 * Test-only: clear the in-flight dedup map. Tests that simulate
 * sequential cases without advancing fake timers past `DEDUP_TTL_MS`
 * call this in `afterEach` so a previous case's cached entry doesn't
 * bleed into the next one.
 *
 * @internal — not part of the public surface; production code never
 * imports this.
 */
export function __resetInFlightForTests(): void {
  inFlight.clear()
}

/**
 * Download a file from the API using the same auth resolution as
 * `api()`. The API's `Content-Disposition: attachment; filename=...`
 * header carries the suggested filename; if the caller passes
 * `filename`, it overrides that. The Blob + anchor click pattern
 * sidesteps the browser's "open in tab" default for text MIME types.
 *
 * Deliberately NOT dedup-wrapped — downloads are intentional
 * user-initiated actions, two clicks should produce two downloads.
 */
export async function downloadFromApi(path: string, filename?: string): Promise<void> {
  const sessionToken = getSessionToken()
  const session = !sessionToken && supabase
    ? await supabase.auth.getSession()
    : { data: { session: null } }
  const token = session.data.session?.access_token

  const headers = {
    'x-org-id': getActiveOrg(),
    ...(sessionToken ? { 'x-janusly-session': sessionToken } : {}),
    ...(!sessionToken && token ? { Authorization: `Bearer ${token}` } : {}),
    ...(!sessionToken && !token ? { 'x-user-id': 'dev-user' } : {}),
  }

  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, { headers })
  } catch {
    throw new Error(t('api.error.offline') as string)
  }

  if (!res.ok) {
    let errorMessage = t('api.error.downloadFailed', { status: res.status }) as string
    try {
      const payload = await res.json()
      if (typeof payload?.error === 'string') errorMessage = payload.error
    } catch {
      // Not JSON — keep the generic message.
    }
    throw new Error(errorMessage)
  }

  const blob = await res.blob()

  // Prefer caller-supplied filename. Otherwise read from
  // Content-Disposition: prefer the RFC 5987 `filename*=UTF-8''<encoded>`
  // form (carries non-ASCII names safely), fall back to the plain
  // `filename="..."` ASCII variant. The server's `Access-Control-Expose-Headers`
  // setting is what makes this header readable from JS — without it
  // the browser hides cross-origin response headers and this helper
  // falls through to the generic 'download.bin' name.
  let resolvedFilename = filename
  if (!resolvedFilename) {
    const disposition = res.headers.get('Content-Disposition') ?? ''
    const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
    if (utf8Match?.[1]) {
      try {
        resolvedFilename = decodeURIComponent(utf8Match[1])
      } catch {
        resolvedFilename = utf8Match[1]
      }
    } else {
      const asciiMatch = /filename="([^"]+)"/.exec(disposition)
      resolvedFilename = asciiMatch?.[1]
    }
    if (!resolvedFilename) resolvedFilename = 'download.bin'
  }

  const objectUrl = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = resolvedFilename
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
  }
}
