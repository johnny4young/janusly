import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLoopbackNetworkBinding,
  buildLocalComposeEnvironment,
  findUnsafePublishedBindings,
  isMissingDockerNetworkError,
  localSupabaseNetwork,
  parseSupabaseEnvironmentOutput,
} from "./local-supabase.mjs";

const status = {
  DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  API_URL: "http://127.0.0.1:54321",
  ANON_KEY: "anon",
  SERVICE_ROLE_KEY: "service",
};

test("Supabase env output preserves quoted values and separators", () => {
  assert.deepEqual(
    parseSupabaseEnvironmentOutput([
      "DB_URL=\"postgresql://postgres:p=a@127.0.0.1:54322/postgres\"",
      "API_URL=http://127.0.0.1:54321",
      "ignored=true",
      "",
    ].join("\n")),
    {
      DB_URL: "postgresql://postgres:p=a@127.0.0.1:54322/postgres",
      API_URL: "http://127.0.0.1:54321",
    },
  );
});

test("dev-header profile exposes only the database boundary", () => {
  assert.deepEqual(
    buildLocalComposeEnvironment(status, { authEnabled: false }),
    {
      JANUSLY_LOCAL_DATABASE_URL:
        "postgresql://postgres:postgres@host.docker.internal:54322/postgres",
      JANUSLY_LOCAL_ALLOW_DEV_AUTH_HEADERS: "true",
    },
  );
});

test("Auth profile maps public and container endpoints without logging keys", () => {
  assert.deepEqual(
    buildLocalComposeEnvironment(status, { authEnabled: true }),
    {
      JANUSLY_LOCAL_DATABASE_URL:
        "postgresql://postgres:postgres@host.docker.internal:54322/postgres",
      JANUSLY_LOCAL_ALLOW_DEV_AUTH_HEADERS: "false",
      JANUSLY_LOCAL_SUPABASE_PUBLIC_URL: "http://localhost:54321",
      JANUSLY_LOCAL_SUPABASE_INTERNAL_URL:
        "http://host.docker.internal:54321",
      JANUSLY_LOCAL_SUPABASE_ANON_KEY: "anon",
      JANUSLY_LOCAL_SUPABASE_SERVICE_ROLE_KEY: "service",
    },
  );
});

test("Auth profile fails closed when identity material is incomplete", () => {
  assert.throws(
    () => buildLocalComposeEnvironment(
      { DB_URL: status.DB_URL, API_URL: status.API_URL },
      { authEnabled: true },
    ),
    /anonymous\/publishable key/,
  );
});

test("local Supabase network accepts only an explicit IPv4 loopback binding", () => {
  assert.doesNotThrow(() => assertLoopbackNetworkBinding("127.0.0.1\n"));
  for (const value of ["", "0.0.0.0", "::1", "127.0.0.2"]) {
    assert.throws(
      () => assertLoopbackNetworkBinding(value),
      new RegExp(`${localSupabaseNetwork}.*127\\.0\\.0\\.1`, "u"),
    );
  }
});

test("Docker network lookup recognizes daemon error variants", () => {
  assert.equal(
    isMissingDockerNetworkError(
      "Error response from daemon: No such network: janusly-local-loopback",
    ),
    true,
  );
  assert.equal(
    isMissingDockerNetworkError(
      "Error response from daemon: network janusly-local-loopback not found",
    ),
    true,
  );
  assert.equal(
    isMissingDockerNetworkError("permission denied connecting to daemon"),
    false,
  );
});

test("published Supabase ports reject wildcard and IPv6 host bindings", () => {
  const inspections = [
    {
      container: "gateway",
      ports: {
        "8000/tcp": [
          { HostIp: "127.0.0.1", HostPort: "7431" },
          { HostIp: "0.0.0.0", HostPort: "7431" },
          { HostIp: "::", HostPort: "7431" },
        ],
      },
    },
    {
      container: "database",
      ports: {
        "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "7432" }],
      },
    },
  ];

  assert.deepEqual(findUnsafePublishedBindings(inspections), [
    {
      container: "gateway",
      containerPort: "8000/tcp",
      hostIp: "0.0.0.0",
      hostPort: "7431",
    },
    {
      container: "gateway",
      containerPort: "8000/tcp",
      hostIp: "::",
      hostPort: "7431",
    },
  ]);
  assert.deepEqual(findUnsafePublishedBindings([
    {
      container: "gateway",
      ports: {
        "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "7431" }],
      },
    },
  ]), []);
});
