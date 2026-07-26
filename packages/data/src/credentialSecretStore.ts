/**
 * Encrypted credential secret store.
 *
 * Used by credential administration, integration tools, signed callbacks, and
 * readiness checks. New tenant secrets are envelope-encrypted in PostgreSQL;
 * legacy environment-variable references remain readable during migration.
 *
 * Invariants:
 * - The root key is loaded from one process-level secret and never persisted.
 * - Every encrypted value uses a fresh data key and independent GCM nonces.
 * - AAD binds ciphertext and wrapped key to org, credential, and version.
 * - Resolution is org-scoped and revoked rows fail closed.
 * - Public/runtime errors never contain plaintext, ciphertext, or secret refs.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";

import { and, eq, isNull, sql } from "drizzle-orm";
import { credentialSecretVersions, db } from "@janusly/db";

import type { DbOrTx } from "./audit-tx";
import { getCredentialByName } from "./credentialsRepo";

const SECRET_REF_PREFIX = "janusly-secret://";
const ROOT_KEY_BYTES = 32;
const DATA_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_SECRET_BYTES = 64 * 1024;
const KEY_VERSION = 1;
const MANAGED_SECRET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type EncryptedEnvelope = {
  ciphertext: string;
  dataNonce: string;
  dataTag: string;
  wrappedKey: string;
  wrapNonce: string;
  wrapTag: string;
  keyVersion: number;
};

let cachedRootKey: Buffer | null = null;

// First warning per (row id, reason) per process. Resolution deliberately
// fails closed as null (callers keep their stable generic missing-credential
// envelope), but silent nulls made a replica misconfiguration — API and
// worker holding different root keys — undiagnosable from the outside. The
// warning carries only stable identifiers, never key material, ciphertext,
// or secret refs. Bounded so a pathological table can't grow it forever.
const warnedResolutionFailures = new Set<string>();
const WARNED_RESOLUTION_FAILURES_MAX = 1000;

type ResolutionFailureReason =
  | "unsupported_key_version"
  | "root_key_unavailable"
  | "decrypt_failed";

function warnResolutionFailure(
  reason: ResolutionFailureReason,
  orgId: string,
  secretVersionId: string,
): void {
  if (warnedResolutionFailures.size >= WARNED_RESOLUTION_FAILURES_MAX) {
    warnedResolutionFailures.clear();
  }
  const key = `${secretVersionId}:${reason}`;
  if (warnedResolutionFailures.has(key)) return;
  warnedResolutionFailures.add(key);
  console.warn("[credential-secret-store] managed secret failed closed", {
    reason,
    orgId,
    secretVersionId,
  });
}

/** Build the opaque reference stored on `credentials.secret_ref`. */
export function credentialSecretRef(id: string): string {
  return `${SECRET_REF_PREFIX}${id}`;
}

/** Return the encrypted-row id, or null for a legacy environment reference. */
export function parseCredentialSecretRef(secretRef: string): string | null {
  if (!secretRef.startsWith(SECRET_REF_PREFIX)) return null;
  const id = secretRef.slice(SECRET_REF_PREFIX.length);
  return MANAGED_SECRET_ID.test(id) ? id : null;
}

/** True when a reference belongs to the PostgreSQL-backed secret provider. */
export function isManagedCredentialSecretRef(secretRef: string): boolean {
  return parseCredentialSecretRef(secretRef) !== null;
}

function decodeRootKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const base64 = Buffer.from(trimmed, "base64");
  if (base64.length === ROOT_KEY_BYTES && base64.toString("base64").replace(/=+$/u, "") === trimmed.replace(/=+$/u, "")) {
    return base64;
  }
  if (/^[0-9a-f]{64}$/iu.test(trimmed)) return Buffer.from(trimmed, "hex");
  throw new Error("credential_secret_root_key_invalid");
}

function loadRootKey(): Buffer {
  if (cachedRootKey) return cachedRootKey;
  const inline = process.env.JANUSLY_CREDENTIAL_MASTER_KEY;
  const file = process.env.JANUSLY_CREDENTIAL_MASTER_KEY_FILE;
  if (inline?.trim()) {
    cachedRootKey = decodeRootKey(inline);
    return cachedRootKey;
  }
  if (file?.trim()) {
    cachedRootKey = decodeRootKey(readFileSync(file, "utf8"));
    return cachedRootKey;
  }
  throw new Error("credential_secret_root_key_missing");
}

/**
 * Boot-time probe for the configured root key.
 *
 * Called by API and worker startup (right after `assertMigrationsApplied`) so
 * a malformed inline key or an unreadable key file fails fast at deploy time
 * instead of surfacing as the first credential write's 500 — the key is
 * otherwise loaded lazily. An unset key stays legal (deployments on legacy
 * environment references only) and reports `configured: false` so the caller
 * can log the posture.
 */
export function assertCredentialRootKeyUsable(): { configured: boolean } {
  const inline = process.env.JANUSLY_CREDENTIAL_MASTER_KEY;
  const file = process.env.JANUSLY_CREDENTIAL_MASTER_KEY_FILE;
  if (!inline?.trim() && !file?.trim()) return { configured: false };
  loadRootKey();
  return { configured: true };
}

function aad(kind: "data" | "wrap", orgId: string, credentialId: string, version: number): Buffer {
  return Buffer.from(`janusly:credential:${kind}:v1:${orgId}:${credentialId}:${version}`, "utf8");
}

function encryptAesGcm(plaintext: Buffer, key: Buffer, associatedData: Buffer): {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
} {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(associatedData);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag() };
}

function decryptAesGcm(
  ciphertext: Buffer,
  key: Buffer,
  nonce: Buffer,
  tag: Buffer,
  associatedData: Buffer,
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: AUTH_TAG_BYTES });
  decipher.setAAD(associatedData);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function encryptEnvelope(input: {
  orgId: string;
  credentialId: string;
  version: number;
  secretValue: string;
}): EncryptedEnvelope {
  const plaintext = Buffer.from(input.secretValue, "utf8");
  if (plaintext.length === 0 || plaintext.length > MAX_SECRET_BYTES) {
    plaintext.fill(0);
    throw new Error("credential_secret_value_invalid");
  }
  const dataKey = randomBytes(DATA_KEY_BYTES);
  try {
    const encrypted = encryptAesGcm(
      plaintext,
      dataKey,
      aad("data", input.orgId, input.credentialId, input.version),
    );
    const wrapped = encryptAesGcm(
      dataKey,
      loadRootKey(),
      aad("wrap", input.orgId, input.credentialId, input.version),
    );
    return {
      ciphertext: encrypted.ciphertext.toString("base64"),
      dataNonce: encrypted.nonce.toString("base64"),
      dataTag: encrypted.tag.toString("base64"),
      wrappedKey: wrapped.ciphertext.toString("base64"),
      wrapNonce: wrapped.nonce.toString("base64"),
      wrapTag: wrapped.tag.toString("base64"),
      keyVersion: KEY_VERSION,
    };
  } finally {
    plaintext.fill(0);
    dataKey.fill(0);
  }
}

/** Insert one encrypted version and return its opaque reference. */
export async function createCredentialSecretVersion(input: {
  id?: string;
  orgId: string;
  credentialId: string;
  secretValue: string;
  createdBy?: string | null;
}, tx: DbOrTx = db): Promise<{ id: string; version: number; secretRef: string }> {
  const versionRows = await tx
    .select({
      nextVersion: sql<number>`coalesce(max(${credentialSecretVersions.version}), 0) + 1`,
    })
    .from(credentialSecretVersions)
    .where(and(
      eq(credentialSecretVersions.orgId, input.orgId),
      eq(credentialSecretVersions.credentialId, input.credentialId),
    ));
  const version = Number(versionRows[0]?.nextVersion ?? 1);
  const id = input.id ?? crypto.randomUUID();
  const envelope = encryptEnvelope({ ...input, version });
  await tx.insert(credentialSecretVersions).values({
    id,
    orgId: input.orgId,
    credentialId: input.credentialId,
    version,
    ...envelope,
    createdBy: input.createdBy ?? null,
  });
  return { id, version, secretRef: credentialSecretRef(id) };
}

/** Revoke one managed secret reference. Legacy environment refs are a no-op. */
export async function revokeCredentialSecretRef(
  orgId: string,
  secretRef: string,
  tx: DbOrTx = db,
): Promise<void> {
  const id = parseCredentialSecretRef(secretRef);
  if (!id) return;
  await tx
    .update(credentialSecretVersions)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(credentialSecretVersions.id, id),
      eq(credentialSecretVersions.orgId, orgId),
      isNull(credentialSecretVersions.revokedAt),
    ));
}

/**
 * Resolve a secret reference.
 *
 * Managed refs are decrypted from an org-scoped, non-revoked row. Other refs
 * keep the legacy environment-variable behavior. Any decrypt/configuration
 * error fails closed as null so callers can return their stable generic
 * missing-credential envelope.
 */
export async function resolveCredentialSecretRef(
  orgId: string,
  secretRef: string,
): Promise<string | null> {
  const id = parseCredentialSecretRef(secretRef);
  if (!id) {
    // A damaged or forged managed reference must never fall through to the
    // legacy environment provider, even if a process environment happens to
    // contain that unusual name.
    if (secretRef.startsWith(SECRET_REF_PREFIX)) return null;
    const value = process.env[secretRef];
    return value?.trim() ? value : null;
  }
  try {
    const rows = await db
      .select()
      .from(credentialSecretVersions)
      .where(and(
        eq(credentialSecretVersions.id, id),
        eq(credentialSecretVersions.orgId, orgId),
        isNull(credentialSecretVersions.revokedAt),
      ))
      .limit(1);
    const row = rows[0];
    // A missing row is a legitimate null (revoked, deleted, or foreign org)
    // and stays silent; an unknown key version means this process is older
    // than the row's encryption scheme and deserves a warning.
    if (!row) return null;
    if (row.keyVersion !== KEY_VERSION) {
      warnResolutionFailure("unsupported_key_version", orgId, id);
      return null;
    }
    const dataKey = decryptAesGcm(
      Buffer.from(row.wrappedKey, "base64"),
      loadRootKey(),
      Buffer.from(row.wrapNonce, "base64"),
      Buffer.from(row.wrapTag, "base64"),
      aad("wrap", row.orgId, row.credentialId, row.version),
    );
    try {
      const plaintext = decryptAesGcm(
        Buffer.from(row.ciphertext, "base64"),
        dataKey,
        Buffer.from(row.dataNonce, "base64"),
        Buffer.from(row.dataTag, "base64"),
        aad("data", row.orgId, row.credentialId, row.version),
      );
      try {
        return plaintext.toString("utf8");
      } finally {
        plaintext.fill(0);
      }
    } finally {
      dataKey.fill(0);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    warnResolutionFailure(
      message.includes("credential_secret_root_key") ? "root_key_unavailable" : "decrypt_failed",
      orgId,
      id,
    );
    return null;
  }
}

/** Resolve a credential by tenant, kind, and name without exposing its ref. */
export async function resolveCredentialSecret(
  orgId: string,
  kind: string,
  name: string,
): Promise<string | null> {
  const credential = await getCredentialByName(orgId, kind, name);
  return credential
    ? resolveCredentialSecretRef(orgId, credential.secretRef)
    : null;
}

/** Health/readiness helper that never returns the secret value. */
export async function hasCredentialSecretRef(orgId: string, secretRef: string): Promise<boolean> {
  return (await resolveCredentialSecretRef(orgId, secretRef)) !== null;
}

/** Test-only reset for the root-key cache and the warn-once dedupe. */
export function _resetCredentialRootKeyForTests(): void {
  cachedRootKey?.fill(0);
  cachedRootKey = null;
  warnedResolutionFailures.clear();
}
