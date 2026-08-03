import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseWebQualificationPorts,
  webQualificationProjectName,
} from "./run-web-qualification.mjs";

test("Go web qualification uses isolated ports by default", () => {
  assert.deepEqual(parseWebQualificationPorts({}), {
    postgres: 4637,
    api: 4650,
    internal: 4651,
  });
});

test("Go web qualification accepts distinct private port overrides", () => {
  assert.deepEqual(parseWebQualificationPorts({
    JANUSLY_GO_WEB_QUALIFICATION_PG_PORT: "5637",
    JANUSLY_GO_WEB_QUALIFICATION_API_PORT: "5650",
    JANUSLY_GO_WEB_QUALIFICATION_INTERNAL_PORT: "5651",
  }), {
    postgres: 5637,
    api: 5650,
    internal: 5651,
  });
});

test("Go web qualification uses a process-owned Compose project", () => {
  assert.equal(webQualificationProjectName(1234), "janusly-go-web-qualification-1234");
  assert.throws(() => webQualificationProjectName(0), /positive integer/u);
});

test("Go web qualification rejects invalid or overlapping ports", () => {
  assert.throws(
    () => parseWebQualificationPorts({ JANUSLY_GO_WEB_QUALIFICATION_PG_PORT: "80" }),
    /integer in \[1024, 65535\]/u,
  );
  assert.throws(
    () => parseWebQualificationPorts({
      JANUSLY_GO_WEB_QUALIFICATION_PG_PORT: "4650",
      JANUSLY_GO_WEB_QUALIFICATION_API_PORT: "4650",
    }),
    /must be distinct/u,
  );
});

test("Go web qualification Compose is task-owned, loopback-only, and PostgreSQL 18", async () => {
  const source = await readFile(new URL("./web-qualification.compose.yml", import.meta.url), "utf8");
  assert.match(source, /^name: janusly-go-web-qualification$/mu);
  assert.deepEqual([...source.matchAll(/^\s+image:\s+(.+)$/gmu)].map(match => match[1]), [
    "pgvector/pgvector:pg18",
  ]);
  assert.match(source, /127\.0\.0\.1:\$\{JANUSLY_GO_WEB_QUALIFICATION_PG_PORT:-4637\}:5432/u);
  assert.doesNotMatch(source, /^volumes:/mu);
});

test("direct shared-database smoke refuses template deletion without explicit consent", () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./run-web-smoke.mjs", import.meta.url))], {
    encoding: "utf8",
    env: {
      ...process.env,
      JANUSLY_GO_SMOKE_SKIP_PRECLEAN: "",
      JANUSLY_GO_SMOKE_CONFIRM_PRECLEAN: "",
    },
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /shared-database template cleanup requires JANUSLY_GO_SMOKE_CONFIRM_PRECLEAN=true/u);
});
