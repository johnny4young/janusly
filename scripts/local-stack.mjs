/** Lifecycle wrapper for the persistent local Docker stack. */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureLocalEnv, getLocalStackSettings, localEnvFile } from "./local-env.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const composeFile = "deploy/local/compose.yml";
const command = process.argv[2] ?? "up";

function compose(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", "--env-file", localEnvFile, "-f", composeFile, ...args], {
      cwd: root,
      stdio: options.stdio ?? "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`docker compose ${args.join(" ")} exited ${code}`)));
  });
}

async function waitFor(url, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw lastError ?? new Error(`${url} did not become ready`);
}

await ensureLocalEnv();
const settings = await getLocalStackSettings();

async function waitForStack() {
  await Promise.all([
    waitFor(`${settings.apiUrl}/health`),
    waitFor(`${settings.webUrl}/`),
    waitFor(`${settings.simulatorUrl}/health`),
  ]);
}

if (command === "up") {
  await compose(["up", "-d", "--build"]);
  try {
    await waitForStack();
    console.log(`[local] ready: web ${settings.webUrl} · api ${settings.apiUrl} · simulator ${settings.simulatorUrl}`);
  } catch (error) {
    await compose(["logs", "--tail", "150"]);
    throw error;
  }
} else if (command === "down") {
  await compose(["down"]);
  console.log("[local] stopped; named volumes were preserved");
} else if (command === "reset") {
  await compose(["down", "-v", "--remove-orphans"]);
  console.log("[local] stopped and persistent local data was removed");
} else if (command === "restart") {
  await compose(["restart", "postgres", "redis", "provider-simulator", "api", "worker", "web"]);
  await waitForStack();
  console.log("[local] restarted and healthy");
} else if (command === "status") {
  await compose(["ps"]);
} else if (command === "logs") {
  await compose(["logs", "-f", "--tail", "150"]);
} else {
  throw new Error("usage: node scripts/local-stack.mjs up|down|reset|restart|status|logs");
}
