import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

let loaded = false;

export function loadRootEnv() {
  if (loaded) return;
  loaded = true;

  const examplePath = fileURLToPath(new URL("../../../.env.example", import.meta.url));
  const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));

  if (existsSync(examplePath)) {
    config({ path: examplePath, override: false });
  }

  if (existsSync(envPath)) {
    config({ path: envPath, override: true });
  }
}
