/** Reads host-facing settings for the persistent local Docker stack. */

import { access, copyFile, readFile } from "node:fs/promises";

export const localEnvFile = "deploy/local/local.env";
export const localEnvExampleFile = "deploy/local/local.env.example";
export const defaultLocalWebPort = "7310";
export const defaultLocalApiPort = "7311";

const rootUrl = new URL("../", import.meta.url);

export function parseEnvFile(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export async function ensureLocalEnv() {
  const target = new URL(localEnvFile, rootUrl);
  try {
    await access(target);
  } catch {
    await copyFile(new URL(localEnvExampleFile, rootUrl), target);
    console.log(`[local] created ${localEnvFile} from the tracked example`);
  }
}

export async function readLocalEnv() {
  await ensureLocalEnv();
  return parseEnvFile(await readFile(new URL(localEnvFile, rootUrl), "utf8"));
}

export function resolveLocalStackSettings(file, environment = process.env) {
  const value = (name, fallback) => environment[name] || file[name] || fallback;
  const webPort = value("JANUSLY_LOCAL_WEB_PORT", defaultLocalWebPort);
  const apiPort = value("JANUSLY_LOCAL_API_PORT", defaultLocalApiPort);
  const simulatorPort = value("JANUSLY_LOCAL_SIMULATOR_PORT", "4010");
  return {
    webUrl: `http://127.0.0.1:${webPort}`,
    apiUrl: `http://127.0.0.1:${apiPort}`,
    simulatorUrl: `http://127.0.0.1:${simulatorPort}`,
    orgId: value("JANUSLY_LOCAL_ORG_ID", "default"),
  };
}

export async function getLocalStackSettings() {
  return resolveLocalStackSettings(await readLocalEnv());
}
