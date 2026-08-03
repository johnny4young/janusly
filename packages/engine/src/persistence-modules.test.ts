import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import * as persistenceBarrel from "./persistence";
import * as event from "./persistence-ports/event";
import * as node from "./persistence-ports/node";
import * as publication from "./persistence-ports/publication";
import * as recovery from "./persistence-ports/recovery";
import * as run from "./persistence-ports/run";

type PersistenceCompatibilityTypes = [
  import("./persistence").RunNodeWaitingSnapshot,
  import("./persistence").DueWaitingCheckpoint,
  import("./persistence").DueQueuePublicationRepair,
  import("./persistence").DueParentNotification,
  import("./persistence").RunMetadata,
  import("./persistence").NodeExecutionClaim,
  import("./persistence").ReplayTransitionClaim,
  import("./persistence").QueuePublicationClaim,
  import("./persistence").ResolveSemanticOutcomeCaseResult,
  import("./persistence").ReattachSubworkflowResult,
];

const PUBLIC_MODULES = [
  { name: "event", exports: event },
  { name: "node", exports: node },
  { name: "publication", exports: publication },
  { name: "recovery", exports: recovery },
  { name: "run", exports: run },
] as const;

const EXPECTED_DEPENDENCIES = {
  event: [],
  internal: [],
  node: ["internal", "publication", "recovery", "run"],
  publication: ["internal"],
  recovery: ["internal"],
  run: ["event", "internal", "publication"],
} as const;

function publicEntries() {
  return PUBLIC_MODULES.flatMap((module) => Object.entries(module.exports)
    .map(([exportName, value]) => ({ exportName, value })));
}

describe("engine persistence module architecture", () => {
  it("preserves every runtime export through the compatibility barrel", () => {
    const entries = publicEntries();
    const names = entries.map(({ exportName }) => exportName);
    const barrel = persistenceBarrel as Record<string, unknown>;

    expect(entries).toHaveLength(40);
    expect(new Set(names).size).toBe(40);
    expect(Object.keys(barrel).sort()).toEqual([...names].sort());
    for (const { exportName, value } of entries) {
      expect(barrel[exportName], exportName).toBe(value);
    }
  });

  it("keeps the closed module inventory explicit", () => {
    const files = readdirSync(new URL("./persistence-ports", import.meta.url))
      .filter((name) => name.endsWith(".ts"))
      .sort();

    expect(files).toEqual([
      "event.ts",
      "internal.ts",
      "node.ts",
      "publication.ts",
      "recovery.ts",
      "run.ts",
    ]);
    expect(existsSync(new URL("./persistence", import.meta.url))).toBe(false);
  });

  it("keeps local persistence dependencies acyclic and off the barrel", () => {
    const graph = new Map<string, string[]>();
    for (const module of [...PUBLIC_MODULES, { name: "internal", exports: {} }]) {
      const source = readFileSync(new URL(`./persistence-ports/${module.name}.ts`, import.meta.url), "utf8");
      expect(source).not.toMatch(/from\s+["']\.\.\/persistence["']/);
      const dependencies = [...source.matchAll(/from\s+["']\.\/([^"']+)["']/g)]
        .map((match) => match[1])
        .sort();
      graph.set(module.name, dependencies);
    }

    expect(Object.fromEntries(graph)).toEqual(EXPECTED_DEPENDENCIES);

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (name: string) => {
      if (visiting.has(name)) throw new Error(`persistence import cycle at ${name}`);
      if (visited.has(name)) return;
      visiting.add(name);
      for (const dependency of graph.get(name) ?? []) visit(dependency);
      visiting.delete(name);
      visited.add(name);
    };
    for (const name of graph.keys()) visit(name);
    expect(visited.size).toBe(graph.size);
  });
});

void (null as PersistenceCompatibilityTypes | null);
