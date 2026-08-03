import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import * as toolsBarrel from "./tools";
import * as catalog from "./tooling/catalog";
import * as dispatch from "./tooling/dispatch";
import { ALWAYS_VISIBLE_TOOLS } from "./tooling/visible-tools";
import { WRITE_TOOLS } from "./tooling/write-tools";

const EXPECTED_DEPENDENCIES = {
  arguments: ["shared"],
  catalog: ["visible-tools", "write-tools"],
  "dispatch-visible": ["arguments", "shared"],
  "dispatch-write": ["arguments", "catalog", "shared"],
  dispatch: ["dispatch-visible", "dispatch-write", "visible-tools", "write-tools"],
  shared: [],
  "visible-tools": [],
  "write-tools": [],
} as const;

describe("MCP tool module architecture", () => {
  it("preserves the stable tools.ts runtime surface", () => {
    expect(Object.keys(toolsBarrel).sort()).toEqual([
      "dispatchTool",
      "listTools",
      "mcpWritesEnabled",
      "toolErrorResult",
      "tools",
    ]);
    expect(toolsBarrel.dispatchTool).toBe(dispatch.dispatchTool);
    expect(toolsBarrel.toolErrorResult).toBe(dispatch.toolErrorResult);
    expect(toolsBarrel.listTools).toBe(catalog.listTools);
    expect(toolsBarrel.mcpWritesEnabled).toBe(catalog.mcpWritesEnabled);
    expect(toolsBarrel.tools).toBe(catalog.tools);
  });

  it("owns one ordered descriptor for every supported tool", () => {
    const visibleNames = ALWAYS_VISIBLE_TOOLS.map((tool) => tool.name);
    const writeNames = WRITE_TOOLS.map((tool) => tool.name);
    const allNames = [...visibleNames, ...writeNames];

    expect(visibleNames).toHaveLength(26);
    expect(writeNames).toHaveLength(14);
    expect(new Set(allNames).size).toBe(40);
    expect(catalog.listTools({}).map((tool) => tool.name)).toEqual(visibleNames);
    expect(catalog.listTools({ JANUSLY_MCP_WRITES_ENABLED: "true" }).map((tool) => tool.name))
      .toEqual(allNames);

    const visibleDispatch = readFileSync(new URL("./tooling/dispatch-visible.ts", import.meta.url), "utf8");
    const writeDispatch = readFileSync(new URL("./tooling/dispatch-write.ts", import.meta.url), "utf8");
    const cases = (source: string) => [...source.matchAll(/case\s+"([^"]+)"/g)]
      .map((match) => match[1])
      .sort();
    expect(cases(visibleDispatch)).toEqual([...visibleNames].sort());
    expect(cases(writeDispatch)).toEqual([...writeNames].sort());
  });

  it("keeps the closed internal inventory and dependency graph", () => {
    const files = readdirSync(new URL("./tooling", import.meta.url))
      .filter((name) => name.endsWith(".ts"))
      .sort();
    expect(files).toEqual(Object.keys(EXPECTED_DEPENDENCIES).map((name) => `${name}.ts`).sort());
    expect(existsSync(new URL("./tools", import.meta.url))).toBe(false);

    const graph = new Map<string, string[]>();
    for (const name of Object.keys(EXPECTED_DEPENDENCIES)) {
      const source = readFileSync(new URL(`./tooling/${name}.ts`, import.meta.url), "utf8");
      expect(source).not.toMatch(/from\s+["']\.\.\/tools["']/);
      const dependencies = [...source.matchAll(/from\s+["']\.\/([^"']+)["']/g)]
        .map((match) => match[1])
        .sort();
      graph.set(name, dependencies);
    }
    expect(Object.fromEntries(graph)).toEqual(EXPECTED_DEPENDENCIES);

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (name: string) => {
      if (visiting.has(name)) throw new Error(`MCP tool import cycle at ${name}`);
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
