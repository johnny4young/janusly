/** Reads host-facing settings for the persistent local Docker stack. */

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";

export const localEnvFile = "deploy/local/local.env";
export const localEnvExampleFile = "deploy/local/local.env.example";
export const localCredentialKeyFile = "deploy/local/.secrets/credential-master.key";
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

export async function ensurePrivateCopy(source, target) {
  try {
    await access(target);
  } catch {
    try {
      await copyFile(source, target, constants.COPYFILE_EXCL);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
    }
  }
  await chmod(target, 0o600);
}

export async function ensureLocalEnv() {
  const target = new URL(localEnvFile, rootUrl);
  let existed = true;
  try {
    await access(target);
  } catch {
    existed = false;
  }
  await ensurePrivateCopy(new URL(localEnvExampleFile, rootUrl), target);
  if (!existed) {
    console.log(`[local] created ${localEnvFile} from the tracked example`);
  }
}

export async function removeLocalGeneratedConfiguration(baseUrl = rootUrl) {
  await Promise.all([
    rm(new URL(localEnvFile, baseUrl), { force: true }),
    rm(new URL("deploy/local/.secrets/", baseUrl), { recursive: true, force: true }),
  ]);
}

/** Create the one local SecretStore root key without ever printing it. */
export async function ensureLocalCredentialMasterKey() {
  const target = new URL(localCredentialKeyFile, rootUrl);
  const directory = new URL("deploy/local/.secrets/", rootUrl);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await access(target);
    await Promise.all([chmod(directory, 0o700), chmod(target, 0o600)]);
    return;
  } catch {
    try {
      await writeFile(target, `${randomBytes(32).toString("base64")}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        await Promise.all([chmod(directory, 0o700), chmod(target, 0o600)]);
        return;
      }
      throw error;
    }
    await Promise.all([chmod(directory, 0o700), chmod(target, 0o600)]);
    console.log(`[local] created ignored credential root key at ${localCredentialKeyFile}`);
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
    simulatorEnabled: value("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true") === "true",
    orgId: value("JANUSLY_LOCAL_ORG_ID", "default"),
  };
}

export async function getLocalStackSettings() {
  return resolveLocalStackSettings(await readLocalEnv());
}
