/**
 * PromptOps registry REST surface.
 *
 * Six routes:
 *   - `GET    /prompts`                                  (viewer)
 *   - `POST   /prompts`                                  (editor + `prompts.write`)
 *   - `GET    /prompts/:name`                            (viewer)
 *   - `GET    /prompts/:name/versions/:version`          (viewer)
 *   - `POST   /prompts/:name/versions`                   (editor + `prompts.write`)
 *   - `POST   /prompts/:name/versions/:version/pin`      (editor + `prompts.write`)
 *
 * Multi-tenant scope is enforced at the repo layer — every route reads /
 * writes via `promptsRepo.*` which carries `eq(<table>.orgId, auth.orgId)`
 * on every query. A cross-org prompt lookup returns 404 (same enumeration-
 * leak posture as the rest of the API).
 *
 * Audit actions:
 *   - `prompt.created` on POST `/prompts`
 *   - `prompt.version_created` on POST `/prompts/:name/versions`
 *   - `prompt.version_pinned` on POST `/prompts/:name/versions/:version/pin`
 *
 * Used by future Web UI panels and external tooling (CLI, SDK). The
 * engine resolver (`packages/engine/src/prompt-resolver.ts`) does NOT go
 * through these routes — it reads the repo directly.
 */

import {
  createPrompt,
  createPromptVersion,
  getPromptByName,
  getPromptVersion,
  listPromptVersions,
  listPrompts,
  pinPromptVersion,
} from "@janusly/data/src/promptsRepo";
import { PromptVariablesSchema, type PromptVariable } from "@janusly/shared";

import { audit } from "../audit";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendJson } from "../http";
import type { Route } from "../routes";

/** Max prompt name length — matches the shared `PromptRefSchema` cap. */
const MAX_NAME_LEN = 128;
/** Max description length — defensive cap on free-text input. */
const MAX_DESCRIPTION_LEN = 1000;
/** Max template body — defensive cap; 200 KB is plenty for any practical
 *  system prompt and aligns with the engine's other body caps. */
const MAX_TEMPLATE_LEN = 200_000;

/** Pattern matching `/prompts/:name/versions/:version/pin`. */
const PIN_VERSION_PATTERN = /^\/prompts\/([^/]+)\/versions\/(\d+)\/pin$/;
/** Pattern matching `/prompts/:name/versions/:version` (no /pin suffix). */
const READ_VERSION_PATTERN = /^\/prompts\/([^/]+)\/versions\/(\d+)$/;
/** Pattern matching `/prompts/:name/versions` (POST = create new version). */
const VERSIONS_LIST_PATTERN = /^\/prompts\/([^/]+)\/versions$/;
/** Pattern matching `/prompts/:name` exactly (no further segments). */
const PROMPT_DETAIL_PATTERN = /^\/prompts\/([^/]+)$/;

function isPromptName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_NAME_LEN;
}

export const promptsRoutes: Route[] = [
  // ─── list ────────────────────────────────────────────────────────
  {
    method: "GET",
    match: "/prompts",
    permission: "prompts.read",
    handler: async ({ res, auth }) => {
      const rows = await listPrompts(auth.orgId);
      return sendJson(res, { prompts: rows });
    },
  },

  // ─── create ──────────────────────────────────────────────────────
  {
    method: "POST",
    match: "/prompts",
    permission: "prompts.write",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const name = body.name;
      const description = body.description;
      if (!isPromptName(name)) {
        return sendJson(res, { error: "name is required and must be 1..128 chars", code: "invalid_input" }, 400);
      }
      if (description !== undefined && (typeof description !== "string" || description.length > MAX_DESCRIPTION_LEN)) {
        return sendJson(res, { error: `description must be a string up to ${MAX_DESCRIPTION_LEN} chars`, code: "invalid_input" }, 400);
      }
      // Reject duplicate names per org with a stable 409 so clients can
      // distinguish from a generic server error.
      const existing = await getPromptByName(auth.orgId, name);
      if (existing) {
        return sendJson(res, { error: "a prompt with this name already exists", code: "duplicate_name" }, 409);
      }
      const created = await createPrompt({
        orgId: auth.orgId,
        name,
        description: typeof description === "string" ? description : undefined,
        createdBy: auth.userId,
      });
      await audit(auth.orgId, auth.userId, "prompt.created", "prompt", created.id, {
        name: created.name,
      });
      return sendJson(res, { prompt: created }, 201);
    },
  },

  // ─── read detail (name only — returns prompt + version count) ────
  {
    method: "GET",
    match: (url) => PROMPT_DETAIL_PATTERN.test(url),
    permission: "prompts.read",
    handler: async ({ req, res, auth }) => {
      const url = req.url ?? "";
      const match = url.match(PROMPT_DETAIL_PATTERN);
      if (!match) {
        return sendJson(res, { error: "invalid url", code: "invalid_url" }, 400);
      }
      const name = decodeURIComponent(match[1]);
      const prompt = await getPromptByName(auth.orgId, name);
      if (!prompt) {
        return sendJson(res, { error: "prompt not found", code: "not_found" }, 404);
      }
      const versions = await listPromptVersions(auth.orgId, prompt.id);
      return sendJson(res, {
        prompt,
        versions: versions.map((v) => ({
          id: v.id,
          version: v.version,
          status: v.status,
          createdAt: v.createdAt,
          createdBy: v.createdBy,
        })),
      });
    },
  },

  // ─── read specific version ───────────────────────────────────────
  {
    method: "GET",
    match: (url) => READ_VERSION_PATTERN.test(url),
    permission: "prompts.read",
    handler: async ({ req, res, auth }) => {
      const url = req.url ?? "";
      const match = url.match(READ_VERSION_PATTERN);
      if (!match) {
        return sendJson(res, { error: "invalid url", code: "invalid_url" }, 400);
      }
      const name = decodeURIComponent(match[1]);
      const versionNum = Number.parseInt(match[2], 10);
      if (!Number.isFinite(versionNum) || versionNum < 1) {
        return sendJson(res, { error: "version must be a positive integer", code: "invalid_input" }, 400);
      }
      const prompt = await getPromptByName(auth.orgId, name);
      if (!prompt) {
        return sendJson(res, { error: "prompt not found", code: "not_found" }, 404);
      }
      const version = await getPromptVersion(auth.orgId, prompt.id, versionNum);
      if (!version) {
        return sendJson(res, { error: "version not found", code: "not_found" }, 404);
      }
      return sendJson(res, { prompt, version });
    },
  },

  // ─── append new version ──────────────────────────────────────────
  {
    method: "POST",
    match: (url) => VERSIONS_LIST_PATTERN.test(url),
    permission: "prompts.write",
    handler: async ({ req, res, auth }) => {
      const url = req.url ?? "";
      const match = url.match(VERSIONS_LIST_PATTERN);
      if (!match) {
        return sendJson(res, { error: "invalid url", code: "invalid_url" }, 400);
      }
      const name = decodeURIComponent(match[1]);
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const templateText = body.templateText;
      const variablesInput = body.variables ?? [];

      if (typeof templateText !== "string" || templateText.length === 0) {
        return sendJson(res, { error: "templateText is required", code: "invalid_input" }, 400);
      }
      if (templateText.length > MAX_TEMPLATE_LEN) {
        return sendJson(res, { error: `templateText too long (max ${MAX_TEMPLATE_LEN} chars)`, code: "invalid_input" }, 400);
      }

      let variables: PromptVariable[];
      try {
        variables = PromptVariablesSchema.parse(variablesInput);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid variables";
        return sendJson(res, { error: `variables: ${message}`, code: "invalid_variables" }, 400);
      }

      const prompt = await getPromptByName(auth.orgId, name);
      if (!prompt) {
        return sendJson(res, { error: "prompt not found", code: "not_found" }, 404);
      }
      const created = await createPromptVersion({
        orgId: auth.orgId,
        promptId: prompt.id,
        templateText,
        variables,
        createdBy: auth.userId,
      });
      await audit(auth.orgId, auth.userId, "prompt.version_created", "prompt_version", created.id, {
        name: prompt.name,
        version: created.version,
        promptId: prompt.id,
      });
      return sendJson(res, { version: created }, 201);
    },
  },

  // ─── pin a version as active ─────────────────────────────────────
  {
    method: "POST",
    match: (url) => PIN_VERSION_PATTERN.test(url),
    permission: "prompts.write",
    handler: async ({ req, res, auth }) => {
      const url = req.url ?? "";
      const match = url.match(PIN_VERSION_PATTERN);
      if (!match) {
        return sendJson(res, { error: "invalid url", code: "invalid_url" }, 400);
      }
      const name = decodeURIComponent(match[1]);
      const versionNum = Number.parseInt(match[2], 10);
      if (!Number.isFinite(versionNum) || versionNum < 1) {
        return sendJson(res, { error: "version must be a positive integer", code: "invalid_input" }, 400);
      }
      const prompt = await getPromptByName(auth.orgId, name);
      if (!prompt) {
        return sendJson(res, { error: "prompt not found", code: "not_found" }, 404);
      }
      const result = await pinPromptVersion({
        orgId: auth.orgId,
        promptId: prompt.id,
        version: versionNum,
      });
      if (!result) {
        return sendJson(res, { error: "version not found", code: "not_found" }, 404);
      }
      await audit(auth.orgId, auth.userId, "prompt.version_pinned", "prompt", prompt.id, {
        name: prompt.name,
        version: versionNum,
        from: result.previousVersionId,
        to: result.prompt.pinnedVersionId,
      });
      return sendJson(res, { prompt: result.prompt });
    },
  },
];
