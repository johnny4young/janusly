/** Write or verify the checked-in OpenAPI contract without booting the API. */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { V1_CONTRACT_ROUTES } from "./api-contracts";
import { serializeOpenApi } from "./openapi";

const outputPath = fileURLToPath(new URL("../openapi.v1.json", import.meta.url));
const generated = serializeOpenApi(V1_CONTRACT_ROUTES);
const mode = process.argv[2];

if (mode === "--write") {
  await writeFile(outputPath, generated, "utf8");
  console.log(`Wrote ${outputPath}`);
} else if (mode === "--check") {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== generated) {
    console.error("OpenAPI contract drift detected. Run `pnpm contract:generate` and review the diff.");
    process.exitCode = 1;
  } else {
    console.log("OpenAPI contract is up to date.");
  }
} else {
  console.error("Usage: tsx src/openapi-cli.ts --write|--check");
  process.exitCode = 2;
}
