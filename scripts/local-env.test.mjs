import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  defaultLocalApiPort,
  defaultLocalWebPort,
  ensurePrivateCopy,
  parseEnvFile,
  removeLocalGeneratedConfiguration,
  resolveLocalStackSettings,
} from "./local-env.mjs";

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
    simulatorEnabled: true,
    orgId: "process-org",
  });
});

test("local stack defaults avoid common development web ports", () => {
  assert.deepEqual(resolveLocalStackSettings({}, {}), {
    webUrl: `http://127.0.0.1:${defaultLocalWebPort}`,
    apiUrl: `http://127.0.0.1:${defaultLocalApiPort}`,
    simulatorUrl: "http://127.0.0.1:4010",
    simulatorEnabled: true,
    orgId: "default",
  });
  assert.notEqual(defaultLocalWebPort, "3000");
  assert.notEqual(defaultLocalApiPort, "3001");
});

test("local stack settings require an exact opt-in for simulator routing overrides", () => {
  assert.equal(resolveLocalStackSettings({ JANUSLY_LOCAL_INTEGRATION_SIMULATOR: "false" }, {}).simulatorEnabled, false);
  assert.equal(resolveLocalStackSettings({ JANUSLY_LOCAL_INTEGRATION_SIMULATOR: "TRUE" }, {}).simulatorEnabled, false);
  assert.equal(resolveLocalStackSettings({ JANUSLY_LOCAL_INTEGRATION_SIMULATOR: "true" }, {}).simulatorEnabled, true);
});

test("private local configuration is created and repaired with owner-only permissions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "janusly-local-env-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const source = join(directory, "example.env");
  const target = join(directory, "local.env");
  await writeFile(source, "SECRET=\n");

  await ensurePrivateCopy(source, target);
  assert.equal(await readFile(target, "utf8"), "SECRET=\n");
  assert.equal((await lstat(target)).mode & 0o777, 0o600);

  await chmod(target, 0o644);
  await ensurePrivateCopy(source, target);
  assert.equal((await lstat(target)).mode & 0o777, 0o600);
});

test("clean installation removes only generated local configuration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "janusly-local-reset-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const baseUrl = pathToFileURL(`${directory}/`);
  await mkdir(join(directory, "deploy/local/.secrets"), { recursive: true });
  await writeFile(join(directory, "deploy/local/local.env"), "SECRET=value\n");
  await writeFile(join(directory, "deploy/local/.secrets/credential-master.key"), "key\n");
  await writeFile(join(directory, "deploy/local/keep.txt"), "tracked\n");

  await removeLocalGeneratedConfiguration(baseUrl);

  await assert.rejects(lstat(join(directory, "deploy/local/local.env")), { code: "ENOENT" });
  await assert.rejects(lstat(join(directory, "deploy/local/.secrets")), { code: "ENOENT" });
  assert.equal(await readFile(join(directory, "deploy/local/keep.txt"), "utf8"), "tracked\n");
});
