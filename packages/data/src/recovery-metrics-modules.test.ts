import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import * as recoveryMetrics from "./recoveryMetricsRepo";
import * as clusters from "./recovery-metrics/clusters";
import * as effectiveness from "./recovery-metrics/effectiveness";
import * as impact from "./recovery-metrics/impact";
import * as ledger from "./recovery-metrics/ledger";
import * as signals from "./recovery-metrics/signals";

type RecoveryMetricsCompatibilityTypes = [
  import("./recoveryMetricsRepo").CostProviderRowRepo,
  import("./recoveryMetricsRepo").MttrTrendPointRepo,
  import("./recoveryMetricsRepo").RecoveryHeatmapDay,
  import("./recoveryMetricsRepo").RecoveryImpactCompletion,
  import("./recoveryMetricsRepo").RecoveryLedgerRepo,
  import("./recoveryMetricsRepo").RecoveryMetricsSignals,
  import("./recoveryMetricsRepo").RecoveryRecurrenceRepo,
  import("./recoveryMetricsRepo").ReplayOutcomeCountsRepo,
  import("./recoveryMetricsRepo").ResolvedClustersRepo,
  import("./recoveryMetricsRepo").RunStatusCountsRepo,
  import("./recoveryMetricsRepo").SlaAttainmentRepo,
  import("./recoveryMetricsRepo").TimeToFirstActionRepo,
  import("./recoveryMetricsRepo").VerifiedRecoveryStatsRepo,
];

const EXPECTED_DEPENDENCIES = {
  clusters: ["contracts"],
  contracts: [],
  effectiveness: ["contracts"],
  impact: ["contracts"],
  ledger: ["contracts"],
  signals: ["clusters", "contracts", "effectiveness"],
} as const;

const PUBLIC_EXPORTS = {
  COST_BREAKDOWN_GROUP_CAP: 100,
  COST_BREAKDOWN_OTHER_KEY: "__other__",
  queryFailureClustersResolved: clusters.queryFailureClustersResolved,
  queryOperatorRecoveryCount: ledger.queryOperatorRecoveryCount,
  queryRecoveryHeatmap: signals.queryRecoveryHeatmap,
  queryRecoveryLedger: ledger.queryRecoveryLedger,
  queryRecoveryMetricsSignals: signals.queryRecoveryMetricsSignals,
  queryRecoveryRecurrence: effectiveness.queryRecoveryRecurrence,
  queryRecoverySlaAttainment: effectiveness.queryRecoverySlaAttainment,
  queryTimeToFirstAction: effectiveness.queryTimeToFirstAction,
  recordRecoveryImpactTx: impact.recordRecoveryImpactTx,
} as const;

describe("recovery metrics repository module architecture", () => {
  it("preserves the stable runtime and type surface", () => {
    expect(Object.keys(recoveryMetrics).sort()).toEqual(Object.keys(PUBLIC_EXPORTS).sort());
    for (const [name, value] of Object.entries(PUBLIC_EXPORTS)) {
      expect(recoveryMetrics[name as keyof typeof recoveryMetrics], name).toBe(value);
    }
  });

  it("keeps the internal module inventory explicit and bounded", () => {
    const files = readdirSync(new URL("./recovery-metrics", import.meta.url))
      .filter((name) => name.endsWith(".ts"))
      .sort();

    expect(files).toEqual(Object.keys(EXPECTED_DEPENDENCIES).map((name) => `${name}.ts`).sort());
    expect(existsSync(new URL("./recoveryMetricsRepo", import.meta.url))).toBe(false);

    for (const file of files) {
      const source = readFileSync(new URL(`./recovery-metrics/${file}`, import.meta.url), "utf8");
      expect(source.split("\n").length, file).toBeLessThanOrEqual(700);
    }
  });

  it("keeps local dependencies acyclic and off the compatibility barrel", () => {
    const graph = new Map<string, string[]>();
    for (const name of Object.keys(EXPECTED_DEPENDENCIES)) {
      const source = readFileSync(
        new URL(`./recovery-metrics/${name}.ts`, import.meta.url),
        "utf8",
      );
      expect(source).not.toMatch(/from\s+["']\.\.\/recoveryMetricsRepo["']/);
      const dependencies = [...source.matchAll(/from\s+["']\.\/([^"']+)["']/g)]
        .map((match) => match[1])
        .sort();
      graph.set(name, dependencies);
    }

    expect(Object.fromEntries(graph)).toEqual(EXPECTED_DEPENDENCIES);

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (name: string) => {
      if (visiting.has(name)) throw new Error(`Recovery metrics import cycle at ${name}`);
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

void (null as RecoveryMetricsCompatibilityTypes | null);
