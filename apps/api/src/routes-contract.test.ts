/**
 * Web ↔ route contract test.
 *
 * Statically extracts every `api(...)` / `downloadFromApi(...)` path the web
 * calls (`apps/web/src`) and asserts each resolves to a registered route in the
 * composed registry (method + matcher). Catches drift — a web call to a route
 * that was renamed or never existed — at unit-test time instead of only in e2e.
 *
 * Scope: only STRING/TEMPLATE-literal paths are checked (a fully dynamic
 * `api(variable)` can't be resolved statically and is skipped). Template
 * `${…}` segments normalize to a dummy path segment; query strings are stripped
 * (route matchers accept a path with or without `?…`). Genuinely unmatchable
 * literal paths go in `ALLOWLIST` with a reason.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { matchesRoute } from "./routes";
import { routes } from "./routes-registry";

const WEB_SRC = fileURLToPath(new URL("../../web/src/", import.meta.url));

/** Literal web paths that legitimately don't map to a single route (with reason). */
const ALLOWLIST = new Set<string>([
  // RecoveryItemDrawer posts `/recovery/items/${id}/${action}` where `action`
  // is dynamic (acknowledge / resolve / escalate / …). The specific per-action
  // routes exist and are exercised by recovery-items-routes.test.ts; the
  // fully-dynamic action segment can't be resolved to one route statically.
  "POST /recovery/items/x/x",
]);

type ApiCall = { path: string; method: string; file: string };

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Pull `api(<literal>, { method })` + `downloadFromApi(<literal>)` calls from one file. */
function extractCalls(source: string, file: string): ApiCall[] {
  const out: ApiCall[] = [];
  const re = /\b(api|downloadFromApi)\(\s*(['"`])([^'"`]*?)\2/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const fn = m[1];
    const rawPath = m[3];
    if (!rawPath.startsWith("/")) continue; // not an absolute API path
    // Look just past the path for an inline `method: 'X'` before the call ends
    // (both `api` and `downloadFromApi` take an options object; default GET).
    let method = "GET";
    const window = source.slice(re.lastIndex, re.lastIndex + 300);
    const mm = window.match(/^\s*,\s*\{[\s\S]*?method:\s*['"]([A-Za-z]+)['"]/);
    if (mm) method = mm[1].toUpperCase();
    out.push({ path: rawPath, method, file });
  }
  return out;
}

/** Template `${…}` → dummy segment. The query is KEPT (matchers like
 *  `url.startsWith("/run?")` require it) with its template exprs normalized. */
function normalizePath(path: string): string {
  return path.replace(/\$\{[^}]*\}/g, "x");
}

function collectCalls(): ApiCall[] {
  const calls: ApiCall[] = [];
  for (const file of walk(WEB_SRC.replace(/\/$/, ""))) {
    calls.push(...extractCalls(readFileSync(file, "utf8"), file));
  }
  return calls;
}

describe("web ↔ route contract", () => {
  const calls = collectCalls();

  it("extracts a meaningful number of api() calls (sanity)", () => {
    expect(calls.length).toBeGreaterThan(30);
  });

  it("resolves every web api() path to a registered route", () => {
    const unresolved: string[] = [];
    for (const call of calls) {
      const url = normalizePath(call.path);
      const key = `${call.method} ${url}`;
      if (ALLOWLIST.has(key)) continue;
      const matched = routes.some(
        (route) => route.method === call.method && matchesRoute(route.match, url),
      );
      if (!matched) unresolved.push(`${key}  (${call.file.replace(WEB_SRC, "")})`);
    }
    // Dedup for a readable failure message.
    const unique = [...new Set(unresolved)].sort();
    expect(unique, `web calls with no matching route:\n${unique.join("\n")}`).toEqual([]);
  });
});
