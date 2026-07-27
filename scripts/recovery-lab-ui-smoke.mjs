import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getLocalStackSettings } from "./local-env.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR
  ?? fileURLToPath(new URL("../artifacts/recovery-lab-evidence", import.meta.url));
const settings = await getLocalStackSettings();

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

await run(process.execPath, [
  "scripts/recovery-lab.mjs",
  `--output=${evidenceDir}/recovery-lab.json`,
]);
await run("pnpm", [
  "--filter", "@janusly/web", "exec", "playwright", "test",
  "e2e/real-recovery-lab.spec.ts",
  "--project=chromium",
  "--workers=1",
], {
  JANUSLY_REAL_RECOVERY_LAB_E2E: "1",
  JANUSLY_EVIDENCE_DIR: evidenceDir,
  PLAYWRIGHT_BASE_URL: settings.webUrl,
  PLAYWRIGHT_SKIP_WEB_SERVER: "1",
  E2E_API_URL: settings.apiUrl,
});

console.log(`[recovery-lab] UI evidence: ${evidenceDir}`);
