/** Runs the browser smoke against the persistent local Docker stack. */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getLocalStackSettings } from "./local-env.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR
  ?? fileURLToPath(new URL("../artifacts/local-stack-evidence", import.meta.url));
const settings = await getLocalStackSettings();
if (!settings.simulatorEnabled) {
  throw new Error(
    "local UI smoke is simulator-only and will not execute external provider effects; set JANUSLY_LOCAL_INTEGRATION_SIMULATOR=true",
  );
}
await mkdir(evidenceDir, { recursive: true });

await new Promise((resolve, reject) => {
  const child = spawn("pnpm", [
    "--filter", "@janusly/web", "exec", "playwright", "test",
    "e2e/local-persistent-stack.spec.ts", "--project=chromium", "--workers=1",
  ], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      JANUSLY_LOCAL_STACK_E2E: "1",
      JANUSLY_EVIDENCE_DIR: evidenceDir,
      PLAYWRIGHT_BASE_URL: settings.webUrl,
      PLAYWRIGHT_SKIP_WEB_SERVER: "1",
      E2E_API_URL: settings.apiUrl,
    },
  });
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`local UI smoke exited ${code}`)));
});

console.log(`[local] UI evidence: ${evidenceDir}`);
