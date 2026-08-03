/**
 * Upstream health awareness contract — closed enums, Zod schemas for the
 * `upstream_health_sources` config, the per-component status vocabulary, and
 * the PURE feed-parsing helpers that map a provider's status JSON onto the
 * closed Janusly status enum.
 *
 * Pure, zero-I/O — safe to import from web bundle + engine + api + data. The
 * background poller in `internal/upstream` fetches
 * the feed through the `fetchHttpTarget` SSRF chokepoint and then calls the
 * parse helper here; the helper itself never touches the network.
 *
 * Used by:
 *  - Backend source storage (CRUD + derived status)
 *  - `internal/upstream` (poll + parse + evaluate)
 *  - `apps/api/src/routes/upstream-health-routes.ts` (admin CRUD + force-run)
 *  - `apps/web/src/components/UpstreamHealthPanel.tsx` (admin form + status list)
 *
 * Invariants:
 *  - `kind` is a closed enum; adding a provider means a new parser branch in
 *    `parseUpstreamFeed` plus (if the wire shape differs) a new parse helper.
 *  - The derived component status is one of the closed `UPSTREAM_COMPONENT_STATUSES`.
 *    `degraded` and `major_outage` are the two "degraded" states that trigger
 *    an auto-pause; everything else is treated as healthy for pause purposes.
 *  - FAIL-OPEN: a parse that finds no matching component, or a feed the parser
 *    cannot read, returns `{ ok: false }` — the caller MUST NOT pause on a
 *    `{ ok: false }` result (an unreachable status page must never amplify an
 *    outage by pausing every tagged workflow).
 */

import { z } from 'zod'

// ---------- provider kind ----------

/**
 * Closed set of upstream feed providers.
 *  - `statuspage_io` / `atlassian_statuspage` — the Statuspage.io hosted-status
 *    JSON shape (`/api/v2/status.json` + `/api/v2/components.json`). Both
 *    constants map to the same parser; the two names let operators label the
 *    source by their vendor without changing the wire format.
 *  - `http_probe` — a plain HTTP GET where a 2xx response means healthy and a
 *    non-2xx (or unreachable) means degraded. No component list applies.
 *  - `custom_feed` — a generic JSON feed exposing a top-level `status` string
 *    (or `{ status }` object) using the Statuspage status vocabulary.
 */
export const UPSTREAM_HEALTH_KINDS = [
  'statuspage_io',
  'atlassian_statuspage',
  'http_probe',
  'custom_feed',
] as const
export const UpstreamHealthKindSchema = z.enum(UPSTREAM_HEALTH_KINDS)
export type UpstreamHealthKind = z.infer<typeof UpstreamHealthKindSchema>

// ---------- component / derived status ----------

/**
 * Closed status vocabulary. Mirrors Statuspage.io's `indicator` /
 * component-status strings so the parser can pass them through directly.
 *  - `operational` — fully healthy.
 *  - `degraded_performance` — partial degradation (Statuspage `minor`).
 *  - `partial_outage` — some functionality down (Statuspage `major` indicator
 *    on a single component).
 *  - `major_outage` — fully down.
 *  - `under_maintenance` — planned maintenance; treated as healthy for pause.
 *  - `unknown` — the feed did not report a status we recognise.
 */
export const UPSTREAM_COMPONENT_STATUSES = [
  'operational',
  'degraded_performance',
  'partial_outage',
  'major_outage',
  'under_maintenance',
  'unknown',
] as const
export const UpstreamComponentStatusSchema = z.enum(UPSTREAM_COMPONENT_STATUSES)
export type UpstreamComponentStatus = z.infer<typeof UpstreamComponentStatusSchema>

/**
 * The two derived statuses that trigger an auto-pause of tagged workflows.
 * The AC names `degraded` and `major_outage`; we map Statuspage's richer
 * vocabulary down: `degraded_performance` and `partial_outage` count as
 * "degraded", `major_outage` is its own state, and everything else
 * (`operational` / `under_maintenance` / `unknown`) is NOT a pause trigger.
 */
export function isDegradedStatus(status: UpstreamComponentStatus): boolean {
  return (
    status === 'degraded_performance' ||
    status === 'partial_outage' ||
    status === 'major_outage'
  )
}

// ---------- config schema ----------

/** Min/max poll interval. Floor of 30s avoids hammering a status page; ceiling
 *  of 1h keeps the derived state meaningfully fresh. */
export const MIN_CHECK_INTERVAL_SECONDS = 30
export const MAX_CHECK_INTERVAL_SECONDS = 60 * 60
export const DEFAULT_CHECK_INTERVAL_SECONDS = 60

/** Cap on the declared component-name list per source. Statuspage components
 *  rarely exceed a handful; the cap bounds the parse work and the persisted
 *  row size. */
export const MAX_EXPECTED_COMPONENTS = 50

/**
 * Operator-supplied config for one upstream health source. `name` is the join
 * key: a workflow declares `upstreamHealthSources: [name, ...]` and the poller
 * pauses every workflow tagged with this source's name when a referenced
 * component flips degraded.
 *
 * `expectedComponents` is the closed list of component display-names the
 * operator cares about. An empty list means "watch the overall indicator"
 * (the top-level Statuspage `status.indicator`), which is the right default
 * for `http_probe` / `custom_feed` and for operators who only care about the
 * page-level rollup.
 */
export const UpstreamHealthSourceConfigSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/, {
      message:
        'name must start alphanumeric and contain only letters, numbers, spaces, dots, underscores, or hyphens',
    }),
  kind: UpstreamHealthKindSchema,
  url: z
    .string()
    .trim()
    .url()
    .max(2048)
    .refine((u) => u.startsWith('https://') || u.startsWith('http://'), {
      message: 'url must be an http(s) URL',
    }),
  expectedComponents: z
    .array(z.string().trim().min(1).max(120))
    .max(MAX_EXPECTED_COMPONENTS)
    .default([]),
  checkIntervalSeconds: z
    .number()
    .int()
    .min(MIN_CHECK_INTERVAL_SECONDS)
    .max(MAX_CHECK_INTERVAL_SECONDS)
    .default(DEFAULT_CHECK_INTERVAL_SECONDS),
  enabled: z.boolean().default(true),
})
export type UpstreamHealthSourceConfig = z.infer<typeof UpstreamHealthSourceConfigSchema>

/** POST body for create/update — the config plus an optional id for upsert. */
export const UpsertUpstreamHealthSourceBodySchema = z.object({
  source: UpstreamHealthSourceConfigSchema,
})
export type UpsertUpstreamHealthSourceBody = z.infer<
  typeof UpsertUpstreamHealthSourceBodySchema
>

/**
 * The `workflow_versions.upstreamHealthSources` tag list — a bounded array of
 * source names a workflow subscribes to. Lives on its own column (not the DAG
 * JSON), so the save route validates the raw save-body field against this
 * schema. Capped at the same `MAX_EXPECTED_COMPONENTS` to bound the row size.
 */
export const UpstreamHealthSourceTagsSchema = z
  .array(z.string().trim().min(1).max(80))
  .max(MAX_EXPECTED_COMPONENTS)
export type UpstreamHealthSourceTags = z.infer<typeof UpstreamHealthSourceTagsSchema>

// ---------- feed parsing (PURE) ----------

/**
 * Result of mapping a provider's status JSON onto the closed Janusly status
 * vocabulary.
 *  - `ok: true` — the feed was readable and a status was derived. `degraded`
 *    is the load-bearing field: when true, the poller pauses tagged workflows.
 *  - `ok: false` — the feed could not be parsed, or a declared component was
 *    not found. FAIL-OPEN: the caller MUST treat this as "do not pause".
 */
export type UpstreamFeedParseResult =
  | {
      ok: true
      /** Overall derived status across the watched components (worst wins). */
      status: UpstreamComponentStatus
      /** Whether the derived status is a pause trigger. */
      degraded: boolean
      /** Per-component breakdown for the watched components (empty when watching the page-level indicator). */
      components: { name: string; status: UpstreamComponentStatus }[]
    }
  | {
      ok: false
      /** Closed-enum reason so the poller can audit without leaking feed body. */
      reason:
        | 'unparseable'
        | 'component_not_found'
        | 'no_status'
        | 'unsupported_kind'
    }

/**
 * Map a single Statuspage component-status / indicator string onto the closed
 * Janusly status enum. Returns `unknown` for anything unrecognised so the
 * fail-open path applies (unknown is NOT degraded).
 */
export function mapStatuspageStatus(raw: unknown): UpstreamComponentStatus {
  if (typeof raw !== 'string') return 'unknown'
  switch (raw.trim().toLowerCase()) {
    case 'operational':
    case 'none': // top-level indicator value for "all good"
      return 'operational'
    case 'degraded_performance':
    case 'minor': // top-level indicator value
      return 'degraded_performance'
    case 'partial_outage':
      return 'partial_outage'
    case 'major_outage':
    case 'major': // top-level indicator value
    case 'critical': // top-level indicator value
      return 'major_outage'
    case 'under_maintenance':
    case 'maintenance':
      return 'under_maintenance'
    default:
      return 'unknown'
  }
}

/** Pick the worse of two statuses (operational < maintenance < unknown <
 *  degraded < partial < major). Used to roll multiple watched components into
 *  one overall status. */
const STATUS_SEVERITY: Record<UpstreamComponentStatus, number> = {
  operational: 0,
  under_maintenance: 1,
  unknown: 2,
  degraded_performance: 3,
  partial_outage: 4,
  major_outage: 5,
}
function worse(
  a: UpstreamComponentStatus,
  b: UpstreamComponentStatus,
): UpstreamComponentStatus {
  return STATUS_SEVERITY[a] >= STATUS_SEVERITY[b] ? a : b
}

/**
 * Parse a Statuspage.io `components.json` / `status.json` payload.
 *
 * When `expectedComponents` is non-empty, every declared component MUST be
 * present in the feed's `components` array (matched case-insensitively on
 * `name`). A missing component returns `{ ok: false, reason: "component_not_found" }`
 * — fail-open, because a renamed/removed component is an operator-config drift
 * we should surface rather than silently pause on.
 *
 * When `expectedComponents` is empty, the top-level `status.indicator` is used
 * (status.json shape). When neither a component list nor a top-level indicator
 * is present, returns `{ ok: false, reason: "no_status" }`.
 */
export function parseStatuspageFeed(
  json: unknown,
  expectedComponents: readonly string[],
): UpstreamFeedParseResult {
  if (!json || typeof json !== 'object') {
    return { ok: false, reason: 'unparseable' }
  }
  const obj = json as Record<string, unknown>

  // Component-scoped evaluation.
  if (expectedComponents.length > 0) {
    const rawComponents = obj.components
    if (!Array.isArray(rawComponents)) {
      return { ok: false, reason: 'unparseable' }
    }
    const byLowerName = new Map<string, UpstreamComponentStatus>()
    for (const c of rawComponents) {
      if (!c || typeof c !== 'object') continue
      const name = (c as Record<string, unknown>).name
      const status = (c as Record<string, unknown>).status
      if (typeof name !== 'string') continue
      byLowerName.set(name.trim().toLowerCase(), mapStatuspageStatus(status))
    }
    const components: { name: string; status: UpstreamComponentStatus }[] = []
    let overall: UpstreamComponentStatus = 'operational'
    for (const wanted of expectedComponents) {
      const found = byLowerName.get(wanted.trim().toLowerCase())
      if (found === undefined) {
        return { ok: false, reason: 'component_not_found' }
      }
      components.push({ name: wanted, status: found })
      overall = worse(overall, found)
    }
    return { ok: true, status: overall, degraded: isDegradedStatus(overall), components }
  }

  // Page-level indicator (status.json shape).
  const statusBlock = obj.status
  const indicator =
    statusBlock && typeof statusBlock === 'object'
      ? (statusBlock as Record<string, unknown>).indicator
      : undefined
  if (indicator === undefined) {
    return { ok: false, reason: 'no_status' }
  }
  const mapped = mapStatuspageStatus(indicator)
  return { ok: true, status: mapped, degraded: isDegradedStatus(mapped), components: [] }
}

/**
 * Parse a `custom_feed` JSON payload: a top-level `status` string (or a nested
 * `{ status }`) using the Statuspage status vocabulary.
 */
export function parseCustomFeed(json: unknown): UpstreamFeedParseResult {
  if (!json || typeof json !== 'object') {
    return { ok: false, reason: 'unparseable' }
  }
  const raw = (json as Record<string, unknown>).status
  if (raw === undefined) {
    return { ok: false, reason: 'no_status' }
  }
  const mapped = mapStatuspageStatus(raw)
  if (mapped === 'unknown') {
    return { ok: false, reason: 'no_status' }
  }
  return { ok: true, status: mapped, degraded: isDegradedStatus(mapped), components: [] }
}

/**
 * Derive the status of an `http_probe` source from the HTTP response status.
 * 2xx → operational; anything else → major_outage. Network/timeout failures
 * are handled by the poller (which treats a thrown fetch as fail-open), so
 * this only sees a status code.
 */
export function parseHttpProbe(statusCode: number): UpstreamFeedParseResult {
  if (statusCode >= 200 && statusCode < 300) {
    return { ok: true, status: 'operational', degraded: false, components: [] }
  }
  return { ok: true, status: 'major_outage', degraded: true, components: [] }
}

/**
 * Dispatch a parsed JSON body (or HTTP status for probes) to the right parser
 * for the source's `kind`. The poller is responsible for the network fetch and
 * for the fail-open behaviour on a thrown/unreachable feed.
 */
export function parseUpstreamFeed(args: {
  kind: UpstreamHealthKind
  expectedComponents: readonly string[]
  /** Parsed JSON body, for the JSON-shaped kinds. */
  json?: unknown
  /** HTTP status code, for `http_probe`. */
  statusCode?: number
}): UpstreamFeedParseResult {
  switch (args.kind) {
    case 'statuspage_io':
    case 'atlassian_statuspage':
      return parseStatuspageFeed(args.json, args.expectedComponents)
    case 'custom_feed':
      return parseCustomFeed(args.json)
    case 'http_probe':
      return parseHttpProbe(args.statusCode ?? 0)
    default:
      return { ok: false, reason: 'unsupported_kind' }
  }
}
