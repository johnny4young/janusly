import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

const [
  rootCompose,
  workflow,
  goCompose,
  goRevalidationCompose,
  referenceCompose,
  benchmarkCompose,
  webQualificationCompose,
  goMakefile,
  supabaseConfig,
] = await Promise.all([
  source("../docker-compose.yml"),
  source("../.github/workflows/ci.yml"),
  source("../go/docker-compose.yml"),
  source("../go/pg18.compose.yml"),
  source("../go/conformance/reference-stack.compose.yml"),
  source("../go/conformance/benchmark.compose.yml"),
  source("../go/conformance/web-qualification.compose.yml"),
  source("../go/Makefile"),
  source("../supabase/config.toml"),
]);

const ownedPostgresComposes = [
  rootCompose,
  goCompose,
  goRevalidationCompose,
  referenceCompose,
  benchmarkCompose,
  webQualificationCompose,
];

test("every Janusly-owned PostgreSQL service is fixed to major 18", () => {
  for (const compose of ownedPostgresComposes) {
    assert.match(compose, /image: pgvector\/pgvector:pg18/);
    assert.doesNotMatch(compose, /pgvector\/pgvector:pg1[4-7]/);
    assert.doesNotMatch(compose, /^\s+image:\s*\$\{/m);
  }
});

test("every Janusly-owned PostgreSQL service publishes only on loopback", () => {
  for (const compose of ownedPostgresComposes) {
    const published = [...compose.matchAll(/^\s+- "([^"]+:5432)"$/gm)]
      .map(match => match[1]);
    assert.ok(published.length > 0, "expected at least one published PostgreSQL port");
    assert.ok(
      published.every(entry => entry.startsWith("127.0.0.1:")),
      published.join("\n"),
    );
  }
});

test("CI and the Go revalidation target name PostgreSQL 18 only", () => {
  assert.match(workflow, /^  test_integration_pg18:$/m);
  assert.match(workflow, /Integration lanes \(real Postgres 18\)/);
  assert.match(workflow, /image: pgvector\/pgvector:pg18/);
  assert.doesNotMatch(workflow, /test_compat_pg15|pgvector\/pgvector:pg15/);

  assert.match(goMakefile, /^test-pg18:$/m);
  assert.match(goMakefile, /pg18\.compose\.yml/);
  assert.doesNotMatch(goMakefile, /test-pg15|pg15\.compose\.yml/);
});

test("the optional Supabase Auth lab keeps its explicit upstream exception", () => {
  assert.match(supabaseConfig, /^major_version = 17$/m);
  assert.match(supabaseConfig, /Supabase CLI 2\.109\.1 rejects major 18/);
});
