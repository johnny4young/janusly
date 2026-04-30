/**
 * Root .env loader for the `@janusly/db` package and its consumers.
 *
 * Janusly's monorepo keeps a single `.env` (developer) + `.env.example`
 * (committed defaults) at the repo root. This module is the one place that
 * knows how to find them from inside any workspace, so callers can `await
 * loadRootEnv()` before reading `process.env.DATABASE_URL` etc. and rely on
 * sane fallbacks when no `.env` is present.
 *
 * Used by:
 * - `packages/db/src/index.ts` — runs at module init so the drizzle client
 *   sees `DATABASE_URL`.
 * - `packages/db/drizzle.config.ts` — same, for the migration tooling.
 *
 * Invariants:
 * - `.env.example` is loaded with `override: false` so it only fills in
 *   missing keys; `.env` is loaded with `override: true` so the developer's
 *   secrets win.
 * - The `loaded` guard makes this idempotent — multiple imports across
 *   workspaces don't re-read or shadow values that the application already
 *   set programmatically.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

let loaded = false;

/**
 * Populate `process.env` from the repo-root `.env.example` (defaults) and
 * `.env` (developer overrides) if they exist. Idempotent — safe to call from
 * any module's top-level.
 */
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
