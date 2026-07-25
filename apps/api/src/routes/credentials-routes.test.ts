/**
 * Route-level tests for /credentials.
 *
 * Covers the health endpoint + permission gates, plus the bulk-rotation
 * route's behavior contract: dry-run previews without mutating or auditing;
 * commit rotates, audits, and NEVER echoes the secret material or reference; a stale
 * If-Match surfaces as 409; an unknown credential is 404.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbHoisted = vi.hoisted(() => ({ credentialRows: [] as Array<Record<string, unknown>> }));
const txHoisted = vi.hoisted(() => {
  const insertValues = vi.fn().mockResolvedValue(undefined);
  return {
    auditCalls: [] as Array<Record<string, unknown>>,
    forUpdate: vi.fn(),
    insertValues,
    tx: {
      insert: vi.fn(() => ({ values: insertValues })),
    },
  };
});
const secretStoreHoisted = vi.hoisted(() => ({
  create: vi.fn(async ({ credentialId }: { credentialId: string }) => ({
    id: "secret-version-1",
    version: 1,
    secretRef: `janusly-secret://${credentialId}`,
  })),
  revoke: vi.fn().mockResolvedValue(true),
}));

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

vi.mock("@janusly/data/src/credentialHealthRepo", () => ({
  getCredentialHealth: vi.fn(),
  resolveCredentialReferences: vi.fn(),
}));

vi.mock("@janusly/data/src/credentialsRepo", () => ({
  rotateCredentialSecretRef: vi.fn(),
  setCredentialExpiry: vi.fn(),
}));

vi.mock("@janusly/data/src/credentialSecretStore", () => ({
  createCredentialSecretVersion: secretStoreHoisted.create,
  isManagedCredentialSecretRef: vi.fn((secretRef: string) => secretRef.startsWith("janusly-secret://")),
  revokeCredentialSecretRef: secretStoreHoisted.revoke,
}));

// withAuditTx (the atomic entity+audit chokepoint) — run the handler with a
// fake tx + a capturing audit, mirroring the real {ok,result} envelope.
vi.mock("@janusly/data/src/audit-tx", () => ({
  withAuditTx: vi.fn(async (handler: (tx: unknown, audit: (i: Record<string, unknown>) => Promise<void>) => Promise<unknown>) => {
    const audit = async (input: Record<string, unknown>) => { txHoisted.auditCalls.push(input); };
    try {
      const result = await handler({
        ...txHoisted.tx,
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => ({
                for: txHoisted.forUpdate,
              })),
            })),
          })),
        })),
      }, audit);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }),
}));

vi.mock("@janusly/db", () => {
  // `where` returns a thenable that ALSO exposes `.limit` — the GET list
  // path awaits `where(...)` directly while the bulk-update path calls
  // `where(...).limit(1)`; both resolve to the configured credential rows.
  const makeWhereResult = () => {
    const rows = dbHoisted.credentialRows;
    const result = Promise.resolve(rows) as Promise<unknown[]> & { limit: () => Promise<unknown[]> };
    result.limit = () => Promise.resolve(rows);
    return result;
  };
  return {
    db: {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(makeWhereResult) })) })),
      insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    },
    credentials: {
      id: "id", orgId: "org_id", name: "name", kind: "kind",
      secretRef: "secret_ref", metadata: "metadata", createdBy: "created_by",
      createdAt: "created_at", updatedAt: "updated_at",
    },
  };
});

vi.mock("../audit-helper", () => ({
  auditAction: vi.fn(),
}));

import { credentialsRoutes } from "./credentials-routes";
import { readJson } from "../http";
import { resolveCredentialReferences } from "@janusly/data/src/credentialHealthRepo";
import { rotateCredentialSecretRef, setCredentialExpiry } from "@janusly/data/src/credentialsRepo";
import { auditAction } from "../audit-helper";
import type { Route } from "../routes";

const readJsonMock = vi.mocked(readJson);
const resolveRefsMock = vi.mocked(resolveCredentialReferences);
const rotateMock = vi.mocked(rotateCredentialSecretRef);
const setExpiryMock = vi.mocked(setCredentialExpiry);
const auditActionMock = vi.mocked(auditAction);

function findRoute(method: string, path: string): Route {
  const route = credentialsRoutes.find((r) => {
    if (r.method !== method) return false;
    return typeof r.match === "string" ? r.match === path : r.match(path);
  });
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

const AUTH = { orgId: "org-1", userId: "user-1", mode: "dev-headers", source: "dev" };

async function callRoute(method: string, path: string, body?: unknown) {
  const route = findRoute(method, path);
  if (body !== undefined) readJsonMock.mockResolvedValueOnce(body);
  return route.handler({ req: { url: path } as never, res: {} as never, auth: AUTH as never }) as Promise<{
    payload: Record<string, unknown>;
    status: number;
  }>;
}

beforeEach(() => {
  dbHoisted.credentialRows = [];
  txHoisted.auditCalls = [];
  txHoisted.forUpdate.mockImplementation(async () => dbHoisted.credentialRows);
  txHoisted.insertValues.mockResolvedValue(undefined);
  secretStoreHoisted.create.mockImplementation(async ({ credentialId }: { credentialId: string }) => ({
    id: "secret-version-1",
    version: 1,
    secretRef: `janusly-secret://${credentialId}`,
  }));
  secretStoreHoisted.revoke.mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /credentials/health", () => {
  it("declares role: viewer + permission: credentials.read", () => {
    const route = findRoute("GET", "/credentials/health");
    expect(route.role).toBe("viewer");
    expect(route.permission).toBe("credentials.read");
  });
});

describe("POST /credentials gate", () => {
  it("declares BOTH role: admin AND permission: credentials.write", () => {
    const route = findRoute("POST", "/credentials");
    expect(route.role).toBe("admin");
    expect(route.permission).toBe("credentials.write");
  });

  it("maps the database name invariant to a stable conflict response", async () => {
    txHoisted.insertValues.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "credentials_org_name_idx"'),
    );

    const { payload, status } = await callRoute("POST", "/credentials", {
      name: "pagerduty-api",
      kind: "pagerduty_api_token",
      secretValue: "opaque-value",
    });

    expect(status).toBe(409);
    expect(payload.code).toBe("credentials_conflict");
    expect(JSON.stringify(payload)).not.toContain("opaque-value");
  });
});

describe("POST /credentials/:name/bulk-update", () => {
  const PATH = "/credentials/slack-prod/bulk-update";

  it("declares admin + credentials.write (defense in depth)", () => {
    const route = findRoute("POST", PATH);
    expect(route.role).toBe("admin");
    expect(route.permission).toBe("credentials.write");
  });

  it("dry-run returns the affected workflows without rotating or auditing", async () => {
    dbHoisted.credentialRows = [{ kind: "slack_webhook", updatedAt: new Date("2026-05-28T00:00:00.000Z") }];
    resolveRefsMock.mockResolvedValue([{ workflowId: "wf-1", workflowName: "Billing", nodeIds: ["n1"] }]);

    const { payload } = await callRoute("POST", PATH, { dryRun: true });

    expect((payload.affected as unknown[]).length).toBe(1);
    expect(payload.affectedCount).toBe(1);
    expect(payload.ok).toBeUndefined();
    expect(rotateMock).not.toHaveBeenCalled();
    expect(auditActionMock).not.toHaveBeenCalled();
  });

  it("commit rotates, writes the audit row, and NEVER echoes a secretRef", async () => {
    dbHoisted.credentialRows = [{
      id: "credential-1",
      kind: "slack_webhook",
      secretRef: "SLACK_WEBHOOK_V1",
      updatedAt: new Date("2026-05-28T00:00:00.000Z"),
    }];
    resolveRefsMock.mockResolvedValue([{ workflowId: "wf-1", workflowName: "Billing", nodeIds: ["n1"] }]);
    rotateMock.mockResolvedValue({ ok: true, updatedAt: new Date("2026-05-29T00:00:00.000Z") });

    const { payload } = await callRoute("POST", PATH, {
      dryRun: false,
      newSecretRef: "SLACK_WEBHOOK_V2",
      ifMatch: "2026-05-28T00:00:00.000Z",
    });

    expect(payload.ok).toBe(true);
    expect(payload.affectedCount).toBe(1);
    expect(txHoisted.forUpdate).toHaveBeenCalledWith("update");
    // Rotation runs inside the withAuditTx transaction, so it's called with
    // the input AND the tx handle.
    expect(rotateMock).toHaveBeenCalledWith({
      orgId: "org-1",
      name: "slack-prod",
      newSecretRef: "SLACK_WEBHOOK_V2",
      ifMatchUpdatedAt: "2026-05-28T00:00:00.000Z",
    }, expect.anything());
    // Neither reference form is ever on the wire.
    expect("secretRef" in payload).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("SLACK_WEBHOOK_V2");
    // The audit row is written via the tx-bound audit (atomic with the swap),
    // keeping the same actor/source forensic shape and never echoing secretRef.
    expect(txHoisted.auditCalls).toHaveLength(1);
    const auditInput = txHoisted.auditCalls[0] as { action: string; metadata: Record<string, unknown> };
    expect(auditInput.action).toBe("credential.bulk_updated");
    expect(auditInput.metadata.affectedWorkflowCount).toBe(1);
    expect(auditInput.metadata.source).toBe("dev");
    expect((auditInput.metadata.actor as Record<string, unknown>).userId).toBe("user-1");
    expect(auditInput.metadata).not.toHaveProperty("newSecretRef");
    expect(JSON.stringify(auditInput)).not.toContain("SLACK_WEBHOOK_V2");
  });

  it("returns 409 with the conflict code on a stale If-Match", async () => {
    dbHoisted.credentialRows = [{ kind: "slack_webhook", updatedAt: new Date() }];
    resolveRefsMock.mockResolvedValue([]);
    rotateMock.mockResolvedValue({ ok: false, reason: "conflict" });

    const { status, payload } = await callRoute("POST", PATH, {
      dryRun: false,
      newSecretRef: "SLACK_V2",
      ifMatch: "2026-05-28T00:00:00.000Z",
    });

    expect(status).toBe(409);
    expect(payload.code).toBe("credential_rotation_conflict");
  });

  it("rejects missing or malformed If-Match before scanning or rotating", async () => {
    dbHoisted.credentialRows = [{ kind: "slack_webhook", updatedAt: new Date() }];

    const missing = await callRoute("POST", PATH, { dryRun: false, newSecretRef: "SLACK_V2" });
    expect(missing.status).toBe(400);
    expect(resolveRefsMock).not.toHaveBeenCalled();
    expect(rotateMock).not.toHaveBeenCalled();

    const malformed = await callRoute("POST", PATH, { dryRun: false, newSecretRef: "SLACK_V2", ifMatch: "stale" });
    expect(malformed.status).toBe(400);
    expect(resolveRefsMock).not.toHaveBeenCalled();
    expect(rotateMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the credential does not exist", async () => {
    dbHoisted.credentialRows = [];
    const { status } = await callRoute("POST", PATH, { dryRun: true });
    expect(status).toBe(404);
  });

  it("rejects an invalid env-var name on commit (400)", async () => {
    dbHoisted.credentialRows = [{ kind: "slack_webhook", updatedAt: new Date() }];
    resolveRefsMock.mockResolvedValue([]);
    const { status } = await callRoute("POST", PATH, { dryRun: false, newSecretRef: "not a valid name!" });
    expect(status).toBe(400);
    expect(rotateMock).not.toHaveBeenCalled();
  });
});

describe("POST /credentials — optional expiry", () => {
  it("accepts a future expiresAt and audits hasExpiry: true", async () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const { status } = await callRoute("POST", "/credentials", {
      name: "gh", kind: "github_token", secretRef: "GH_TOKEN", expiresAt: future,
    });
    expect(status).toBe(200);
    expect(txHoisted.auditCalls[0]).toMatchObject({
      action: "credential.created",
      metadata: expect.objectContaining({ hasExpiry: true, storage: "legacy" }),
    });
  });

  it("accepts a managed secret once and never persists it on the credential row or audit", async () => {
    const secretValue = "pd-token-value";
    const { status, payload } = await callRoute("POST", "/credentials", {
      name: "pagerduty",
      kind: "pagerduty_api_token",
      secretValue,
    });

    expect(status).toBe(200);
    expect(typeof payload.id).toBe("string");
    expect(secretStoreHoisted.create).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        credentialId: payload.id,
        secretValue,
        createdBy: "user-1",
      }),
      expect.objectContaining({ insert: expect.any(Function), select: expect.any(Function) }),
    );
    expect(txHoisted.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: payload.id,
        secretRef: `janusly-secret://${payload.id}`,
      }),
    );
    expect(JSON.stringify(txHoisted.auditCalls)).not.toContain(secretValue);
    expect(JSON.stringify(payload)).not.toContain(secretValue);
  });

  it("rejects a past expiresAt with credentials_invalid_expiry (400)", async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const { status, payload } = await callRoute("POST", "/credentials", {
      name: "gh", kind: "github_token", secretRef: "GH_TOKEN", expiresAt: past,
    });
    expect(status).toBe(400);
    expect(payload.code).toBe("credentials_invalid_expiry");
    expect(auditActionMock).not.toHaveBeenCalled();
  });

  it("rejects a non-string expiresAt (400)", async () => {
    const { status, payload } = await callRoute("POST", "/credentials", {
      name: "gh", kind: "github_token", secretRef: "GH_TOKEN", expiresAt: 123,
    });
    expect(status).toBe(400);
    expect(payload.code).toBe("credentials_invalid_expiry");
  });
});

describe("POST /credentials/:name/expiry", () => {
  const PATH = "/credentials/gh-prod/expiry";

  it("declares BOTH role: admin AND permission: credentials.write", () => {
    const route = findRoute("POST", PATH);
    expect(route.role).toBe("admin");
    expect(route.permission).toBe("credentials.write");
  });

  it("sets a future expiry → ok + audits credential.expiry_set", async () => {
    setExpiryMock.mockResolvedValue({ ok: true, updatedAt: new Date("2026-07-06T00:00:00.000Z") });
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const { status } = await callRoute("POST", PATH, { expiresAt: future });
    expect(status).toBe(200);
    expect(txHoisted.auditCalls[0]).toMatchObject({ action: "credential.expiry_set", metadata: expect.objectContaining({ hasExpiry: true }) });
  });

  it("clears the expiry (null) → ok", async () => {
    setExpiryMock.mockResolvedValue({ ok: true, updatedAt: new Date("2026-07-06T00:00:00.000Z") });
    const { status } = await callRoute("POST", PATH, { expiresAt: null });
    expect(status).toBe(200);
    expect(txHoisted.auditCalls[0]).toMatchObject({ metadata: expect.objectContaining({ hasExpiry: false }) });
  });

  it("rejects a past expiry with credentials_invalid_expiry (400) without calling the repo", async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const { status, payload } = await callRoute("POST", PATH, { expiresAt: past });
    expect(status).toBe(400);
    expect(payload.code).toBe("credentials_invalid_expiry");
    expect(setExpiryMock).not.toHaveBeenCalled();
  });

  it("rejects an OMITTED expiresAt (400) — clearing must be explicit null, never accidental", async () => {
    const { status, payload } = await callRoute("POST", PATH, { ifMatch: "2026-07-06T00:00:00.000Z" });
    expect(status).toBe(400);
    expect(payload.code).toBe("credentials_expiry_required");
    expect(setExpiryMock).not.toHaveBeenCalled();
  });

  it("maps not_found → 404 and conflict → 409", async () => {
    setExpiryMock.mockResolvedValueOnce({ ok: false, reason: "not_found" });
    const notFound = await callRoute("POST", PATH, { expiresAt: null });
    expect(notFound.status).toBe(404);

    setExpiryMock.mockResolvedValueOnce({ ok: false, reason: "conflict" });
    const conflict = await callRoute("POST", PATH, { expiresAt: null });
    expect(conflict.status).toBe(409);
    expect(conflict.payload.code).toBe("credential_expiry_conflict");
  });
});
