/** Real-browser qualification for the persistent local Supabase identity profile. */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getLocalStackSettings } from "./local-env.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR
  ?? fileURLToPath(new URL("../artifacts/local-identity-evidence", import.meta.url));
const settings = await getLocalStackSettings();
const stamp = `${Date.now()}-${process.pid}`;
const identityEnv = {
  JANUSLY_IDENTITY_OWNER_EMAIL: `owner-${stamp}@identity.janusly.test`,
  JANUSLY_IDENTITY_MEMBER_EMAIL: `member-${stamp}@identity.janusly.test`,
  JANUSLY_IDENTITY_PASSWORD: `Local-${stamp}-Identity!`,
  JANUSLY_IDENTITY_ORG_NAME: `Identity Lab ${stamp}`,
};

await mkdir(evidenceDir, { recursive: true });

function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...identityEnv, ...extraEnv },
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)));
  });
}

const playwrightArgs = [
  "--filter", "@janusly/web", "exec", "playwright", "test",
  "e2e/local-identity-stack.spec.ts", "--project=chromium", "--workers=1",
];
const browserEnv = {
  JANUSLY_LOCAL_IDENTITY_E2E: "1",
  JANUSLY_EVIDENCE_DIR: evidenceDir,
  PLAYWRIGHT_BASE_URL: settings.webUrl,
  PLAYWRIGHT_SKIP_WEB_SERVER: "1",
};

// Qualify the current working tree, not whichever Docker image happened to
// be running from an earlier invocation. Compose build caching keeps this
// inexpensive when source and dependencies are unchanged.
await run(process.execPath, ["scripts/local-stack.mjs", "up", "--auth"]);
await run("pnpm", playwrightArgs, browserEnv);
await run(process.execPath, ["scripts/local-stack.mjs", "restart", "--auth"]);
await run("pnpm", playwrightArgs, {
  ...browserEnv,
  JANUSLY_LOCAL_IDENTITY_PERSISTENCE_ONLY: "1",
});

console.log(`[local] identity UI evidence: ${evidenceDir}`);
