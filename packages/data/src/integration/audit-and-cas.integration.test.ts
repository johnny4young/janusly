/**
 * Integration tests — REAL Postgres (via `pnpm test:integration`).
 *
 * Exercise SQL correctness the mocked-DB unit tests can't prove: audit-log
 * keyset pagination boundaries, the action-PREFIX filter, tenant scoping, the
 * credential-rotation CAS conflict path, and presence of the audit-prefix and
 * baseline HNSW hot-path indexes. Each test uses a unique org id so
 * rows never collide; a final cleanup deletes them.
 */

import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { auditLogs, credentials, db } from "@janusly/db";
import { queryAuditLogs } from "../auditLogsRepo";
import { rotateCredentialSecretRef } from "../credentialsRepo";

const RUN_TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-org-${RUN_TAG}`;
const ORG_OTHER = `it-org-other-${RUN_TAG}`;

afterAll(async () => {
  await db.delete(auditLogs).where(eq(auditLogs.orgId, ORG));
  await db.delete(auditLogs).where(eq(auditLogs.orgId, ORG_OTHER));
  await db.delete(credentials).where(eq(credentials.orgId, ORG));
});

/** Insert one audit row with a controlled action + createdAt. */
async function seedAudit(org: string, id: string, action: string, createdAt: Date): Promise<void> {
  await db.insert(auditLogs).values({ id, orgId: org, action, createdAt });
}

/** Parse the `<iso>|<id>` cursor string back into the object `queryAuditLogs` takes. */
function parseCursor(cursor: string): { createdAt: Date; id: string } {
  const idx = cursor.lastIndexOf("|");
  return { createdAt: new Date(cursor.slice(0, idx)), id: cursor.slice(idx + 1) };
}

describe("queryAuditLogs — real Postgres", () => {
  it("keyset-paginates newest-first with no overlap or skip", async () => {
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    // 5 rows, 1 minute apart, oldest → newest.
    for (let i = 0; i < 5; i++) {
      await seedAudit(ORG, `${RUN_TAG}-kp-${i}`, "test.keyset", new Date(base + i * 60_000));
    }

    const seen: string[] = [];
    let cursor: { createdAt: Date; id: string } | null = null;
    for (let page = 0; page < 10; page++) {
      const result = await queryAuditLogs(ORG, { action: "test.keyset", cursor, limit: 2 });
      seen.push(...result.rows.map((r) => r.id));
      if (!result.hasMore || !result.nextCursor) break;
      cursor = parseCursor(result.nextCursor);
    }

    // All 5 surfaced exactly once, newest-first (index 4 → 0).
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([
      `${RUN_TAG}-kp-4`,
      `${RUN_TAG}-kp-3`,
      `${RUN_TAG}-kp-2`,
      `${RUN_TAG}-kp-1`,
      `${RUN_TAG}-kp-0`,
    ]);
  });

  it("applies the action PREFIX filter", async () => {
    const now = Date.now();
    await seedAudit(ORG, `${RUN_TAG}-p1`, "org.scim.user.created", new Date(now));
    await seedAudit(ORG, `${RUN_TAG}-p2`, "org.scim.group.synced", new Date(now + 1));
    await seedAudit(ORG, `${RUN_TAG}-p3`, "workflow.saved", new Date(now + 2));

    const result = await queryAuditLogs(ORG, { action: "org.scim", limit: 50 });
    const actions = result.rows.map((r) => r.action);
    expect(actions.every((a) => a.startsWith("org.scim"))).toBe(true);
    expect(actions).toContain("org.scim.user.created");
    expect(actions).toContain("org.scim.group.synced");
    expect(actions).not.toContain("workflow.saved");
  });

  it("scopes strictly to the org (tenant isolation)", async () => {
    const now = Date.now();
    await seedAudit(ORG, `${RUN_TAG}-iso-a`, "iso.check", new Date(now));
    await seedAudit(ORG_OTHER, `${RUN_TAG}-iso-b`, "iso.check", new Date(now + 1));

    const mine = await queryAuditLogs(ORG, { action: "iso.check", limit: 50 });
    const ids = mine.rows.map((r) => r.id);
    expect(ids).toContain(`${RUN_TAG}-iso-a`);
    expect(ids).not.toContain(`${RUN_TAG}-iso-b`);
  });
});

describe("rotateCredentialSecretRef — CAS conflict on real Postgres", () => {
  it("returns not_found / conflict / ok against the ifMatch token", async () => {
    const name = `cred-${RUN_TAG}`;
    await db.insert(credentials).values({
      id: `${RUN_TAG}-cred`,
      orgId: ORG,
      name,
      kind: "github",
      secretRef: "OLD_REF",
    });

    // Unknown name → not_found.
    const missing = await rotateCredentialSecretRef({ orgId: ORG, name: "does-not-exist", newSecretRef: "X" });
    expect(missing).toEqual({ ok: false, reason: "not_found" });

    // Stale ifMatch token → conflict (a concurrent edit landed).
    const stale = await rotateCredentialSecretRef({
      orgId: ORG,
      name,
      newSecretRef: "NEW_REF",
      ifMatchUpdatedAt: new Date(0).toISOString(),
    });
    expect(stale).toEqual({ ok: false, reason: "conflict" });

    // No ifMatch → succeeds and moves the ref.
    const ok = await rotateCredentialSecretRef({ orgId: ORG, name, newSecretRef: "NEW_REF" });
    expect(ok.ok).toBe(true);
    const row = await db.select().from(credentials).where(eq(credentials.id, `${RUN_TAG}-cred`));
    expect(row[0]?.secretRef).toBe("NEW_REF");
  });
});

describe("hot-path indexes present after migration", () => {
  async function indexNames(table: string): Promise<string[]> {
    const rows = await db.execute<{ indexname: string }>(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = ${table}`,
    );
    // drizzle's postgres-js execute returns an array-like of rows.
    return Array.from(rows as Iterable<{ indexname: string }>).map((r) => r.indexname);
  }

  it("audit_logs carries the action-prefix index", async () => {
    expect(await indexNames("audit_logs")).toContain("audit_logs_org_action_created_idx");
  });

  it("memory_entries carries the baseline HNSW vector index", async () => {
    expect(await indexNames("memory_entries")).toContain("memory_entries_embedding_hnsw_idx");
  });
});
