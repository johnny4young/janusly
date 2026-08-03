import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getIntegrationEnvironment } from "./integration-environment.mjs";

const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");

test("integration services use isolated host ports by default", () => {
  assert.deepEqual(getIntegrationEnvironment({}), {
    JANUSLY_POSTGRES_HOST_PORT: "15432",
    JANUSLY_REDIS_HOST_PORT: "16379",
    DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:15432/workflow",
    REDIS_URL: "redis://127.0.0.1:16379",
  });
  assert.match(
    compose,
    /127\.0\.0\.1:\$\{JANUSLY_POSTGRES_HOST_PORT:-5432\}:5432/,
  );
  assert.match(
    compose,
    /127\.0\.0\.1:\$\{JANUSLY_REDIS_HOST_PORT:-6379\}:6379/,
  );
});

test("integration service host ports can be overridden together with client URLs", () => {
  assert.deepEqual(getIntegrationEnvironment({
    JANUSLY_INTEGRATION_POSTGRES_PORT: "25432",
    JANUSLY_INTEGRATION_REDIS_PORT: "26379",
  }), {
    JANUSLY_POSTGRES_HOST_PORT: "25432",
    JANUSLY_REDIS_HOST_PORT: "26379",
    DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:25432/workflow",
    REDIS_URL: "redis://127.0.0.1:26379",
  });
});

test("integration service host ports fail fast when invalid or overlapping", () => {
  assert.throws(
    () => getIntegrationEnvironment({ JANUSLY_INTEGRATION_POSTGRES_PORT: "0" }),
    /JANUSLY_INTEGRATION_POSTGRES_PORT/,
  );
  assert.throws(
    () => getIntegrationEnvironment({
      JANUSLY_INTEGRATION_POSTGRES_PORT: "15432",
      JANUSLY_INTEGRATION_REDIS_PORT: "15432",
    }),
    /must be different/,
  );
});
