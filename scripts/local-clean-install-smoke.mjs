/** Destructive qualification of a fresh local identity installation. */

import { spawn } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getLocalStackSettings,
  localCredentialKeyFile,
  localEnvFile,
} from "./local-env.mjs";
import { assertCleanInstallRequest } from "./local-clean-install-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidenceDirectory = process.env.JANUSLY_EVIDENCE_DIR
  ?? fileURLToPath(new URL("../output/review/local-clean-install", import.meta.url));
const stamp = `${Date.now()}-${process.pid}`;
const identityEnvironment = {
  JANUSLY_CLEAN_INSTALL_EMAIL: `owner-${stamp}@clean-install.janusly.test`,
  JANUSLY_CLEAN_INSTALL_PASSWORD: `Clean-${stamp}-Identity!`,
};

assertCleanInstallRequest(["--auth", ...process.argv.slice(2)]);
await mkdir(evidenceDirectory, { recursive: true });

function run(command, argumentsList, extraEnvironment = {}, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argumentsList, {
      cwd: root,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, ...identityEnvironment, ...extraEnvironment },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolvePromise({ stdout, stderr })
      : reject(new Error(
        `${command} ${argumentsList.join(" ")} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
      )));
  });
}

async function mode(path) {
  return (await lstat(new URL(`../${path}`, import.meta.url))).mode & 0o777;
}

async function verifyDatabase(expectation) {
  const argument = expectation === "empty" ? "--expect-empty" : "--expect-onboarding";
  const result = await run(
    process.execPath,
    ["scripts/local-stack.mjs", "verify-db", "--auth", argument],
    {},
    { capture: true },
  );
  const line = result.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .find((value) => value.startsWith("{") && value.endsWith("}"));
  if (!line) throw new Error(`database verification did not return JSON: ${result.stdout}`);
  return JSON.parse(line);
}

await run(
  process.execPath,
  ["scripts/local-stack.mjs", "clean-install", "--auth", "--confirm-reset"],
);
const emptyBeforeBrowser = await verifyDatabase("empty");
const settings = await getLocalStackSettings();

await run(
  "pnpm",
  [
    "--filter", "@janusly/web", "exec", "playwright", "test",
    "e2e/local-clean-install.spec.ts", "--project=chromium", "--workers=1",
  ],
  {
    JANUSLY_LOCAL_CLEAN_INSTALL_E2E: "1",
    JANUSLY_EVIDENCE_DIR: evidenceDirectory,
    PLAYWRIGHT_BASE_URL: settings.webUrl,
    PLAYWRIGHT_SKIP_WEB_SERVER: "1",
  },
);

const onboarding = await verifyDatabase("onboarding");
const [nodeVersion, pnpmVersion] = await Promise.all([
  run(process.execPath, ["--version"], {}, { capture: true }),
  run("pnpm", ["--version"], {}, { capture: true }),
]);
const configurationModes = {
  localEnv: (await mode(localEnvFile)).toString(8).padStart(3, "0"),
  credentialKey: (await mode(localCredentialKeyFile)).toString(8).padStart(3, "0"),
};

await run(process.execPath, ["scripts/local-stack.mjs", "reset", "--auth"]);
await run(process.execPath, ["scripts/local-stack.mjs", "up", "--auth"]);
const emptyAfterQualification = await verifyDatabase("empty");

const report = {
  qualifiedAt: new Date().toISOString(),
  runtime: {
    node: nodeVersion.stdout.trim(),
    pnpm: pnpmVersion.stdout.trim(),
  },
  urls: {
    web: settings.webUrl,
    api: settings.apiUrl,
  },
  configurationModes,
  emptyBeforeBrowser,
  onboarding,
  emptyAfterQualification,
  screenshots: [
    "clean-install-login-en.png",
    "clean-install-login-es.png",
    "clean-install-onboarding-en.png",
    "clean-install-onboarding-es.png",
  ],
};
await writeFile(
  join(evidenceDirectory, "clean-install.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(`[local] clean-install evidence: ${evidenceDirectory}`);
