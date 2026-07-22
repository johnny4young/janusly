import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const compose = await readFile(new URL("../deploy/local/compose.yml", import.meta.url), "utf8");
const localEnvExample = await readFile(new URL("../deploy/local/local.env.example", import.meta.url), "utf8");
const webDockerfile = await readFile(new URL("../Dockerfile.web", import.meta.url), "utf8");
const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");

test("persistent local stack separates runtime services and named data", () => {
  for (const service of ["postgres", "redis", "provider-simulator", "migrate", "seed", "api", "worker", "web"]) {
    assert.match(compose, new RegExp(`^  ${service}:`, "m"));
  }
  assert.match(compose, /postgres_data:\/var\/lib\/postgresql/);
  assert.match(compose, /redis_data:\/data/);
  assert.match(compose, /provider_data:\/data/);
  assert.match(compose, /condition: service_completed_successfully/);
  assert.match(compose, /restart: unless-stopped/);
});

test("local published ports are loopback-only", () => {
  const published = [...compose.matchAll(/^\s+- "([^"]+:[^"]+)"$/gm)].map((match) => match[1]);
  assert.ok(published.length >= 8);
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
  assert.match(compose, /JANUSLY_LOCAL_INTEGRATION_SIMULATOR: "true"/);
  assert.match(compose, /ALLOW_PRIVATE_HTTP_TARGETS: "true"/);
  assert.match(compose, /JANUSLY_MAILER_PROVIDER: simulator/);
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
