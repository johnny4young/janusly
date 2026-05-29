/**
 * Pure-unit tests for `rotateCredentialSecretRef`'s CAS contract.
 *
 * `@janusly/db` is mocked so no DB is hit — these prove the branch logic:
 * a returned row → success; zero rows + an existing credential → conflict;
 * zero rows + no credential → not_found. SQL predicate correctness (the
 * org/name/updatedAt filters, tenant scope) is exercised against real
 * Postgres in the live smoke, since a mocked builder can't prove a WHERE.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updateReturningMock = vi.fn();
const selectWhereMock = vi.fn();

vi.mock("@janusly/db", () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: updateReturningMock })) })),
    })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: selectWhereMock })) })),
  },
  credentials: {
    id: "id_col",
    orgId: "org_id_col",
    name: "name_col",
    secretRef: "secret_ref_col",
    updatedAt: "updated_at_col",
  } as Record<string, string>,
}));

vi.mock("drizzle-orm", () => ({
  and: (...conds: unknown[]) => ({ and: conds }),
  eq: (col: unknown, val: unknown) => ({ eq: [col, val] }),
}));

import { rotateCredentialSecretRef } from "./credentialsRepo";

beforeEach(() => {
  updateReturningMock.mockReset();
  selectWhereMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rotateCredentialSecretRef", () => {
  it("returns ok with the new updatedAt when a row is updated", async () => {
    const updatedAt = new Date("2026-05-29T00:00:00.000Z");
    updateReturningMock.mockResolvedValue([{ updatedAt }]);

    const result = await rotateCredentialSecretRef({
      orgId: "org-1",
      name: "slack-prod",
      newSecretRef: "SLACK_WEBHOOK_V2",
    });

    expect(result).toEqual({ ok: true, updatedAt });
    // No fallback SELECT when the UPDATE already matched a row.
    expect(selectWhereMock).not.toHaveBeenCalled();
  });

  it("returns conflict when the UPDATE matches nothing but the credential exists (stale If-Match)", async () => {
    updateReturningMock.mockResolvedValue([]);
    selectWhereMock.mockResolvedValue([{ id: "cred-1" }]);

    const result = await rotateCredentialSecretRef({
      orgId: "org-1",
      name: "slack-prod",
      newSecretRef: "SLACK_WEBHOOK_V2",
      ifMatchUpdatedAt: "2026-05-28T00:00:00.000Z",
    });

    expect(result).toEqual({ ok: false, reason: "conflict" });
  });

  it("returns conflict for a malformed If-Match without sending an invalid Date to UPDATE", async () => {
    selectWhereMock.mockResolvedValue([{ id: "cred-1" }]);

    const result = await rotateCredentialSecretRef({
      orgId: "org-1",
      name: "slack-prod",
      newSecretRef: "SLACK_WEBHOOK_V2",
      ifMatchUpdatedAt: "stale",
    });

    expect(result).toEqual({ ok: false, reason: "conflict" });
    expect(updateReturningMock).not.toHaveBeenCalled();
  });

  it("returns not_found when the UPDATE matches nothing and no such credential exists", async () => {
    updateReturningMock.mockResolvedValue([]);
    selectWhereMock.mockResolvedValue([]);

    const result = await rotateCredentialSecretRef({
      orgId: "org-1",
      name: "ghost",
      newSecretRef: "SLACK_WEBHOOK_V2",
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});
