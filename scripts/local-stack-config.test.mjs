import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const compose = await readFile(new URL("../deploy/local/compose.yml", import.meta.url), "utf8");
const localEnvExample = await readFile(new URL("../deploy/local/local.env.example", import.meta.url), "utf8");
const webDockerfile = await readFile(new URL("../Dockerfile.web", import.meta.url), "utf8");
const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
const supabaseConfig = await readFile(new URL("../supabase/config.toml", import.meta.url), "utf8");

function serviceBlock(name) {
  const match = compose.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|^volumes:)`, "m"));
  assert.ok(match, `missing ${name} service block`);
  return match[0];
}

test("persistent local stack uses one Supabase database and separate runtime services", () => {
  for (const service of ["redis", "provider-simulator", "migrate", "api", "worker", "web"]) {
    assert.match(compose, new RegExp(`^  ${service}:`, "m"));
  }
  assert.doesNotMatch(compose, /^  postgres:/m);
  assert.doesNotMatch(compose, /^  seed:/m);
  assert.doesNotMatch(compose, /^  postgres_data:/m);
  assert.match(compose, /DATABASE_URL: \$\{JANUSLY_LOCAL_DATABASE_URL:\?/);
  assert.match(compose, /redis_data:\/data/);
  assert.match(compose, /provider_data:\/data/);
  assert.match(compose, /condition: service_completed_successfully/);
  assert.match(compose, /restart: unless-stopped/);
  for (const service of ["migrate", "api", "worker"]) {
    assert.match(serviceBlock(service), /host\.docker\.internal:host-gateway/);
  }
  assert.match(supabaseConfig, /^\[db\]$/m);
  assert.match(supabaseConfig, /^port = 7432$/m);
  assert.match(supabaseConfig, /^\[db\.seed\][\s\S]*?^enabled = false$/m);
  assert.match(supabaseConfig, /^schemas = \["graphql_public"\]$/m);
  assert.doesNotMatch(supabaseConfig, /^schemas = .*"public"/m);
});

test("local published ports are loopback-only", () => {
  const portBlocks = [...compose.matchAll(/^\s{4}ports:\n((?:\s{6}- "[^"]+"\n?)+)/gm)];
  const published = portBlocks.flatMap(([, block]) => (
    [...block.matchAll(/^\s+- "([^"]+)"$/gm)].map((match) => match[1])
  ));
  assert.ok(published.length >= 6);
  assert.ok(published.every((entry) => entry.startsWith("127.0.0.1:")), published.join("\n"));
});

test("local web and API use uncommon host ports while retaining internal ports", () => {
  assert.match(localEnvExample, /^JANUSLY_LOCAL_WEB_PORT=7310$/m);
  assert.match(localEnvExample, /^JANUSLY_LOCAL_API_PORT=7311$/m);
  assert.match(localEnvExample, /^JANUSLY_LOCAL_API_URL=http:\/\/localhost:7311$/m);
  assert.match(localEnvExample, /^JANUSLY_LOCAL_WEB_ORIGINS=http:\/\/localhost:7310,http:\/\/127\.0\.0\.1:7310$/m);
  assert.match(compose, /\$\{JANUSLY_LOCAL_WEB_PORT:-7310\}:3000/);
  assert.match(compose, /\$\{JANUSLY_LOCAL_API_PORT:-7311\}:3001/);
  assert.doesNotMatch(compose, /JANUSLY_LOCAL_WEB_PORT:-3000/);
  assert.doesNotMatch(compose, /JANUSLY_LOCAL_API_PORT:-3001/);
});

test("local provider routing is explicitly gated and private-target access is visible", () => {
  assert.match(compose, /JANUSLY_LOCAL_INTEGRATION_SIMULATOR: \$\{JANUSLY_LOCAL_INTEGRATION_SIMULATOR:-true\}/);
  assert.match(compose, /ALLOW_PRIVATE_HTTP_TARGETS: "true"/);
  assert.match(compose, /JANUSLY_MAILER_PROVIDER: \$\{JANUSLY_MAILER_PROVIDER:-simulator\}/);
  assert.match(localEnvExample, /^JANUSLY_LOCAL_INTEGRATION_SIMULATOR=true$/m);
  assert.match(
    compose,
    /ANTHROPIC_BASE_URL: \$\{ANTHROPIC_BASE_URL:-https:\/\/api\.anthropic\.com\/v1\}/,
  );
  assert.match(localEnvExample, /^ANTHROPIC_BASE_URL=$/m);
  assert.match(
    compose,
    /JANUSLY_LLM_SIMULATED_PROVIDERS: \$\{JANUSLY_LLM_SIMULATED_PROVIDERS:-\}/,
  );
});

test("ignored runtime secrets reach API and worker but never the browser image", () => {
  assert.match(serviceBlock("api"), /env_file:\n\s+- \.\/local\.env/);
  assert.match(serviceBlock("worker"), /env_file:\n\s+- \.\/local\.env/);
  assert.doesNotMatch(serviceBlock("web"), /env_file:/);
  assert.doesNotMatch(serviceBlock("provider-simulator"), /env_file:/);
  assert.match(localEnvExample, /^GITHUB_TOKEN=$/m);
  assert.match(localEnvExample, /^SLACK_WEBHOOK_URL=$/m);
  assert.match(localEnvExample, /^WEBHOOK_SIGNING_SECRET=$/m);
  assert.match(localEnvExample, /^RESEND_API_KEY=$/m);
  assert.match(localEnvExample, /^SENDGRID_API_KEY=$/m);
});

test("managed credential root key is host-private and mounted only into secret consumers", () => {
  assert.match(
    compose,
    /^  JANUSLY_CREDENTIAL_MASTER_KEY_FILE: \/run\/secrets\/janusly_credential_master_key$/m,
  );
  for (const service of ["api", "worker"]) {
    assert.match(serviceBlock(service), /secrets:\n\s+- janusly_credential_master_key/);
  }
  for (const service of ["provider-simulator", "migrate", "web"]) {
    assert.doesNotMatch(serviceBlock(service), /secrets:/);
  }
  assert.match(
    compose,
    /^secrets:\n  janusly_credential_master_key:\n    file: \.\/\.secrets\/credential-master\.key$/m,
  );
  assert.match(gitignore, /^deploy\/local\/\.secrets\/$/m);
});

test("web image is reproducible and has no unpinned global static-server dependency", () => {
  assert.match(webDockerfile, /pnpm install --frozen-lockfile/);
  assert.doesNotMatch(webDockerfile, /pnpm add -g serve/);
  assert.match(webDockerfile, /USER node/);
  assert.match(webDockerfile, /serve-web\.mjs/);
});

test("generated local env remains untracked", () => {
  assert.match(gitignore, /^deploy\/local\/local\.env$/m);
});

test("normal startup cannot insert example credentials or workflow data", () => {
  assert.doesNotMatch(compose, /setup-local-smoke-fixtures|seed-local-lab|seed:demos|seed:full/);
  assert.doesNotMatch(localEnvExample, /JANUSLY_LOCAL_POSTGRES_PASSWORD|JANUSLY_POSTGRES_IMAGE/);
});
