import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLocalComposeEnvironment,
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
