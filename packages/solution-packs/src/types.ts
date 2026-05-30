/**
 * Type + schema contracts for solution packs — installable, ICP-shaped
 * workflow starters that live in code (one folder per pack under
 * `src/packs/`), mirroring how `apps/api/src/templates.ts` keeps its
 * recipe catalog in code. A pack is NEVER persisted as a row; only the
 * workflow version produced by installing it lands in the database.
 *
 * Used by:
 * - `./index.ts` — loads + validates each pack at module init.
 * - `apps/api/src/routes/solution-packs-routes.ts` — list / detail /
 *   import / sample-run / inject-failure.
 *
 * Invariants:
 * - `workflowJson` is validated against the engine's `WorkflowSchema`
 *   shape at load time; the API route additionally runs the structural
 *   `validateWorkflow` graph check before persisting an install.
 * - `requiredCredentials` / `requiredOrgConfigs` are dependency HINTS the
 *   operator must satisfy out of band — installing a pack NEVER creates a
 *   credential or org-config row. Only the operator-chosen credential
 *   `name` + `kind` ride the wire; a secret value / env-var name never does.
 * - Every `failureFixtures[].failedNodeId` must reference a node id that
 *   exists in the same pack's `workflowJson.nodes` (asserted by the
 *   package test — the schema alone can't express the cross-field rule).
 */

import { z } from "zod";
import { WorkflowSchema } from "@janusly/shared";

/**
 * Closed set of ICP categories a pack belongs to. Drives the catalog
 * grouping pill in the web surface; a new ICP means one entry here plus
 * its `packs.category.<value>` i18n key.
 */
export const SOLUTION_PACK_CATEGORIES = [
  "payment_recovery",
  "incident_triage",
  "support_escalation",
] as const;

export const SolutionPackCategorySchema = z.enum(SOLUTION_PACK_CATEGORIES);
export type SolutionPackCategory = (typeof SOLUTION_PACK_CATEGORIES)[number];

/**
 * One credential the pack's workflow references by operator-chosen `name`.
 * `kind` is the `credentials.kind` an operator must have configured (e.g.
 * `slack_webhook`); the install/detail route diffs `(name, kind)` against
 * the org via `getCredentialByName` to flag what's missing. `purpose` is
 * operator-facing copy explaining what the credential is for.
 */
export const RequiredCredentialSchema = z.object({
  name: z.string().trim().min(1),
  kind: z.string().trim().min(1),
  purpose: z.string().trim().min(1),
});
export type RequiredCredential = z.infer<typeof RequiredCredentialSchema>;

/**
 * One org-config key the pack expects to be set (e.g. `email.from`).
 * A hint only — installing never writes org-config rows.
 */
export const RequiredOrgConfigSchema = z.object({
  key: z.string().trim().min(1),
  purpose: z.string().trim().min(1),
});
export type RequiredOrgConfig = z.infer<typeof RequiredOrgConfigSchema>;

/**
 * A bundled trigger payload the operator can fire a one-click sample run
 * against. `input` becomes `runs.inputJson.input`, so node templates that
 * read `{{context.<trigger>.output.*}}` / `{{input.*}}` resolve to it.
 */
export const SamplePayloadSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  input: z.record(z.string(), z.unknown()),
});
export type SamplePayload = z.infer<typeof SamplePayloadSchema>;

/**
 * A known, intentional failure the operator can inject to watch the
 * recovery loop run. `failedNodeId` must exist in the pack's workflow;
 * `errorJson` is the persisted error envelope shape the recovery dialog
 * reads (mirrors `dead_letters.error_json`).
 */
export const FailureFixtureSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  failedNodeId: z.string().trim().min(1),
  errorJson: z.record(z.string(), z.unknown()),
});
export type FailureFixture = z.infer<typeof FailureFixtureSchema>;

/** The full, code-resident definition of one solution pack. */
export const SolutionPackSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]+$/, "pack id must be lowercase kebab-case"),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    category: SolutionPackCategorySchema,
    version: z.string().trim().min(1),
    requiredCredentials: z.array(RequiredCredentialSchema),
    requiredOrgConfigs: z.array(RequiredOrgConfigSchema),
    workflowJson: WorkflowSchema,
    samplePayloads: z.array(SamplePayloadSchema).min(1),
    failureFixtures: z.array(FailureFixtureSchema).min(1),
  })
  .strict();
export type SolutionPack = z.infer<typeof SolutionPackSchema>;

/**
 * The catalog-safe projection returned by `GET /solution-packs` and
 * `GET /solution-packs/:id`. Intentionally omits `workflowJson` and the
 * raw fixture internals (install is server-side by `packId`, so the web
 * never needs the full DAG), keeping the payload small and leaking no
 * internal shapes. The detail route layers `missingCredentials` /
 * `missingOrgConfigs` on top of this shape.
 */
export type SolutionPackPublic = {
  id: string;
  name: string;
  description: string;
  category: SolutionPackCategory;
  version: string;
  requiredCredentials: RequiredCredential[];
  requiredOrgConfigs: RequiredOrgConfig[];
  nodeCount: number;
  sampleCount: number;
  failureCount: number;
  samplePayloadIds: string[];
  failureFixtureIds: string[];
};

/** Pure projection of a pack into its catalog-safe public shape. */
export function toPublicPack(pack: SolutionPack): SolutionPackPublic {
  return {
    id: pack.id,
    name: pack.name,
    description: pack.description,
    category: pack.category,
    version: pack.version,
    requiredCredentials: pack.requiredCredentials,
    requiredOrgConfigs: pack.requiredOrgConfigs,
    nodeCount: pack.workflowJson.nodes.length,
    sampleCount: pack.samplePayloads.length,
    failureCount: pack.failureFixtures.length,
    samplePayloadIds: pack.samplePayloads.map((s) => s.id),
    failureFixtureIds: pack.failureFixtures.map((f) => f.id),
  };
}
