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
  goMakefile,
  supabaseConfig,
] = await Promise.all([
  source("../docker-compose.yml"),
  source("../.github/workflows/ci.yml"),
  source("../go/docker-compose.yml"),
  source("../go/pg18.compose.yml"),
  source("../go/conformance/reference-stack.compose.yml"),
  source("../go/Makefile"),
  source("../supabase/config.toml"),
]);

test("every Janusly-owned PostgreSQL service is fixed to major 18", () => {
  for (const compose of [
    rootCompose,
    goCompose,
    goRevalidationCompose,
    referenceCompose,
  ]) {
    assert.match(compose, /image: pgvector\/pgvector:pg18/);
    assert.doesNotMatch(compose, /pgvector\/pgvector:pg1[4-7]/);
    assert.doesNotMatch(compose, /^\s+image:\s*\$\{/m);
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
