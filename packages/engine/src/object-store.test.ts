/**
 * Tests for the pluggable object-store abstraction backing `pdf.generate`.
 * Covers the env-driven resolver, the LocalDir round-trip (this is the
 * provider that powers dev / smoke without S3), and the noop fallback +
 * key-traversal defenses.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getObjectStore, setObjectStoreForTests } from "./object-store";

let scratchDir: string;

beforeEach(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), "janusly-objstore-"));
  setObjectStoreForTests(null);
});

afterEach(async () => {
  setObjectStoreForTests(null);
  vi.unstubAllEnvs();
  await rm(scratchDir, { recursive: true, force: true });
});

describe("getObjectStore — env resolution", () => {
  it("returns the noop provider when JANUSLY_OBJECT_STORE_PROVIDER is unset", async () => {
    const store = getObjectStore();
    expect(store.name).toBe("noop");
    const result = await store.put({ key: "ignored", body: Buffer.from("hi") });
    expect(result).toMatchObject({ ok: false, provider: "noop" });
  });

  it("falls back to noop when 'local' is requested but the dir env is missing", async () => {
    vi.stubEnv("JANUSLY_OBJECT_STORE_PROVIDER", "local");
    const store = getObjectStore();
    expect(store.name).toBe("noop");
  });

  it("falls back to noop when 's3' is requested but no bucket is set", async () => {
    vi.stubEnv("JANUSLY_OBJECT_STORE_PROVIDER", "s3");
    const store = getObjectStore();
    expect(store.name).toBe("noop");
  });

  it("respects the explicit provider override argument", () => {
    vi.stubEnv("JANUSLY_OBJECT_STORE_PROVIDER", "noop");
    vi.stubEnv("JANUSLY_OBJECT_STORE_LOCAL_DIR", scratchDir);
    const store = getObjectStore("local");
    expect(store.name).toBe("local");
  });
});

describe("LocalDirProvider — round trip", () => {
  it("writes the buffer to disk and returns a file:// URL", async () => {
    vi.stubEnv("JANUSLY_OBJECT_STORE_PROVIDER", "local");
    vi.stubEnv("JANUSLY_OBJECT_STORE_LOCAL_DIR", scratchDir);

    const store = getObjectStore();
    const body = Buffer.from("%PDF-1.4 fake pdf bytes\n", "utf8");
    const result = await store.put({ key: "orgs/org-1/pdfs/run-1/node-1/invoice.pdf", body });

    if (!result.ok) throw new Error(`local provider returned !ok: ${result.error}`);

    expect(result.provider).toBe("local");
    expect(result.url.startsWith("file://")).toBe(true);
    expect(result.key).toBe("orgs/org-1/pdfs/run-1/node-1/invoice.pdf");

    const onDisk = await readFile(fileURLToPath(result.url));
    expect(onDisk.equals(body)).toBe(true);
  });

  it("isolates orgs by per-org key prefix", async () => {
    vi.stubEnv("JANUSLY_OBJECT_STORE_PROVIDER", "local");
    vi.stubEnv("JANUSLY_OBJECT_STORE_LOCAL_DIR", scratchDir);
    const store = getObjectStore();

    const a = await store.put({
      key: "orgs/org-A/pdfs/secret.pdf",
      body: Buffer.from("A's secret"),
    });
    const b = await store.put({
      key: "orgs/org-B/pdfs/secret.pdf",
      body: Buffer.from("B's secret"),
    });
    if (!a.ok || !b.ok) throw new Error("local provider failed");

    expect(a.url).not.toBe(b.url);
    const aBytes = await readFile(fileURLToPath(a.url));
    const bBytes = await readFile(fileURLToPath(b.url));
    expect(aBytes.toString("utf8")).toBe("A's secret");
    expect(bBytes.toString("utf8")).toBe("B's secret");
  });

  it("rejects keys with traversal segments before any filesystem write", async () => {
    vi.stubEnv("JANUSLY_OBJECT_STORE_PROVIDER", "local");
    vi.stubEnv("JANUSLY_OBJECT_STORE_LOCAL_DIR", scratchDir);
    const store = getObjectStore();

    const result = await store.put({
      key: "orgs/../escape.pdf",
      body: Buffer.from("nope"),
    });
    expect(result).toMatchObject({ ok: false, provider: "local" });
  });

  it("rejects absolute keys", async () => {
    vi.stubEnv("JANUSLY_OBJECT_STORE_PROVIDER", "local");
    vi.stubEnv("JANUSLY_OBJECT_STORE_LOCAL_DIR", scratchDir);
    const store = getObjectStore();

    const result = await store.put({
      key: "/etc/passwd",
      body: Buffer.from("nope"),
    });
    expect(result).toMatchObject({ ok: false, provider: "local" });
  });
});

describe("setObjectStoreForTests", () => {
  it("overrides the resolver until cleared", async () => {
    let captured: { key: string; bytes: number } | null = null;
    setObjectStoreForTests({
      name: "noop",
      async put(input) {
        captured = { key: input.key, bytes: input.body.length };
        return { ok: true, provider: "noop", url: "test://override", key: input.key };
      },
    });

    const result = await getObjectStore().put({ key: "k", body: Buffer.from("hi") });
    expect(result).toMatchObject({ ok: true, url: "test://override", key: "k" });
    expect(captured).toEqual({ key: "k", bytes: 2 });

    setObjectStoreForTests(null);
    expect(getObjectStore().name).toBe("noop");
  });
});
