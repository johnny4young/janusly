/**
 * Pluggable object-store abstraction for the `pdf.generate` tool (and any
 * future tool that needs to persist binary artifacts and hand back a URL).
 * Three providers, env-driven resolution at call time, plus a test-override
 * seam — same shape as `mailer.ts`.
 *
 *   - `S3Provider`        — upload via `@aws-sdk/client-s3`. Returns a
 *                           `JANUSLY_OBJECT_STORE_PUBLIC_BASE_URL`-prefixed
 *                           URL when set, otherwise a presigned GET URL via
 *                           `@aws-sdk/s3-request-presigner` (default 1h TTL).
 *                           Honors a custom `endpoint` override so MinIO,
 *                           Cloudflare R2, Backblaze B2, etc. work without
 *                           extra plumbing.
 *   - `LocalDirProvider`  — write to a local directory rooted at
 *                           `JANUSLY_OBJECT_STORE_LOCAL_DIR`. Returns a
 *                           `file://` URL. Used in dev / tests / smoke.
 *   - `NoopProvider`      — returns `{ ok: false, error: "Object store not
 *                           configured", provider: "noop" }`. Default when
 *                           `JANUSLY_OBJECT_STORE_PROVIDER` is unset, so the
 *                           AI-fallback contract holds without throwing.
 *
 * The provider's `put(input)` NEVER throws — network failures, permission
 * errors, and bad bodies all degrade to `{ ok: false, error, provider }`,
 * so write-side tools mirror the AI-fallback contract.
 *
 * Resolution order in `getObjectStore(providerOverride?)`:
 *   1. Test override (`setObjectStoreForTests(provider)`) when set.
 *   2. Tenant override or `JANUSLY_OBJECT_STORE_PROVIDER === "s3"` AND
 *      `JANUSLY_OBJECT_STORE_BUCKET` set.
 *   3. Tenant override or `JANUSLY_OBJECT_STORE_PROVIDER === "local"` AND
 *      `JANUSLY_OBJECT_STORE_LOCAL_DIR` set.
 *   4. Otherwise `NoopProvider`.
 *
 * Used by `packages/engine/src/tool-registry.ts:pdf.generate`.
 *
 * Invariants:
 * - The S3 provider bypasses `fetchHttpTarget` (the SSRF chokepoint) by
 *   design — the bucket endpoint is operator-supplied infrastructure config,
 *   not workflow-author input. The `endpoint` env is the only place that
 *   controls where uploads go; never thread it through workflow JSON.
 * - The per-org `key` prefix (e.g. `orgs/<orgId>/...`) is the only thing
 *   keeping tenants from reading each other's objects. The tool wrapper
 *   constructs the key; this module trusts whatever key it's handed.
 * - `put` returns `{ ok: false, ... }` on failure; it must NEVER throw.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type ObjectStoreProviderName = "s3" | "local" | "noop";

export type ObjectStorePutInput = {
  /** Object key, including any per-org prefix the caller assembled. */
  key: string;
  /** Binary payload. */
  body: Buffer;
  /** Defaults to `application/octet-stream`. */
  contentType?: string;
};

export type ObjectStorePutResult =
  | { ok: true; provider: ObjectStoreProviderName; url: string; key: string }
  | { ok: false; provider: ObjectStoreProviderName; error: string };

export interface ObjectStoreProvider {
  readonly name: ObjectStoreProviderName;
  put(input: ObjectStorePutInput): Promise<ObjectStorePutResult>;
}

/* ------------------------------ providers ------------------------------ */

class NoopObjectStore implements ObjectStoreProvider {
  readonly name = "noop" as const;
  async put(_input: ObjectStorePutInput): Promise<ObjectStorePutResult> {
    return {
      ok: false,
      provider: "noop",
      error:
        "Object store not configured. Set JANUSLY_OBJECT_STORE_PROVIDER=s3|local plus the matching bucket / directory env.",
    };
  }
}

class LocalDirObjectStore implements ObjectStoreProvider {
  readonly name = "local" as const;

  constructor(private readonly rootDir: string) {}

  async put(input: ObjectStorePutInput): Promise<ObjectStorePutResult> {
    try {
      const safeKey = sanitizeRelativeKey(input.key);
      const fullPath = join(this.rootDir, safeKey);
      const resolvedRoot = resolve(this.rootDir);
      const resolvedPath = resolve(fullPath);
      // Defense-in-depth: even though `sanitizeRelativeKey` rejects `..`
      // segments, double-check the final resolved path is contained in
      // the configured root before any disk write. A path-traversal
      // escape would otherwise dump bytes anywhere the worker can write.
      if (!resolvedPath.startsWith(resolvedRoot + sep) && resolvedPath !== resolvedRoot) {
        return { ok: false, provider: "local", error: "object key escapes the configured local directory" };
      }
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, input.body);
      return { ok: true, provider: "local", url: pathToFileURL(fullPath).toString(), key: input.key };
    } catch (err) {
      return { ok: false, provider: "local", error: err instanceof Error ? err.message : String(err) };
    }
  }
}

type S3ObjectStoreOptions = {
  bucket: string;
  region?: string;
  endpoint?: string;
  /**
   * When set, returned URLs are `${publicBaseUrl}/${key}`. Use this when the
   * bucket is fronted by a public CDN or static-site host.
   */
  publicBaseUrl?: string;
  /** Presigned GET URL TTL in seconds. Defaults to 3600. */
  presignedTtlSeconds?: number;
  /**
   * When `endpoint` points at a non-AWS host (MinIO, R2), force path-style
   * URLs (`https://endpoint/bucket/key`) since virtual-host-style
   * (`https://bucket.endpoint/key`) often fails certificate-of-name checks
   * against custom endpoints. Defaults to `true` whenever `endpoint` is set.
   */
  forcePathStyle?: boolean;
};

class S3ObjectStore implements ObjectStoreProvider {
  readonly name = "s3" as const;
  private readonly client: S3Client;

  constructor(private readonly options: S3ObjectStoreOptions) {
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
    });
  }

  async put(input: ObjectStorePutInput): Promise<ObjectStorePutResult> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType ?? "application/octet-stream",
        }),
      );
      const url = await this.urlFor(input.key);
      return { ok: true, provider: "s3", url, key: input.key };
    } catch (err) {
      return { ok: false, provider: "s3", error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async urlFor(key: string): Promise<string> {
    if (this.options.publicBaseUrl) {
      return `${trimTrailingSlash(this.options.publicBaseUrl)}/${key.split("/").map(encodeURIComponent).join("/")}`;
    }
    const ttl = this.options.presignedTtlSeconds ?? 3600;
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      { expiresIn: ttl },
    );
  }
}

/* --------------------------- resolver + DI seam ----------------------- */

let testOverride: ObjectStoreProvider | null = null;

/** Test-only override. Pass `null` to clear. */
export function setObjectStoreForTests(provider: ObjectStoreProvider | null): void {
  testOverride = provider;
}

/**
 * Resolve the active object store for the current call. Reads env every
 * call so tenant overrides take effect without restart (see CLAUDE.md
 * "Org config" — `objectstore.*` overrides feed this resolver via
 * `applyOrgConfigToEnv`).
 */
export function getObjectStore(providerOverride?: string): ObjectStoreProvider {
  if (testOverride) return testOverride;
  const requested = (providerOverride ?? process.env.JANUSLY_OBJECT_STORE_PROVIDER)?.toLowerCase();

  if (requested === "noop") {
    return new NoopObjectStore();
  }

  if (requested === "s3") {
    const bucket = process.env.JANUSLY_OBJECT_STORE_BUCKET;
    if (!bucket) return new NoopObjectStore();
    return new S3ObjectStore({
      bucket,
      region: process.env.JANUSLY_OBJECT_STORE_REGION,
      endpoint: process.env.JANUSLY_OBJECT_STORE_ENDPOINT,
      publicBaseUrl: process.env.JANUSLY_OBJECT_STORE_PUBLIC_BASE_URL,
      presignedTtlSeconds: parsePositiveInt(process.env.JANUSLY_OBJECT_STORE_PRESIGNED_TTL_SEC) ?? undefined,
    });
  }

  if (requested === "local") {
    const rootDir = process.env.JANUSLY_OBJECT_STORE_LOCAL_DIR;
    if (!rootDir) return new NoopObjectStore();
    return new LocalDirObjectStore(rootDir);
  }

  return new NoopObjectStore();
}

/* --------------------------------- utils ----------------------------- */

function sanitizeRelativeKey(key: string): string {
  // Keys are constructed by the tool wrapper from per-org context; this
  // is the bottom of a defense-in-depth stack against `../` escapes.
  if (!key || key.startsWith("/")) {
    throw new Error("object key must be a non-empty relative path");
  }
  const segments = key.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error("object key contains an unsafe path segment");
    }
  }
  return key;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return null;
  return Math.floor(value);
}
