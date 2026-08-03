import { describe, expect, it } from "vitest";

import type { ApiRouteContract } from "../api-contract-types";
import * as compatibilityBarrel from "../api-contracts";
import * as ai from "./ai";
import * as catalog from "./catalog";
import * as dlq from "./dlq";
import * as mcp from "./mcp";
import { V1_CONTRACT_ROUTES } from "./manifest";
import * as recovery from "./recovery";
import * as reports from "./reports";
import * as runs from "./runs";
import * as workflows from "./workflows";

const DOMAIN_MODULES = [ai, catalog, dlq, mcp, recovery, reports, runs, workflows];

function listDomainContracts(): Array<{ name: string; contract: ApiRouteContract }> {
  return DOMAIN_MODULES.flatMap((module) =>
    Object.entries(module)
      .filter(([name]) => name.endsWith("Contract"))
      .map(([name, contract]) => ({ name, contract: contract as ApiRouteContract })),
  );
}

describe("stable v1 contract manifest architecture", () => {
  it("includes every domain contract exactly once", () => {
    const domainContracts = listDomainContracts();
    const manifestContracts = V1_CONTRACT_ROUTES.map((route) => route.contract);

    expect(domainContracts).toHaveLength(40);
    expect(manifestContracts).toHaveLength(domainContracts.length);
    expect(new Set(manifestContracts).size).toBe(domainContracts.length);
    expect(new Set(manifestContracts)).toEqual(
      new Set(domainContracts.map(({ contract }) => contract)),
    );
  });

  it("preserves reference-identical exports through the compatibility barrel", () => {
    const compatibilityExports = compatibilityBarrel as Record<string, unknown>;

    for (const { name, contract } of listDomainContracts()) {
      expect(compatibilityExports[name], name).toBe(contract);
    }
    expect(compatibilityBarrel.V1_CONTRACT_ROUTES).toBe(V1_CONTRACT_ROUTES);
  });
});
