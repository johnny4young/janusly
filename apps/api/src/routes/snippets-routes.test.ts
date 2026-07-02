/**
 * Route-level tests for the workflow snippets library routes.
 *
 * Confirms:
 *  - Each route declares the right role + permission gate.
 *  - GET concatenates the code-shipped built-ins ahead of the org's custom rows.
 *  - Built-in immutability: POST / DELETE against a `builtin:` id → 409.
 *  - 422 on Zod body failure; 409 on duplicate name; 404 on missing snippet.
 *  - Create / update / delete write the right audit action.
 *  - The insertion beacon audits `snippet.inserted` for both built-in and custom.
 *  - Multi-tenant: every repo call carries `auth.orgId`.
 *
 * `@janusly/shared` is NOT mocked — the real `BUILTIN_SNIPPETS` and
 * `isBuiltinSnippetId` drive the built-in concat + immutability gates.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  const sendJson = vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status }));
  return {
    ...actual,
    sendJson,
    sendError: vi.fn((_res: unknown, code: string, message: string, status = 400, params?: Record<string, unknown>) =>
      sendJson(_res, params === undefined ? { error: message, code } : { error: message, code, params }, status)),
    readJson: vi.fn(),
  };
});

vi.mock("@janusly/data", () => ({
  createSnippet: vi.fn(),
  deleteSnippet: vi.fn(),
  findSnippetByName: vi.fn(),
  getSnippetById: vi.fn(),
  listSnippets: vi.fn(),
  updateSnippet: vi.fn(),
}));

vi.mock("../audit-helper", () => ({
  auditAction: vi.fn(),
}));

import { snippetsRoutes } from "./snippets-routes";
import { readJson, sendJson } from "../http";
import {
  createSnippet,
  deleteSnippet,
  findSnippetByName,
  getSnippetById,
  listSnippets,
  updateSnippet,
} from "@janusly/data";
import { auditAction } from "../audit-helper";
import { BUILTIN_SNIPPETS } from "@janusly/shared";
import type { Route } from "../routes";

const sendJsonMock = vi.mocked(sendJson);
const readJsonMock = vi.mocked(readJson);
const createMock = vi.mocked(createSnippet);
const deleteMock = vi.mocked(deleteSnippet);
const findByNameMock = vi.mocked(findSnippetByName);
const getByIdMock = vi.mocked(getSnippetById);
const listMock = vi.mocked(listSnippets);
const updateMock = vi.mocked(updateSnippet);
const auditMock = vi.mocked(auditAction);

const auth = { orgId: "org-1", userId: "user-1", mode: "dev-headers", source: "dev" } as never;

function findRoute(method: string, path: string): Route {
  const route = snippetsRoutes.find((r) => {
    if (r.method !== method) return false;
    return typeof r.match === "string" ? r.match === path : r.match(path);
  });
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

async function callRoute(method: string, path: string) {
  const route = findRoute(method, path);
  return route.handler({ req: { url: path } as never, res: {} as never, auth });
}

const CUSTOM_SNIPPET = {
  id: "snip-1",
  name: "My retry helper",
  description: "",
  category: "retry",
  tags: [],
  builtin: false,
  nodes: [{ id: "n1", type: "http", config: {} }],
  edges: [],
};

const VALID_CREATE_BODY = {
  name: "My retry helper",
  category: "retry",
  nodes: [{ id: "n1", type: "http", config: {} }],
};

afterEach(() => {
  vi.clearAllMocks();
  readJsonMock.mockReset();
});

describe("route gates", () => {
  it("GET /snippets is viewer + snippets.read", () => {
    const route = findRoute("GET", "/snippets");
    expect(route.role).toBe("viewer");
    expect(route.permission).toBe("snippets.read");
  });
  it("POST /snippets is admin + snippets.write", () => {
    const route = findRoute("POST", "/snippets");
    expect(route.role).toBe("admin");
    expect(route.permission).toBe("snippets.write");
  });
  it("POST /snippets/:id is admin + snippets.write", () => {
    const route = findRoute("POST", "/snippets/snip-1");
    expect(route.role).toBe("admin");
    expect(route.permission).toBe("snippets.write");
  });
  it("DELETE /snippets/:id is admin + snippets.write", () => {
    const route = findRoute("DELETE", "/snippets/snip-1");
    expect(route.role).toBe("admin");
    expect(route.permission).toBe("snippets.write");
  });
  it("POST /snippets/:id/inserted is editor + snippets.read", () => {
    const route = findRoute("POST", "/snippets/snip-1/inserted");
    expect(route.role).toBe("editor");
    expect(route.permission).toBe("snippets.read");
  });
  it("the inserted matcher takes precedence over the bare :id matcher", () => {
    // First-match-wins: the inserted route must be found before the :id route.
    const route = findRoute("POST", "/snippets/snip-1/inserted");
    expect(typeof route.match === "function" && route.match("/snippets/snip-1/inserted")).toBe(true);
  });
});

describe("GET /snippets", () => {
  it("returns built-ins ahead of the org's custom snippets (scoped to org)", async () => {
    listMock.mockResolvedValueOnce([CUSTOM_SNIPPET] as never);
    await callRoute("GET", "/snippets");
    expect(listMock).toHaveBeenCalledWith("org-1");
    const payload = sendJsonMock.mock.calls.at(-1)?.[1] as { snippets: Array<{ id: string; builtin: boolean }> };
    expect(payload.snippets).toHaveLength(BUILTIN_SNIPPETS.length + 1);
    // First entries are the built-ins.
    expect(payload.snippets[0].builtin).toBe(true);
    // The custom row is last.
    expect(payload.snippets.at(-1)?.id).toBe("snip-1");
  });
});

describe("POST /snippets (create)", () => {
  it("422 on invalid body", async () => {
    readJsonMock.mockResolvedValueOnce({ name: "", category: "retry", nodes: [] });
    await callRoute("POST", "/snippets");
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(422);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("409 on duplicate name", async () => {
    readJsonMock.mockResolvedValueOnce(VALID_CREATE_BODY);
    findByNameMock.mockResolvedValueOnce(CUSTOM_SNIPPET as never);
    await callRoute("POST", "/snippets");
    const last = sendJsonMock.mock.calls.at(-1);
    expect(last?.[2]).toBe(409);
    expect(last?.[1]).toMatchObject({ code: "snippet_name_exists" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("creates + audits snippet.created on success (createdBy = caller)", async () => {
    readJsonMock.mockResolvedValueOnce(VALID_CREATE_BODY);
    findByNameMock.mockResolvedValueOnce(null);
    createMock.mockResolvedValueOnce(CUSTOM_SNIPPET as never);
    await callRoute("POST", "/snippets");
    expect(createMock).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ name: "My retry helper", createdBy: "user-1" }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      auth,
      "snippet.created",
      expect.objectContaining({ targetId: "snip-1" }),
    );
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(201);
  });
});

describe("POST /snippets/:id (update) — built-in immutability", () => {
  it("409 snippet_builtin_immutable when targeting a built-in id", async () => {
    const builtinId = BUILTIN_SNIPPETS[0].id; // builtin:retry-with-backoff
    await callRoute("POST", `/snippets/${encodeURIComponent(builtinId)}`);
    const last = sendJsonMock.mock.calls.at(-1);
    expect(last?.[2]).toBe(409);
    expect(last?.[1]).toMatchObject({ code: "snippet_builtin_immutable" });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("404 when the custom snippet doesn't exist for the org", async () => {
    readJsonMock.mockResolvedValueOnce({ name: "renamed" });
    findByNameMock.mockResolvedValueOnce(null);
    updateMock.mockResolvedValueOnce(null);
    await callRoute("POST", "/snippets/snip-x");
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(404);
  });

  it("409 when renaming onto another snippet's name", async () => {
    readJsonMock.mockResolvedValueOnce({ name: "Taken name" });
    findByNameMock.mockResolvedValueOnce({ ...CUSTOM_SNIPPET, id: "other-snip" } as never);
    await callRoute("POST", "/snippets/snip-1");
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(409);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("updates + audits snippet.updated with before/after (scoped to org)", async () => {
    readJsonMock.mockResolvedValueOnce({ name: "Renamed helper" });
    findByNameMock.mockResolvedValueOnce(null);
    updateMock.mockResolvedValueOnce({
      before: CUSTOM_SNIPPET,
      after: { ...CUSTOM_SNIPPET, name: "Renamed helper" },
    } as never);
    await callRoute("POST", "/snippets/snip-1");
    expect(updateMock).toHaveBeenCalledWith("org-1", "snip-1", expect.objectContaining({ name: "Renamed helper" }));
    expect(auditMock).toHaveBeenCalledWith(
      auth,
      "snippet.updated",
      expect.objectContaining({ metadata: expect.objectContaining({ before: CUSTOM_SNIPPET }) }),
    );
  });
});

describe("DELETE /snippets/:id — built-in immutability + tenant scope", () => {
  it("409 snippet_builtin_immutable when deleting a built-in id", async () => {
    const builtinId = BUILTIN_SNIPPETS[1].id;
    await callRoute("DELETE", `/snippets/${encodeURIComponent(builtinId)}`);
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(409);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("404 when the custom snippet is missing for the org", async () => {
    deleteMock.mockResolvedValueOnce(null);
    await callRoute("DELETE", "/snippets/snip-x");
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(404);
    expect(deleteMock).toHaveBeenCalledWith("org-1", "snip-x");
  });

  it("deletes + audits snippet.deleted on success", async () => {
    deleteMock.mockResolvedValueOnce(CUSTOM_SNIPPET as never);
    await callRoute("DELETE", "/snippets/snip-1");
    expect(deleteMock).toHaveBeenCalledWith("org-1", "snip-1");
    expect(auditMock).toHaveBeenCalledWith(
      auth,
      "snippet.deleted",
      expect.objectContaining({ targetId: "snip-1" }),
    );
  });
});

describe("POST /snippets/:id/inserted (audit beacon)", () => {
  it("audits snippet.inserted for a built-in id (no DB read)", async () => {
    const builtinId = BUILTIN_SNIPPETS[0].id;
    readJsonMock.mockResolvedValueOnce({ workflowId: "wf-1", insertedNodeCount: 1 });
    await callRoute("POST", `/snippets/${encodeURIComponent(builtinId)}/inserted`);
    expect(getByIdMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      auth,
      "snippet.inserted",
      expect.objectContaining({ metadata: expect.objectContaining({ builtin: true, workflowId: "wf-1" }) }),
    );
    expect(sendJsonMock.mock.calls.at(-1)?.[1]).toMatchObject({ ok: true });
  });

  it("checks org scope for a custom id and 404s when absent", async () => {
    getByIdMock.mockResolvedValueOnce(null);
    await callRoute("POST", "/snippets/snip-x/inserted");
    expect(getByIdMock).toHaveBeenCalledWith("org-1", "snip-x");
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(404);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("audits snippet.inserted for an existing custom id", async () => {
    getByIdMock.mockResolvedValueOnce(CUSTOM_SNIPPET as never);
    readJsonMock.mockResolvedValueOnce({ workflowId: "wf-2", insertedNodeCount: 1 });
    await callRoute("POST", "/snippets/snip-1/inserted");
    expect(auditMock).toHaveBeenCalledWith(
      auth,
      "snippet.inserted",
      expect.objectContaining({ targetId: "snip-1", metadata: expect.objectContaining({ builtin: false }) }),
    );
  });
});
