/**
 * Cryptographic and compatibility tests for the credential Secret Store.
 *
 * The database builder is intentionally in-memory; these tests exercise the
 * real AES-GCM envelope implementation, AAD binding, fail-closed resolution,
 * root-key validation, and legacy environment references.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  eqCalls: [] as Array<[unknown, unknown]>,
}));

vi.mock("@janusly/db", () => ({
  credentialSecretVersions: {
    id: "id",
    orgId: "org_id",
    credentialId: "credential_id",
    version: "version",
    revokedAt: "revoked_at",
  },
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => database.rows),
        })),
      })),
    })),
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...predicates: unknown[]) => ({ predicates }),
  eq: (column: unknown, value: unknown) => {
    database.eqCalls.push([column, value]);
    return { column, value };
  },
  isNull: (column: unknown) => ({ isNull: column }),
  sql: () => ({ kind: "sql" }),
}));

vi.mock("./credentialsRepo", () => ({
  getCredentialByName: vi.fn(),
}));

import {
  _resetCredentialRootKeyForTests,
  assertCredentialRootKeyUsable,
  createCredentialSecretVersion,
  credentialSecretRef,
  isManagedCredentialSecretRef,
  parseCredentialSecretRef,
  resolveCredentialSecretRef,
} from "./credentialSecretStore";

const secretId = "a663346c-30a4-4d16-b305-cc3fb011b708";
const credentialId = "219b452c-c075-49eb-8ef9-3cbb00bf9a27";

function makeTx() {
  const inserted: Array<Record<string, unknown>> = [];
  return {
    inserted,
    tx: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{ nextVersion: 1 }]),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(async (value: Record<string, unknown>) => {
          inserted.push(value);
        }),
      })),
    },
  };
}

beforeEach(() => {
  database.rows = [];
  database.eqCalls = [];
  vi.stubEnv("JANUSLY_CREDENTIAL_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("JANUSLY_CREDENTIAL_MASTER_KEY_FILE", "");
  _resetCredentialRootKeyForTests();
});

afterEach(() => {
  _resetCredentialRootKeyForTests();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("managed credential secrets", () => {
  it("round-trips through a real envelope without persisting plaintext", async () => {
    const { tx, inserted } = makeTx();
    const plaintext = "pagerduty-token-that-must-not-leak";

    const created = await createCredentialSecretVersion({
      id: secretId,
      orgId: "org-1",
      credentialId,
      secretValue: plaintext,
      createdBy: "user-1",
    }, tx as never);

    expect(created).toEqual({
      id: secretId,
      version: 1,
      secretRef: credentialSecretRef(secretId),
    });
    expect(inserted).toHaveLength(1);
    expect(JSON.stringify(inserted[0])).not.toContain(plaintext);
    database.rows = [inserted[0] ?? {}];

    await expect(resolveCredentialSecretRef("org-1", created.secretRef)).resolves.toBe(plaintext);
    expect(database.eqCalls).toContainEqual(["org_id", "org-1"]);
  });

  it("fails closed when authenticated metadata is changed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tx, inserted } = makeTx();
    const created = await createCredentialSecretVersion({
      id: secretId,
      orgId: "org-1",
      credentialId,
      secretValue: "sensitive",
    }, tx as never);
    database.rows = [{ ...inserted[0], credentialId: "different-credential" }];

    await expect(resolveCredentialSecretRef("org-1", created.secretRef)).resolves.toBeNull();
    warn.mockRestore();
  });

  it("warns once per row and reason when resolution fails closed, without leaking material", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tx, inserted } = makeTx();
    const created = await createCredentialSecretVersion({
      id: secretId,
      orgId: "org-1",
      credentialId,
      secretValue: "sensitive",
    }, tx as never);
    // Replica-mismatch scenario: this process holds a different root key than
    // the one that encrypted the row.
    vi.stubEnv("JANUSLY_CREDENTIAL_MASTER_KEY", Buffer.alloc(32, 9).toString("base64"));
    _resetCredentialRootKeyForTests();
    database.rows = [inserted[0] ?? {}];

    await expect(resolveCredentialSecretRef("org-1", created.secretRef)).resolves.toBeNull();
    await expect(resolveCredentialSecretRef("org-1", created.secretRef)).resolves.toBeNull();

    const storeWarnings = warn.mock.calls.filter(([first]) =>
      String(first).includes("credential-secret-store"));
    expect(storeWarnings).toHaveLength(1);
    expect(storeWarnings[0]?.[1]).toMatchObject({
      reason: "decrypt_failed",
      orgId: "org-1",
      secretVersionId: secretId,
    });
    expect(JSON.stringify(storeWarnings)).not.toContain("sensitive");
    warn.mockRestore();
  });

  it("warns and fails closed on an unsupported key version", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tx, inserted } = makeTx();
    const created = await createCredentialSecretVersion({
      id: secretId,
      orgId: "org-1",
      credentialId,
      secretValue: "sensitive",
    }, tx as never);
    database.rows = [{ ...inserted[0], keyVersion: 2 }];

    await expect(resolveCredentialSecretRef("org-1", created.secretRef)).resolves.toBeNull();

    const storeWarnings = warn.mock.calls.filter(([first]) =>
      String(first).includes("credential-secret-store"));
    expect(storeWarnings).toHaveLength(1);
    expect(storeWarnings[0]?.[1]).toMatchObject({ reason: "unsupported_key_version" });
    warn.mockRestore();
  });

  it("rejects a missing or malformed external root key before insert", async () => {
    const { tx, inserted } = makeTx();
    vi.stubEnv("JANUSLY_CREDENTIAL_MASTER_KEY", "");
    _resetCredentialRootKeyForTests();

    await expect(createCredentialSecretVersion({
      id: secretId,
      orgId: "org-1",
      credentialId,
      secretValue: "sensitive",
    }, tx as never)).rejects.toThrow("credential_secret_root_key_missing");
    expect(inserted).toHaveLength(0);

    vi.stubEnv("JANUSLY_CREDENTIAL_MASTER_KEY", "too-short");
    _resetCredentialRootKeyForTests();
    await expect(createCredentialSecretVersion({
      id: secretId,
      orgId: "org-1",
      credentialId,
      secretValue: "sensitive",
    }, tx as never)).rejects.toThrow("credential_secret_root_key_invalid");
  });
});

describe("boot-time root key probe", () => {
  it("reports unconfigured when neither environment variable is set", () => {
    vi.stubEnv("JANUSLY_CREDENTIAL_MASTER_KEY", "");
    vi.stubEnv("JANUSLY_CREDENTIAL_MASTER_KEY_FILE", "");
    _resetCredentialRootKeyForTests();

    expect(assertCredentialRootKeyUsable()).toEqual({ configured: false });
  });

  it("accepts a well-formed configured key", () => {
    expect(assertCredentialRootKeyUsable()).toEqual({ configured: true });
  });

  it("throws at boot on a malformed key instead of at the first write", () => {
    vi.stubEnv("JANUSLY_CREDENTIAL_MASTER_KEY", "not-a-key");
    _resetCredentialRootKeyForTests();

    expect(() => assertCredentialRootKeyUsable()).toThrow("credential_secret_root_key_invalid");
  });

  it("throws at boot on an unreadable key file", () => {
    vi.stubEnv("JANUSLY_CREDENTIAL_MASTER_KEY", "");
    vi.stubEnv("JANUSLY_CREDENTIAL_MASTER_KEY_FILE", "/nonexistent/janusly-test-root-key");
    _resetCredentialRootKeyForTests();

    expect(() => assertCredentialRootKeyUsable()).toThrow();
  });
});

describe("reference compatibility", () => {
  it("recognizes only well-formed managed references", () => {
    expect(parseCredentialSecretRef(credentialSecretRef(secretId))).toBe(secretId);
    expect(isManagedCredentialSecretRef(credentialSecretRef(secretId))).toBe(true);
    expect(parseCredentialSecretRef("janusly-secret://not-a-uuid")).toBeNull();
    expect(parseCredentialSecretRef("janusly-secret://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
    expect(parseCredentialSecretRef("janusly-secret://00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(parseCredentialSecretRef("PAGERDUTY_TOKEN")).toBeNull();
  });

  it("keeps legacy environment references without exposing blank values", async () => {
    vi.stubEnv("PAGERDUTY_TOKEN", "legacy-token");
    await expect(resolveCredentialSecretRef("org-1", "PAGERDUTY_TOKEN")).resolves.toBe("legacy-token");
    vi.stubEnv("PAGERDUTY_TOKEN", "   ");
    await expect(resolveCredentialSecretRef("org-1", "PAGERDUTY_TOKEN")).resolves.toBeNull();
  });

  it("fails closed for malformed managed references instead of consulting the environment", async () => {
    const malformed = "janusly-secret://not-a-uuid";
    vi.stubEnv(malformed, "must-not-resolve");

    await expect(resolveCredentialSecretRef("org-1", malformed)).resolves.toBeNull();
    expect(database.eqCalls).toEqual([]);
  });
});
