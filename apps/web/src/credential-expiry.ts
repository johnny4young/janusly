/**
 * Credential-expiry math for the Credentials panel badge.
 *
 * A credential can carry an operator-declared `expiresAt` (the underlying
 * token/webhook/DSN's expiry). This derives a display status so a row can show
 * "Expires in N days" / "Expired" — a display estimate; the authoritative
 * expiry-warning alert always runs server-side via the `credential.expiring`
 * scan. `nowMs` is injected (not read from `Date.now()` here) so the
 * calculation is pure and deterministically testable.
 */

/** One day in milliseconds. */
const DAY_MS = 86_400_000;

/**
 * Threshold (whole days) at/under which a not-yet-expired credential is flagged
 * "expiring soon" (amber). Purely a UI cue — the actual alert threshold is the
 * per-policy `warnDays`, independent of this.
 */
export const EXPIRY_SOON_DAYS = 14;

/**
 * Expiry display status for a credential.
 * - `kind: 'none'` — no expiry tracked (`expiresAt` null/absent/unparseable).
 * - `kind: 'expired'` — `expiresAt` is at or before `now` (`days <= 0`).
 * - `kind: 'soon'` — expires within `EXPIRY_SOON_DAYS` (`0 < days <= 14`).
 * - `kind: 'ok'` — expires further out.
 * `days` is whole days until expiry via `ceil` (a partial final day reads as 1),
 * omitted for `none`.
 */
export type CredentialExpiryStatus =
  | { kind: 'none' }
  | { kind: 'expired'; days: number }
  | { kind: 'soon'; days: number }
  | { kind: 'ok'; days: number };

export function expiryStatus(expiresAtIso: string | null | undefined, nowMs: number): CredentialExpiryStatus {
  if (!expiresAtIso) return { kind: 'none' };
  const expiresAtMs = new Date(expiresAtIso).getTime();
  if (Number.isNaN(expiresAtMs)) return { kind: 'none' };
  const days = Math.ceil((expiresAtMs - nowMs) / DAY_MS);
  if (days <= 0) return { kind: 'expired', days };
  if (days <= EXPIRY_SOON_DAYS) return { kind: 'soon', days };
  return { kind: 'ok', days };
}
