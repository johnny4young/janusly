/**
 * Trash-expiry math for the Flows "Trash" view.
 *
 * A soft-deleted workflow is hard-purged by the `system:retention` sweep once
 * its tombstone is older than the org's `retention.deletedWorkflowsDays`. This
 * computes the whole days remaining so the Trash row can show "Expires in N
 * days" — a display estimate; the authoritative purge always runs server-side.
 */

/** One day in milliseconds. */
const DAY_MS = 86_400_000;

/**
 * Whole days until a soft-deleted workflow is purged:
 * `ceil((deletedAt + retentionDays - now) / 1 day)`.
 *
 * `ceil` so a partial final day still reads as "1 day" rather than rounding to
 * 0. A value `<= 0` means the retention window has already elapsed (the daily
 * sweep simply hasn't run yet) — the caller renders an "expires soon" state.
 *
 * `nowMs` is injected (not read from `Date.now()` here) so the calculation is
 * pure and deterministically testable.
 */
export function daysUntilPurge(deletedAtIso: string, retentionDays: number, nowMs: number): number {
  const expiresAtMs = new Date(deletedAtIso).getTime() + retentionDays * DAY_MS;
  return Math.ceil((expiresAtMs - nowMs) / DAY_MS);
}
