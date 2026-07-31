import { readFileSync } from "node:fs";
import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as schemaBarrel from "./schema";
import * as ai from "./schema/ai";
import * as executions from "./schema/executions";
import * as identity from "./schema/identity";
import * as integrations from "./schema/integrations";
import * as recovery from "./schema/recovery";
import * as tenancy from "./schema/tenancy";
import * as workflows from "./schema/workflows";

const DOMAIN_MODULES = [
  { name: "ai", exports: ai },
  { name: "executions", exports: executions },
  { name: "identity", exports: identity },
  { name: "integrations", exports: integrations },
  { name: "recovery", exports: recovery },
  { name: "tenancy", exports: tenancy },
  { name: "workflows", exports: workflows },
] as const;

function listDomainTables(): Array<{ exportName: string; table: PgTable }> {
  return DOMAIN_MODULES.flatMap((module) =>
    (Object.entries(module.exports) as Array<[string, unknown]>)
      .filter((entry): entry is [string, PgTable] => is(entry[1], PgTable))
      .map(([exportName, table]) => ({ exportName, table })),
  );
}

describe("database schema module architecture", () => {
  it("defines every table in exactly one bounded-context module", () => {
    const domainTables = listDomainTables();
    const barrelTables = (Object.values(schemaBarrel) as unknown[])
      .filter((value): value is PgTable => is(value, PgTable));

    expect(domainTables).toHaveLength(71);
    expect(new Set(domainTables.map(({ exportName }) => exportName)).size).toBe(71);
    expect(new Set(domainTables.map(({ table }) => table)).size).toBe(71);
    expect(new Set(barrelTables)).toEqual(new Set(domainTables.map(({ table }) => table)));
  });

  it("preserves reference-identical exports through the public schema barrel", () => {
    const compatibilityExports = schemaBarrel as Record<string, unknown>;

    for (const { exportName, table } of listDomainTables()) {
      expect(compatibilityExports[exportName], exportName).toBe(table);
    }
  });

  it("keeps domain declarations side-effect-free and dependency-acyclic", () => {
    for (const module of DOMAIN_MODULES) {
      const source = readFileSync(new URL(`./schema/${module.name}.ts`, import.meta.url), "utf8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
        .map((match) => match[1]);

      expect(imports, module.name).toEqual(
        imports.filter((specifier) =>
          specifier === "drizzle-orm" || specifier === "drizzle-orm/pg-core",
        ),
      );
    }
  });
});
