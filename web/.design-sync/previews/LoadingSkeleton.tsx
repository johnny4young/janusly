import { LoadingSkeleton } from '@janusly/web'

/**
 * Shimmer rows that hold the space a list is about to fill, so real content
 * arriving doesn't cause a layout jump. `rows` should approximate the final
 * row count; `label` is the polite live-region announcement.
 */

/** The default: three rows, as most panels use it. */
export function Default() {
  return <LoadingSkeleton label="Loading runs" />
}

/** A short list — credentials, alert policies. */
export function TwoRows() {
  return <LoadingSkeleton rows={2} label="Loading credentials" />
}

/** A long list — the members or audit-log panels. */
export function LongList() {
  return <LoadingSkeleton rows={8} label="Loading audit entries" />
}
