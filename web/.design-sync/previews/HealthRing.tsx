import { HealthRing } from '@janusly/web'

/**
 * The Recovery Center hero's health donut. Colour comes from the health band
 * the score falls into — cobalt ≥80, amber 60–79, red <60 — so the score is
 * the whole API. A null score renders the pending track with no arc.
 */

/** Healthy: cobalt band. */
export function Healthy() {
  return <HealthRing score={94} />
}

/** Degraded: amber band. */
export function Degraded() {
  return <HealthRing score={72} />
}

/** At risk: red band. */
export function AtRisk() {
  return <HealthRing score={41} />
}

/** The three bands side by side, as the score moves across thresholds. */
export function AcrossBands() {
  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
      <HealthRing score={94} />
      <HealthRing score={72} />
      <HealthRing score={41} />
    </div>
  )
}
