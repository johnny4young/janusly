/** UI metadata shared with the unchanged request validators. */

export const UPSTREAM_HEALTH_KINDS = [
  'statuspage_io',
  'atlassian_statuspage',
  'http_probe',
  'custom_feed',
] as const

export type UpstreamHealthKind = (typeof UPSTREAM_HEALTH_KINDS)[number]

export const UPSTREAM_COMPONENT_STATUSES = [
  'operational',
  'degraded_performance',
  'partial_outage',
  'major_outage',
  'under_maintenance',
  'unknown',
] as const

export type UpstreamComponentStatus = (typeof UPSTREAM_COMPONENT_STATUSES)[number]

/** Min/max poll interval. Floor of 30s avoids hammering a status page; ceiling
 *  of 1h keeps the derived state meaningfully fresh. */
export const MIN_CHECK_INTERVAL_SECONDS = 30

export const MAX_CHECK_INTERVAL_SECONDS = 60 * 60

export const DEFAULT_CHECK_INTERVAL_SECONDS = 60

/** Cap on the declared component-name list per source. Statuspage components
 *  rarely exceed a handful; the cap bounds the parse work and the persisted
 *  row size. */
export const MAX_EXPECTED_COMPONENTS = 50
