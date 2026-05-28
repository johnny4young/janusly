/**
 * Unit tests for `withAuditTx<T>`. The Drizzle `db.transaction` call is
 * mocked: it runs the handler with a fake `tx` handle whose
 * `.insert(...).values(...)` calls are staged until the callback
 * completes. If the callback throws, the staged writes are discarded
 * to model Drizzle/Postgres rollback behavior.
 *
 * Test invariants:
 *  1. Happy path — handler completes; both the entity insert and the
 *     audit insert are recorded; the helper returns `{ ok: true, result }`.
 *  2. Entity throw rolls back — handler throws before calling audit;
 *     the helper returns `{ ok: false, error }`; audit was NOT called.
 *  3. Audit throw rolls back entity — handler calls audit, the audit
 *     insert throws inside the tx; the helper returns `{ ok: false }`
 *     with the audit error surfaced.
 *
 * The actual Postgres rollback primitive belongs to Drizzle/Postgres;
 * these tests verify that `withAuditTx` keeps all writes inside that
 * primitive and preserves the throw → envelope contract.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ─── Mocks (must come BEFORE the audit-tx import) ────────────────────────────

type RecordedInsert = { table: string; values: Record<string, unknown> };

const recordedInserts: RecordedInsert[] = [];
let throwOnTable: string | null = null;

function makeTx(stagedInserts: RecordedInsert[]): unknown {
  const insert = vi.fn((table: { __tableName?: string }) => ({
    values: (values: Record<string, unknown>) => {
      const name = table.__tableName ?? "unknown";
      if (throwOnTable === name) {
        return Promise.reject(new Error(`forced failure on ${name}`));
      }
      stagedInserts.push({ table: name, values });
      return Promise.resolve();
    },
  }));
  return { insert };
}

vi.mock("@janusly/db", () => ({
  db: {
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const stagedInserts: RecordedInsert[] = [];
      const tx = makeTx(stagedInserts);
      // Real Drizzle: a throw inside the callback rolls back and rethrows.
      // The mock matches the rethrow behavior; `withAuditTx` catches it.
      const result = await callback(tx);
      recordedInserts.push(...stagedInserts);
      return result;
    }),
  },
  auditLogs: { __tableName: "audit_logs" },
}));

// ─── Imports (after mocks register) ──────────────────────────────────────────

import { withAuditTx } from "./audit-tx";

// A fake entity table marker. The mocked tx.insert uses the `__tableName`
// property to identify which table the caller is targeting.
const fakeEntityTable = { __tableName: "fake_entity" };

beforeEach(() => {
  recordedInserts.length = 0;
  throwOnTable = null;
});

describe("withAuditTx", () => {
  it("commits entity + audit and returns { ok: true, result }", async () => {
    const result = await withAuditTx(async (tx, audit) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tx as any).insert(fakeEntityTable).values({ id: "entity-1", name: "alpha" });
      await audit({
        orgId: "org-1",
        userId: "user-1",
        action: "fake.entity.created",
        targetType: "fake_entity",
        targetId: "entity-1",
        metadata: { foo: "bar" },
      });
      return "ok" as const;
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result).toBe("ok");
    expect(recordedInserts).toHaveLength(2);
    expect(recordedInserts[0]?.table).toBe("fake_entity");
    expect(recordedInserts[0]?.values).toMatchObject({ id: "entity-1", name: "alpha" });
    expect(recordedInserts[1]?.table).toBe("audit_logs");
    expect(recordedInserts[1]?.values).toMatchObject({
      orgId: "org-1",
      userId: "user-1",
      action: "fake.entity.created",
      targetType: "fake_entity",
      targetId: "entity-1",
      metadata: { foo: "bar" },
    });
  });

  it("redacts sensitive-keyed audit metadata before insert", async () => {
    const result = await withAuditTx(async (_tx, audit) => {
      await audit({
        orgId: "org-1",
        userId: "user-1",
        action: "fake.entity.created",
        metadata: {
          apiKey: "sk_test_12345678901234567890",
          nested: {
            Authorization: "Bearer should-not-persist",
            safe: "visible",
          },
        },
      });
    });

    expect(result.ok).toBe(true);
    const auditInsert = recordedInserts.find((r) => r.table === "audit_logs");
    expect(auditInsert?.values.metadata).toMatchObject({
      apiKey: "[redacted]",
      nested: {
        Authorization: "[redacted]",
        safe: "visible",
      },
    });
  });

  it("returns { ok: false } when the handler throws before audit (no audit row)", async () => {
    const result = await withAuditTx(async (tx, _audit) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tx as any).insert(fakeEntityTable).values({ id: "entity-2" });
      throw new Error("downstream validation failed");
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("downstream validation failed");
    expect(recordedInserts).toHaveLength(0);
  });

  it("returns { ok: false } when the audit insert throws inside the tx", async () => {
    throwOnTable = "audit_logs";
    const result = await withAuditTx(async (tx, audit) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tx as any).insert(fakeEntityTable).values({ id: "entity-3" });
      await audit({
        orgId: "org-3",
        userId: null,
        action: "fake.entity.created",
        metadata: { foo: "baz" },
      });
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("audit_logs");
    expect(recordedInserts).toHaveLength(0);
  });
});
