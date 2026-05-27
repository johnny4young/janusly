/**
 * Repository for the `prompts` + `prompt_versions` tables — the PromptOps
 * registry. Org-scoped, append-only versions, server-assigned monotonic
 * version numbers, optional "pinned" version for `promptRef`-by-name lookups.
 *
 * Every query filters by `orgId`. There is no helper that bypasses the
 * filter. Cross-org includes (resolver chasing a `{{include.X}}` token)
 * MUST go through `getPromptByName(orgId, name)` so the multi-tenant
 * invariant holds structurally.
 *
 * Used by:
 *   - `apps/api/src/routes/prompts-routes.ts` — REST surface for list /
 *     create / read / create-version / pin-version.
 *   - `packages/engine/src/prompt-resolver.ts` — runtime resolution of
 *     `promptRef: { name, version? }` to a flattened template string.
 *
 * Invariants:
 *   - `prompts.name` is unique per org (DB index).
 *   - `prompt_versions.version` is unique per `(orgId, promptId)` AND is
 *     server-assigned. Clients NEVER pass the version number — the repo
 *     reads the current max + 1 inside the same transaction.
 *   - When `prompts.pinnedVersionId` is non-null, `resolveActiveVersion`
 *     returns that exact row. When null, it returns the highest-`version`
 *     row. When no versions exist, returns `null` and the resolver throws
 *     `NoPromptVersionsError`.
 */

import { and, desc, eq, max } from "drizzle-orm";
import { db, prompts, promptVersions } from "@janusly/db";
import { PromptVariablesSchema, type PromptVariable } from "@janusly/shared";

export type Prompt = typeof prompts.$inferSelect;
export type PromptVersion = typeof promptVersions.$inferSelect;

/**
 * The combined "prompt + active version" record useful for resolution.
 * Returned by `resolveActiveVersion`.
 */
export type ActivePromptVersion = {
  prompt: Prompt;
  version: PromptVersion;
};

/** Maximum total attempts for concurrent prompt-version appends. */
export const MAX_PROMPT_VERSION_ATTEMPTS = 3;

const PG_UNIQUE_VIOLATION = "23505";
const PROMPT_VERSION_RETRYABLE_CONSTRAINTS = [
  "prompt_versions_org_prompt_version_idx",
] as const;

export function isRetryablePromptVersionViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  const seen = new WeakSet<object>();
  let cursor: unknown = err;
  for (let i = 0; i < 5; i += 1) {
    if (!cursor || typeof cursor !== "object" || seen.has(cursor as object)) break;
    seen.add(cursor as object);
    const obj = cursor as { code?: unknown; constraint?: unknown; constraint_name?: unknown; cause?: unknown };
    if (obj.code === PG_UNIQUE_VIOLATION) {
      const constraint = typeof obj.constraint === "string"
        ? obj.constraint
        : typeof obj.constraint_name === "string"
          ? obj.constraint_name
          : null;
      return constraint === null || PROMPT_VERSION_RETRYABLE_CONSTRAINTS.includes(
        constraint as (typeof PROMPT_VERSION_RETRYABLE_CONSTRAINTS)[number],
      );
    }
    const next = obj.cause;
    if (!next || next === cursor) break;
    cursor = next;
  }

  return false;
}

/**
 * List all prompts in the org, ordered by `createdAt DESC`. Capped at 200
 * rows per the project-wide pagination convention; callers needing more
 * should paginate via cursor (deferred to a follow-up — v1 ships the cap).
 */
export async function listPrompts(orgId: string, limit: number = 100): Promise<Prompt[]> {
  const cap = Math.min(Math.max(limit, 1), 200);
  return db
    .select()
    .from(prompts)
    .where(eq(prompts.orgId, orgId))
    .orderBy(desc(prompts.createdAt))
    .limit(cap);
}

/**
 * Fetch a prompt by `(orgId, name)`. Returns `null` when the row does not
 * exist. Multi-tenant scope is enforced via the `orgId` filter — a row
 * from another org is never returned even if the name matches.
 */
export async function getPromptByName(orgId: string, name: string): Promise<Prompt | null> {
  const rows = await db
    .select()
    .from(prompts)
    .where(and(eq(prompts.orgId, orgId), eq(prompts.name, name)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Insert a new prompt. Fails with a unique-constraint error when the
 * org already has a prompt with the same `name`. Callers should surface
 * a 409 to the client when this happens.
 */
export async function createPrompt(params: {
  orgId: string;
  name: string;
  description?: string;
  createdBy: string;
}): Promise<Prompt> {
  const id = crypto.randomUUID();
  await db.insert(prompts).values({
    id,
    orgId: params.orgId,
    name: params.name,
    description: params.description ?? null,
    pinnedVersionId: null,
    createdBy: params.createdBy,
  });
  const inserted = await db
    .select()
    .from(prompts)
    .where(and(eq(prompts.orgId, params.orgId), eq(prompts.id, id)))
    .limit(1);
  if (!inserted[0]) {
    throw new Error("createPrompt: row vanished immediately after insert");
  }
  return inserted[0];
}

/**
 * List versions of a prompt, ordered by `version DESC`. The first row is
 * always the latest version; this is what `resolveActiveVersion` uses
 * when `pinnedVersionId` is null. Capped at 200 rows per the project-wide
 * pagination convention.
 */
export async function listPromptVersions(orgId: string, promptId: string, limit: number = 100): Promise<PromptVersion[]> {
  const cap = Math.min(Math.max(limit, 1), 200);
  return db
    .select()
    .from(promptVersions)
    .where(and(eq(promptVersions.orgId, orgId), eq(promptVersions.promptId, promptId)))
    .orderBy(desc(promptVersions.version))
    .limit(cap);
}

/**
 * Fetch a specific `(orgId, promptId, version)`. Returns `null` when the
 * triple does not exist.
 */
export async function getPromptVersion(
  orgId: string,
  promptId: string,
  version: number,
): Promise<PromptVersion | null> {
  const rows = await db
    .select()
    .from(promptVersions)
    .where(
      and(
        eq(promptVersions.orgId, orgId),
        eq(promptVersions.promptId, promptId),
        eq(promptVersions.version, version),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Fetch a version by id. Used by `resolveActiveVersion` after reading
 * `prompts.pinnedVersionId`. Multi-tenant scope is enforced; a row from
 * another org is never returned.
 */
export async function getPromptVersionById(
  orgId: string,
  versionId: string,
): Promise<PromptVersion | null> {
  const rows = await db
    .select()
    .from(promptVersions)
    .where(and(eq(promptVersions.orgId, orgId), eq(promptVersions.id, versionId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Append a new version to a prompt. The version number is server-assigned:
 * `max(existing) + 1`, starting at 1 for the first version. Callers MUST
 * NOT supply a version number.
 *
 * The `variables` array is validated via the shared `PromptVariablesSchema`
 * before insert — malformed entries surface as a thrown error rather than
 * landing in the JSONB column and breaking resolution later.
 */
export async function createPromptVersion(params: {
  orgId: string;
  promptId: string;
  templateText: string;
  variables: PromptVariable[];
  status?: "draft" | "published";
  createdBy: string;
}): Promise<PromptVersion> {
  // Validate the variables array up-front so a malformed declaration
  // surfaces here rather than at resolve time when an LLM call has
  // already been queued.
  PromptVariablesSchema.parse(params.variables);

  for (let attempt = 1; attempt <= MAX_PROMPT_VERSION_ATTEMPTS; attempt += 1) {
    const id = crypto.randomUUID();
    try {
      return await db.transaction(async (tx) => {
        // Server-assign the next version number. Same `(orgId, promptId)` scope
        // as the unique index; if two transactions compute the same number,
        // the unique index rejects one and the retry re-reads the newer max.
        const currentMaxRow = await tx
          .select({ value: max(promptVersions.version) })
          .from(promptVersions)
          .where(
            and(
              eq(promptVersions.orgId, params.orgId),
              eq(promptVersions.promptId, params.promptId),
            ),
          );
        const nextVersion = (currentMaxRow[0]?.value ?? 0) + 1;

        await tx.insert(promptVersions).values({
          id,
          orgId: params.orgId,
          promptId: params.promptId,
          version: nextVersion,
          templateText: params.templateText,
          variables: params.variables,
          status: params.status ?? "published",
          createdBy: params.createdBy,
        });

        // Bump the parent prompt's `updatedAt` so the list view sorts the
        // recently-versioned prompt to the top.
        await tx
          .update(prompts)
          .set({ updatedAt: new Date() })
          .where(and(eq(prompts.orgId, params.orgId), eq(prompts.id, params.promptId)));

        const inserted = await tx
          .select()
          .from(promptVersions)
          .where(and(eq(promptVersions.orgId, params.orgId), eq(promptVersions.id, id)))
          .limit(1);
        if (!inserted[0]) {
          throw new Error("createPromptVersion: row vanished immediately after insert");
        }
        return inserted[0];
      });
    } catch (err) {
      if (isRetryablePromptVersionViolation(err) && attempt < MAX_PROMPT_VERSION_ATTEMPTS) {
        continue;
      }
      throw err;
    }
  }

  throw new Error("createPromptVersion: exhausted retry attempts");
}

/**
 * Pin a specific version as the active default for `promptRef`-by-name
 * lookups. Idempotent — pinning the same version twice is a no-op. Returns
 * the updated prompt row, or `null` when the prompt or version does not
 * exist in the org.
 */
export async function pinPromptVersion(params: {
  orgId: string;
  promptId: string;
  version: number;
}): Promise<{ prompt: Prompt; previousVersionId: string | null } | null> {
  const targetVersion = await getPromptVersion(params.orgId, params.promptId, params.version);
  if (!targetVersion) return null;

  const existingPrompt = await db
    .select()
    .from(prompts)
    .where(and(eq(prompts.orgId, params.orgId), eq(prompts.id, params.promptId)))
    .limit(1);
  if (!existingPrompt[0]) return null;

  const previousVersionId = existingPrompt[0].pinnedVersionId;

  await db
    .update(prompts)
    .set({ pinnedVersionId: targetVersion.id, updatedAt: new Date() })
    .where(and(eq(prompts.orgId, params.orgId), eq(prompts.id, params.promptId)));

  const updated = await db
    .select()
    .from(prompts)
    .where(and(eq(prompts.orgId, params.orgId), eq(prompts.id, params.promptId)))
    .limit(1);
  if (!updated[0]) {
    throw new Error("pinPromptVersion: prompt row vanished after pin");
  }
  return { prompt: updated[0], previousVersionId };
}

/**
 * Resolve the "active" version for a prompt — pinned-or-latest. Returns
 * `null` when no versions exist; the resolver translates that into a
 * `NoPromptVersionsError` for the caller.
 *
 * Multi-tenant scope: both reads filter by `orgId`. A pinned version that
 * happens to share an id with a row in another org is structurally
 * unreachable.
 */
export async function resolveActiveVersion(
  orgId: string,
  promptId: string,
): Promise<ActivePromptVersion | null> {
  const promptRow = await db
    .select()
    .from(prompts)
    .where(and(eq(prompts.orgId, orgId), eq(prompts.id, promptId)))
    .limit(1);
  if (!promptRow[0]) return null;

  if (promptRow[0].pinnedVersionId) {
    const pinned = await getPromptVersionById(orgId, promptRow[0].pinnedVersionId);
    if (pinned) return { prompt: promptRow[0], version: pinned };
    // Pinned id points at a row outside this org (impossible under the
    // multi-tenant invariant) — fall through to latest as a defensive
    // path so the resolver never returns a cross-org row.
  }

  const latest = await db
    .select()
    .from(promptVersions)
    .where(and(eq(promptVersions.orgId, orgId), eq(promptVersions.promptId, promptId)))
    .orderBy(desc(promptVersions.version))
    .limit(1);
  if (!latest[0]) return null;
  return { prompt: promptRow[0], version: latest[0] };
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "Decision engine / RL".
