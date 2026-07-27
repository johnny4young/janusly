/** Browser qualification for deterministic semantic containment and recovery. */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getLocalStackSettings } from "./local-env.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR
  ?? fileURLToPath(
    new URL(
      "../output/review/2026-07-27-semantic-outcomes",
      import.meta.url,
    ),
  );
const settings = await getLocalStackSettings();
const orgIds = [
  "local-recovery-lab-semantic-en",
  "local-recovery-lab-semantic-es",
];

await mkdir(evidenceDir, { recursive: true });

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)));
  });
}

async function cleanup(orgId) {
  await run(
    process.execPath,
    ["scripts/local-stack.mjs", "recovery-lab-cleanup"],
    { JANUSLY_LOCAL_ORG_ID: orgId },
  );
}

for (const orgId of orgIds) await cleanup(orgId);

try {
  await run(
    "pnpm",
    [
      "--filter",
      "@janusly/web",
      "exec",
      "playwright",
      "test",
      "e2e/semantic-outcome-recovery.spec.ts",
      "--project=chromium",
      "--workers=1",
    ],
    {
      JANUSLY_SEMANTIC_OUTCOME_E2E: "1",
      JANUSLY_EVIDENCE_DIR: evidenceDir,
      PLAYWRIGHT_BASE_URL: settings.webUrl,
      PLAYWRIGHT_SKIP_WEB_SERVER: "1",
      E2E_API_URL: settings.apiUrl,
    },
  );
} finally {
  for (const orgId of orgIds) await cleanup(orgId);
}

console.log(`[semantic-outcome] UI evidence: ${evidenceDir}`);
