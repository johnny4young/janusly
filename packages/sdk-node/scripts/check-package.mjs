/**
 * Build a real npm tarball, install it into an isolated consumer, and import
 * the public entrypoint. This catches source-only exports and missing files
 * without publishing or reaching the registry.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "janusly-sdk-package-"));
const npmEnv = { ...process.env, npm_config_cache: join(temp, "npm-cache") };

try {
  const packOutput = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", temp],
    { cwd: root, env: npmEnv, encoding: "utf8" },
  );
  const [packed] = JSON.parse(packOutput);
  if (!packed?.filename || !Array.isArray(packed.files)) {
    throw new Error("npm pack did not return package metadata");
  }
  const names = new Set(packed.files.map((file) => file.path));
  for (const required of ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"]) {
    if (!names.has(required)) throw new Error(`packed SDK is missing ${required}`);
  }
  if ([...names].some((name) => name.startsWith("src/") || name.endsWith(".test.js"))) {
    throw new Error("packed SDK leaked source or test files");
  }

  const consumer = join(temp, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(temp, packed.filename)],
    { cwd: consumer, env: npmEnv, stdio: "pipe" },
  );
  const smoke = execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", [
      "import { JanuslyClient, JanuslyProtocolError } from '@janusly/sdk';",
      "const client = new JanuslyClient({ baseUrl: 'https://example.test', orgId: 'org-1', auth: { kind: 'service-token', token: 'test' } });",
      "if (!client.runs || JanuslyProtocolError.name !== 'JanuslyProtocolError') throw new Error('public exports unavailable');",
      "console.log('SDK tarball import OK');",
    ].join("\n")],
    { cwd: consumer, encoding: "utf8" },
  );
  process.stdout.write(smoke);

  writeFileSync(join(consumer, "index.ts"), [
    "import { JanuslyClient, JanuslyProtocolError, type RunDetails } from '@janusly/sdk';",
    "const client = new JanuslyClient({ baseUrl: 'https://example.test', orgId: 'org-1', auth: { kind: 'service-token', token: 'test' } });",
    "const details: RunDetails | undefined = undefined;",
    "void [client.runs, JanuslyProtocolError, details];",
  ].join("\n"));
  execFileSync(
    join(root, "node_modules/.bin/tsc"),
    [
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target", "ES2023",
      "--module", "NodeNext",
      "--moduleResolution", "NodeNext",
      "--lib", "ES2023,DOM,DOM.Iterable",
      "--typeRoots", join(root, "node_modules/@types"),
      "index.ts",
    ],
    { cwd: consumer, encoding: "utf8" },
  );
  console.log("SDK tarball types OK");

  const installed = JSON.parse(readFileSync(join(consumer, "node_modules/@janusly/sdk/package.json"), "utf8"));
  if (installed.main !== "./dist/index.js") throw new Error("installed package does not target dist");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
