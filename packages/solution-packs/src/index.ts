/**
 * `@janusly/solution-packs` barrel — the code-resident catalog of
 * installable, ICP-shaped workflow starters plus the loader helpers the
 * API routes consume. Mirrors how `apps/api/src/templates.ts` keeps its
 * recipe catalog in code: a pack is NEVER a database row; only the
 * workflow version produced by installing one is persisted.
 *
 * Used by `apps/api/src/routes/solution-packs-routes.ts`.
 *
 * Invariants:
 * - Every `pack.json` is validated through `SolutionPackSchema` at module
 *   load. A malformed pack throws at import time (caught by the package
 *   test) rather than failing silently at request time.
 * - Pack ids are unique (asserted at load).
 */

import { SolutionPackSchema, toPublicPack } from "./types";
import type { SolutionPack, SolutionPackPublic } from "./types";

import failedPaymentRecovery from "./packs/failed-payment-recovery/pack.json";
import incidentTriage from "./packs/incident-triage/pack.json";
import supportEscalation from "./packs/support-escalation/pack.json";

export * from "./types";

/** Raw pack JSON blobs, in catalog display order. */
const RAW_PACKS: readonly unknown[] = [
  failedPaymentRecovery,
  incidentTriage,
  supportEscalation,
];

/**
 * The validated catalog, frozen at module init. Throws if any `pack.json`
 * fails the schema or if two packs share an id.
 */
const SOLUTION_PACKS: readonly SolutionPack[] = (() => {
  const packs = RAW_PACKS.map((raw) => SolutionPackSchema.parse(raw));
  const seen = new Set<string>();
  for (const pack of packs) {
    if (seen.has(pack.id)) {
      throw new Error(`duplicate solution-pack id: ${pack.id}`);
    }
    seen.add(pack.id);
  }
  return Object.freeze(packs);
})();

const SOLUTION_PACKS_BY_ID: ReadonlyMap<string, SolutionPack> = new Map(
  SOLUTION_PACKS.map((pack) => [pack.id, pack]),
);

/** All solution packs, in catalog display order. */
export function listSolutionPacks(): readonly SolutionPack[] {
  return SOLUTION_PACKS;
}

/** Fetch a single pack by id, or null when no pack matches. */
export function getSolutionPack(id: string): SolutionPack | null {
  return SOLUTION_PACKS_BY_ID.get(id) ?? null;
}

/** All packs projected into their catalog-safe public shape. */
export function listPublicSolutionPacks(): SolutionPackPublic[] {
  return SOLUTION_PACKS.map(toPublicPack);
}
