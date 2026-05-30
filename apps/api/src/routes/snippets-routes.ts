/**
 * Workflow snippets library routes — list built-in + org-private snippets,
 * admin CRUD over the custom rows, and an audit beacon for insertions.
 *
 * Five routes:
 *   - `GET    /snippets`              (viewer, snippets.read)  — built-ins ∪ custom
 *   - `POST   /snippets`              (admin,  snippets.write) — create custom
 *   - `POST   /snippets/:id`          (admin,  snippets.write) — update (POST-as-update)
 *   - `DELETE /snippets/:id`          (admin,  snippets.write) — delete custom
 *   - `POST   /snippets/:id/inserted` (editor, snippets.read)  — audit `snippet.inserted`
 *
 * `POST /snippets/:id` is the update verb — the codebase's `Route.method`
 * enum is closed to GET/POST/DELETE, so we follow the
 * `/upstream/sources/:id` / `/mcp/connections/:alias` POST-as-update
 * convention.
 *
 * Built-in snippets ship in CODE (`@janusly/shared:BUILTIN_SNIPPETS`) and
 * are NEVER persisted — the GET concatenates them ahead of the custom
 * rows, and every mutating route rejects a `builtin:` id with 409
 * `snippet_builtin_immutable`. A snippet never runs standalone; insertion
 * is a pure client-side delta (`insertSnippet`) on the editing canvas, so
 * the `:id/inserted` route is an audit beacon only — it persists nothing.
 *
 * Multi-tenant scope: every custom-snippet query carries
 * `eq(snippets.orgId, auth.orgId)` inside the repo.
 */

import {
  BUILTIN_SNIPPETS,
  CreateSnippetBodySchema,
  isBuiltinSnippetId,
  UpdateSnippetBodySchema,
} from "@janusly/shared";
import {
  createSnippet,
  deleteSnippet,
  findSnippetByName,
  getSnippetById,
  listSnippets,
  updateSnippet,
} from "@janusly/data";

import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { errorEnvelope } from "../error-codes";
import { asRecord, readJson, sendJson } from "../http";
import type { Route } from "../routes";

/** Match `/snippets/<id>` (single segment, no trailing path). */
function matchSnippetById(url: string): boolean {
  if (!url.startsWith("/snippets/")) return false;
  const rest = url.slice("/snippets/".length).split("?")[0];
  const segments = rest.split("/");
  return segments.length === 1 && segments[0].length > 0;
}

/** Match `/snippets/<id>/inserted`. */
function matchSnippetInserted(url: string): boolean {
  if (!url.startsWith("/snippets/")) return false;
  const rest = url.slice("/snippets/".length).split("?")[0];
  const segments = rest.split("/");
  return segments.length === 2 && segments[1] === "inserted" && segments[0].length > 0;
}

function snippetIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const path = url.split("?")[0] ?? "";
  if (!path.startsWith("/snippets/")) return null;
  // The id is the first segment; decode it because built-in ids carry a
  // `:` separator that clients URL-encode (`builtin%3Aretry-with-backoff`).
  const raw = path.slice("/snippets/".length).split("/")[0] ?? "";
  if (!raw) return null;
  try {
    return decodeURIComponent(raw) || null;
  } catch {
    return raw || null;
  }
}

function invalidBody(
  res: Parameters<Route["handler"]>[0]["res"],
  issues: readonly { path: PropertyKey[]; message: string }[],
) {
  return sendJson(
    res,
    {
      error: "invalid snippet body",
      code: "snippet_invalid",
      issues: issues.map((iss) => ({ path: iss.path.map(String).join("."), message: iss.message })),
    },
    422,
  );
}

export const snippetsRoutes: Route[] = [
  // Insertion beacon MUST come before the bare `/snippets/:id` matcher so the
  // first-match-wins dispatcher doesn't treat "inserted" as an id.
  {
    method: "POST",
    match: matchSnippetInserted,
    role: "editor",
    permission: "snippets.read",
    handler: async ({ req, res, auth }) => {
      const id = snippetIdFromUrl(req.url);
      if (!id) return sendJson(res, { error: "snippet id required" }, 400);

      // Confirm the snippet exists (built-in or custom in this org) so the
      // audit beacon can't be spoofed with an arbitrary id.
      const exists = isBuiltinSnippetId(id)
        ? BUILTIN_SNIPPETS.some((snippet) => snippet.id === id)
        : Boolean(await getSnippetById(auth.orgId, id));
      if (!exists) {
        return sendJson(res, errorEnvelope("snippet_not_found", "Snippet not found"), 404);
      }

      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const workflowId = typeof body.workflowId === "string" ? body.workflowId : null;
      const insertedNodeCount =
        typeof body.insertedNodeCount === "number" ? body.insertedNodeCount : null;

      await auditAction(auth, "snippet.inserted", {
        targetType: "snippet",
        targetId: id,
        metadata: { snippetId: id, builtin: isBuiltinSnippetId(id), workflowId, insertedNodeCount },
      });

      return sendJson(res, { ok: true });
    },
  },
  {
    method: "GET",
    match: (url) => url === "/snippets" || url.startsWith("/snippets?"),
    role: "viewer",
    permission: "snippets.read",
    handler: async ({ res, auth }) => {
      const custom = await listSnippets(auth.orgId);
      // Built-ins lead so they're stable in the picker regardless of how
      // many custom snippets the org has authored.
      return sendJson(res, { snippets: [...BUILTIN_SNIPPETS, ...custom] });
    },
  },
  {
    method: "POST",
    match: (url) => url === "/snippets" || url.startsWith("/snippets?"),
    role: "admin",
    permission: "snippets.write",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parsed = CreateSnippetBodySchema.safeParse(body);
      if (!parsed.success) return invalidBody(res, parsed.error.issues);

      // Reject a name that already exists up-front for a clean 409 instead of a raw 23505.
      const existing = await findSnippetByName(auth.orgId, parsed.data.name);
      if (existing) {
        return sendJson(
          res,
          errorEnvelope("snippet_name_exists", "A snippet with that name already exists", {
            name: parsed.data.name,
          }),
          409,
        );
      }

      const snippet = await createSnippet(auth.orgId, {
        name: parsed.data.name,
        description: parsed.data.description,
        category: parsed.data.category,
        tags: parsed.data.tags,
        nodes: parsed.data.nodes,
        edges: parsed.data.edges,
        entryNodeId: parsed.data.entryNodeId,
        createdBy: auth.userId,
      });

      await auditAction(auth, "snippet.created", {
        targetType: "snippet",
        targetId: snippet.id,
        metadata: { name: snippet.name, category: snippet.category, nodeCount: snippet.nodes.length },
      });

      return sendJson(res, { snippet }, 201);
    },
  },
  {
    method: "POST",
    match: matchSnippetById,
    role: "admin",
    permission: "snippets.write",
    handler: async ({ req, res, auth }) => {
      const id = snippetIdFromUrl(req.url);
      if (!id) return sendJson(res, { error: "snippet id required" }, 400);

      // Built-ins are code-only and read-only.
      if (isBuiltinSnippetId(id)) {
        return sendJson(
          res,
          errorEnvelope("snippet_builtin_immutable", "Built-in snippets are read-only"),
          409,
        );
      }

      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parsed = UpdateSnippetBodySchema.safeParse(body);
      if (!parsed.success) return invalidBody(res, parsed.error.issues);

      // If renaming, reject a collision with a DIFFERENT existing snippet.
      if (parsed.data.name !== undefined) {
        const clash = await findSnippetByName(auth.orgId, parsed.data.name);
        if (clash && clash.id !== id) {
          return sendJson(
            res,
            errorEnvelope("snippet_name_exists", "A snippet with that name already exists", {
              name: parsed.data.name,
            }),
            409,
          );
        }
      }

      const result = await updateSnippet(auth.orgId, id, {
        name: parsed.data.name,
        description: parsed.data.description,
        category: parsed.data.category,
        tags: parsed.data.tags,
        nodes: parsed.data.nodes,
        edges: parsed.data.edges,
        entryNodeId: parsed.data.entryNodeId,
      });
      if (!result) {
        return sendJson(res, errorEnvelope("snippet_not_found", "Snippet not found"), 404);
      }

      await auditAction(auth, "snippet.updated", {
        targetType: "snippet",
        targetId: id,
        metadata: { before: result.before, after: result.after },
      });

      return sendJson(res, { snippet: result.after });
    },
  },
  {
    method: "DELETE",
    match: matchSnippetById,
    role: "admin",
    permission: "snippets.write",
    handler: async ({ req, res, auth }) => {
      const id = snippetIdFromUrl(req.url);
      if (!id) return sendJson(res, { error: "snippet id required" }, 400);

      if (isBuiltinSnippetId(id)) {
        return sendJson(
          res,
          errorEnvelope("snippet_builtin_immutable", "Built-in snippets are read-only"),
          409,
        );
      }

      const deleted = await deleteSnippet(auth.orgId, id);
      if (!deleted) {
        return sendJson(res, errorEnvelope("snippet_not_found", "Snippet not found"), 404);
      }

      await auditAction(auth, "snippet.deleted", {
        targetType: "snippet",
        targetId: id,
        metadata: { name: deleted.name, category: deleted.category },
      });

      return sendJson(res, { ok: true });
    },
  },
];
