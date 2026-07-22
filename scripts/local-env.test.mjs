import assert from "node:assert/strict";
import test from "node:test";
import { parseEnvFile, resolveLocalStackSettings } from "./local-env.mjs";

test("local env parser ignores comments and preserves values after the first separator", () => {
  assert.deepEqual(parseEnvFile(`
# Local settings
JANUSLY_LOCAL_API_PORT=3101
EMPTY=
QUOTED="http://localhost:3101/path?key=value"
SINGLE='local value'
INVALID
`), {
    JANUSLY_LOCAL_API_PORT: "3101",
    EMPTY: "",
    QUOTED: "http://localhost:3101/path?key=value",
    SINGLE: "local value",
  });
});

test("local stack settings honor host-port and process overrides", () => {
  assert.deepEqual(resolveLocalStackSettings({
    JANUSLY_LOCAL_WEB_PORT: "3100",
    JANUSLY_LOCAL_API_PORT: "3101",
    JANUSLY_LOCAL_SIMULATOR_PORT: "4110",
    JANUSLY_LOCAL_ORG_ID: "file-org",
  }, {
    JANUSLY_LOCAL_API_PORT: "3201",
    JANUSLY_LOCAL_ORG_ID: "process-org",
  }), {
    webUrl: "http://127.0.0.1:3100",
    apiUrl: "http://127.0.0.1:3201",
    simulatorUrl: "http://127.0.0.1:4110",
    orgId: "process-org",
  });
});
