/**
 * Solution-pack routes — list the code-resident catalog, surface per-org
 * dependency hints, install a pack as a draft workflow, run a one-click
 * sandbox sample, and inject a demo failure to drive the recovery loop.
 *
 * Five routes:
 *   - `GET  /solution-packs`                      (viewer, packs.read)    — catalog
 *   - `GET  /solution-packs/:id`                  (viewer, packs.read)    — detail + per-org missing deps
 *   - `POST /solution-packs/:id/sample-run`       (editor, packs.install) — sandbox sample run
 *   - `POST /solution-packs/:id/inject-failure`   (editor, packs.install) — seed a demo DLQ failure
 *   - `POST /workflows/import-pack`               (editor, packs.install) — install as a draft workflow
 *
 * Multi-tenant: every install / sample / inject / dependency-diff is
 * scoped to `auth.orgId`. The catalog itself is org-agnostic code.
 *
 * Install NEVER auto-creates credentials or org-configs — it returns
 * `{ missingCredentials, missingOrgConfigs }` so the operator knows what
 * to provide. Only the operator-chosen credential `name` + `kind` ride the
 * wire; a secret value / env-var name never does (mirrors the
 * credential-health posture).
 *
 * Install validates the pack's workflow through the SAME gate the
 * canonical `/workflows/save` route uses (`validateWorkflow` +
 * `WorkflowSchema.parse`) — NOT `sanitizeAiWorkflow`, which is the
 * untrusted-LLM-output cleaner; packs are trusted, pre-validated code.
 */

import { z } from "zod";

import {
  getSolutionPack,
  listPublicSolutionPacks,
  toPublicPack,
  type RequiredCredential,
  type RequiredOrgConfig,
  type SolutionPack,
} from "@janusly/solution-packs";
import { getCredentialByName, listOrgConfig } from "@janusly/data";
import { validateWorkflow } from "@janusly/engine/src/workflow-validation";
import { startSandboxRun } from "@janusly/engine/src/adapters/sandbox-run";
import { injectSampleFailure } from "@janusly/engine/src/adapters/sample-failure";
import { WorkflowSchema } from "@janusly/shared";

import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { errorEnvelope } from "../error-codes";
import { asRecord, readJson, sendJson } from "../http";
import { saveWorkflowVersion } from "../workflows-save";
import type { Route } from "../routes";

const ImportPackBodySchema = z.object({
  packId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120).optional(),
});

const SampleRunBodySchema = z.object({
  samplePayloadId: z.string().trim().min(1).optional(),
});

const InjectFailureBodySchema = z.object({
  fixtureId: z.string().trim().min(1).optional(),
});

/** Pull the `<id>` out of `/solution-packs/<id>[/...]`, query-stripped. */
function packIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const path = url.split("?")[0] ?? "";
  if (!path.startsWith("/solution-packs/")) return null;
  const raw = path.slice("/solution-packs/".length).split("/")[0] ?? "";
  return raw.length > 0 ? raw : null;
}

/** Match exactly `/solution-packs/<id>` (one segment). */
function matchPackDetail(url: string): boolean {
  if (!url.startsWith("/solution-packs/")) return false;
  const rest = url.slice("/solution-packs/".length).split("?")[0];
  const segments = rest.split("/");
  return segments.length === 1 && segments[0].length > 0;
}

/** Match `/solution-packs/<id>/<action>`. */
function matchPackAction(action: string): (url: string) => boolean {
  return (url) => {
    if (!url.startsWith("/solution-packs/")) return false;
    const rest = url.slice("/solution-packs/".length).split("?")[0];
    const segments = rest.split("/");
    return segments.length === 2 && segments[0].length > 0 && segments[1] === action;
  };
}

/**
 * Diff a pack's declared dependencies against the org. A credential is
 * "missing" when no `(kind, name)` row exists; an org-config key is
 * "missing" when the org hasn't explicitly set it (relying on a default).
 * NEVER reads a credential `secretRef` — only the operator-chosen name/kind.
 */
async function computeMissingDeps(
  orgId: string,
  pack: SolutionPack,
): Promise<{ missingCredentials: RequiredCredential[]; missingOrgConfigs: RequiredOrgConfig[] }> {
  const missingCredentials: RequiredCredential[] = [];
  for (const cred of pack.requiredCredentials) {
    const found = await getCredentialByName(orgId, cred.kind, cred.name);
    if (!found) missingCredentials.push(cred);
  }

  let missingOrgConfigs: RequiredOrgConfig[] = pack.requiredOrgConfigs;
  if (pack.requiredOrgConfigs.length > 0) {
    const entries = await listOrgConfig(orgId);
    const tenantSet = new Set(entries.filter((e) => e.source === "tenant").map((e) => e.key));
    missingOrgConfigs = pack.requiredOrgConfigs.filter((c) => !tenantSet.has(c.key));
  }

  return { missingCredentials, missingOrgConfigs };
}

export const solutionPacksRoutes: Route[] = [
  // Two-segment action routes MUST precede the bare `/solution-packs/:id`
  // matcher so the first-match-wins dispatcher doesn't treat the action as
  // an id.
  {
    method: "POST",
    match: matchPackAction("sample-run"),
    role: "editor",
    permission: "packs.install",
    handler: async ({ req, res, auth }) => {
      const id = packIdFromUrl(req.url);
      const pack = id ? getSolutionPack(id) : null;
      if (!pack) return sendJson(res, errorEnvelope("pack_not_found", "Solution pack not found"), 404);

      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parsed = SampleRunBodySchema.safeParse(body);
      if (!parsed.success) {
        return sendJson(res, { error: "invalid sample-run body", issues: parsed.error.issues }, 422);
      }

      const sample = parsed.data.samplePayloadId
        ? pack.samplePayloads.find((s) => s.id === parsed.data.samplePayloadId)
        : pack.samplePayloads[0];
      if (!sample) {
        return sendJson(
          res,
          errorEnvelope("pack_missing_sample_payload", "No matching sample payload for this pack"),
          400,
        );
      }

      const { runId } = await startSandboxRun({
        orgId: auth.orgId,
        workflow: pack.workflowJson,
        input: sample.input,
        createdBy: auth.userId,
        source: `pack:${pack.id}`,
      });

      await auditAction(auth, "solution_pack.sample_run_started", {
        targetType: "solution_pack",
        targetId: pack.id,
        metadata: { packId: pack.id, samplePayloadId: sample.id, runId },
      });

      return sendJson(res, { runId, samplePayloadId: sample.id });
    },
  },
  {
    method: "POST",
    match: matchPackAction("inject-failure"),
    role: "editor",
    permission: "packs.install",
    handler: async ({ req, res, auth }) => {
      const id = packIdFromUrl(req.url);
      const pack = id ? getSolutionPack(id) : null;
      if (!pack) return sendJson(res, errorEnvelope("pack_not_found", "Solution pack not found"), 404);

      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parsed = InjectFailureBodySchema.safeParse(body);
      if (!parsed.success) {
        return sendJson(res, { error: "invalid inject-failure body", issues: parsed.error.issues }, 422);
      }

      const fixture = parsed.data.fixtureId
        ? pack.failureFixtures.find((f) => f.id === parsed.data.fixtureId)
        : pack.failureFixtures[0];
      if (!fixture) {
        return sendJson(
          res,
          errorEnvelope("pack_no_failure_fixture", "No matching failure fixture for this pack"),
          400,
        );
      }

      const { runId, deadLetterId } = await injectSampleFailure({
        orgId: auth.orgId,
        createdBy: auth.userId,
        workflow: pack.workflowJson,
        failedNodeId: fixture.failedNodeId,
        errorJson: fixture.errorJson,
      });

      await auditAction(auth, "solution_pack.failure_injected", {
        targetType: "solution_pack",
        targetId: pack.id,
        metadata: {
          packId: pack.id,
          fixtureId: fixture.id,
          failedNodeId: fixture.failedNodeId,
          runId,
          deadLetterId,
        },
      });

      return sendJson(res, { runId, deadLetterId, fixtureId: fixture.id });
    },
  },
  {
    method: "GET",
    match: matchPackDetail,
    role: "viewer",
    permission: "packs.read",
    handler: async ({ req, res, auth }) => {
      const id = packIdFromUrl(req.url);
      const pack = id ? getSolutionPack(id) : null;
      if (!pack) return sendJson(res, errorEnvelope("pack_not_found", "Solution pack not found"), 404);

      const { missingCredentials, missingOrgConfigs } = await computeMissingDeps(auth.orgId, pack);
      return sendJson(res, { pack: toPublicPack(pack), missingCredentials, missingOrgConfigs });
    },
  },
  {
    method: "GET",
    match: (url) => url === "/solution-packs" || url.startsWith("/solution-packs?"),
    role: "viewer",
    permission: "packs.read",
    handler: async ({ res }) => {
      return sendJson(res, { packs: listPublicSolutionPacks() });
    },
  },
  {
    method: "POST",
    match: (url) => url === "/workflows/import-pack" || url.startsWith("/workflows/import-pack?"),
    role: "editor",
    permission: "packs.install",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parsed = ImportPackBodySchema.safeParse(body);
      if (!parsed.success) {
        return sendJson(res, { error: "invalid import-pack body", issues: parsed.error.issues }, 422);
      }

      const pack = getSolutionPack(parsed.data.packId);
      if (!pack) return sendJson(res, errorEnvelope("pack_not_found", "Solution pack not found"), 404);

      // Copy-on-use: mint a FRESH workflow each install (id stripped so the
      // save chokepoint generates a new id), exactly like template use. Name
      // defaults to the pack name; the operator can rename on save later.
      const draft = WorkflowSchema.parse({
        ...pack.workflowJson,
        id: undefined,
        name: parsed.data.name ?? pack.name,
      });

      // Same structural gate the canonical `/workflows/save` uses. Packs are
      // pre-validated code, so this is defense-in-depth, not the LLM cleaner.
      const validation = validateWorkflow(draft, { strictToolInputs: false });
      if (!validation.valid) {
        return sendJson(res, { error: "pack workflow failed validation", issues: validation.issues }, 422);
      }

      const result = await saveWorkflowVersion({
        orgId: auth.orgId,
        userId: auth.userId,
        parsedWorkflow: draft,
      });
      if (result.kind === "conflict") {
        return sendJson(res, { error: "Concurrent save conflict — please retry", attempts: result.attempts }, 409);
      }

      const { missingCredentials, missingOrgConfigs } = await computeMissingDeps(auth.orgId, pack);

      await auditAction(auth, "workflow.pack_imported", {
        targetType: "workflow",
        targetId: result.workflowId,
        metadata: {
          packId: pack.id,
          packVersion: pack.version,
          version: result.version,
          missingCredentialCount: missingCredentials.length,
          missingOrgConfigCount: missingOrgConfigs.length,
        },
      });

      return sendJson(res, {
        workflowId: result.workflowId,
        versionId: result.versionId,
        version: result.version,
        workflowName: result.workflowName,
        missingCredentials,
        missingOrgConfigs,
      });
    },
  },
];
