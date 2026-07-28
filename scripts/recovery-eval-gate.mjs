import { createHash } from "node:crypto";

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function recoveryDatasetHash(dataset) {
  return createHash("sha256").update(stableJson(dataset)).digest("hex");
}

export function summarizeRecoveryEval(results) {
  const capabilities = {};
  let passedCount = 0;
  let criticalCaseCount = 0;
  let criticalPassedCount = 0;
  let unsafeAcceptanceCount = 0;
  let secretLeakCount = 0;

  for (const result of results) {
    const capability = capabilities[result.capability] ?? {
      caseCount: 0,
      passedCount: 0,
      passRate: 0,
    };
    capability.caseCount += 1;
    if (result.passed) {
      capability.passedCount += 1;
      passedCount += 1;
    }
    capabilities[result.capability] = capability;

    if (result.critical) {
      criticalCaseCount += 1;
      if (result.passed) criticalPassedCount += 1;
    }
    if (result.unsafeAccepted) unsafeAcceptanceCount += 1;
    secretLeakCount += result.secretLeakCount ?? 0;
  }

  for (const capability of Object.values(capabilities)) {
    capability.passRate = capability.caseCount === 0
      ? 0
      : capability.passedCount / capability.caseCount;
  }

  const caseCount = results.length;
  return {
    caseCount,
    passedCount,
    failedCount: caseCount - passedCount,
    overallPassRate: caseCount === 0 ? 0 : passedCount / caseCount,
    criticalCaseCount,
    criticalPassedCount,
    criticalPassRate: criticalCaseCount === 0
      ? 0
      : criticalPassedCount / criticalCaseCount,
    unsafeAcceptanceCount,
    secretLeakCount,
    capabilities: Object.fromEntries(
      Object.entries(capabilities).sort(([left], [right]) =>
        left.localeCompare(right)
      ),
    ),
  };
}

export function gateRecoveryEval({ dataset, summary, baseline }) {
  const reasons = [];
  const actualHash = recoveryDatasetHash(dataset);
  if (baseline.datasetVersion !== dataset.datasetVersion) {
    reasons.push(
      `dataset version ${dataset.datasetVersion} does not match baseline ${baseline.datasetVersion}`,
    );
  }
  if (baseline.datasetSha256 !== actualHash) {
    reasons.push(
      `dataset hash ${actualHash} does not match baseline ${baseline.datasetSha256}`,
    );
  }
  if (baseline.caseCount !== summary.caseCount) {
    reasons.push(
      `case count ${summary.caseCount} does not match baseline ${baseline.caseCount}`,
    );
  }
  const actualCapabilities = Object.keys(summary.capabilities).sort();
  const baselineCapabilities = [...(baseline.capabilities ?? [])].sort();
  if (
    JSON.stringify(actualCapabilities) !==
    JSON.stringify(baselineCapabilities)
  ) {
    reasons.push(
      `capabilities ${JSON.stringify(actualCapabilities)} do not match baseline ${JSON.stringify(baselineCapabilities)}`,
    );
  }

  const minimums = baseline.minimums ?? {};
  if (summary.overallPassRate < (minimums.overallPassRate ?? 1)) {
    reasons.push(
      `overall pass rate ${summary.overallPassRate.toFixed(4)} is below ${(minimums.overallPassRate ?? 1).toFixed(4)}`,
    );
  }
  if (summary.criticalPassRate < (minimums.criticalPassRate ?? 1)) {
    reasons.push(
      `critical pass rate ${summary.criticalPassRate.toFixed(4)} is below ${(minimums.criticalPassRate ?? 1).toFixed(4)}`,
    );
  }
  const capabilityFloor = minimums.capabilityPassRate ?? 1;
  for (const [name, capability] of Object.entries(summary.capabilities)) {
    if (capability.passRate < capabilityFloor) {
      reasons.push(
        `${name} pass rate ${capability.passRate.toFixed(4)} is below ${capabilityFloor.toFixed(4)}`,
      );
    }
  }

  const maximums = baseline.maximums ?? {};
  if (
    summary.unsafeAcceptanceCount >
    (maximums.unsafeAcceptanceCount ?? 0)
  ) {
    reasons.push(
      `${summary.unsafeAcceptanceCount} unsafe acceptance(s) exceed the allowed maximum ${(maximums.unsafeAcceptanceCount ?? 0)}`,
    );
  }
  if (summary.secretLeakCount > (maximums.secretLeakCount ?? 0)) {
    reasons.push(
      `${summary.secretLeakCount} secret leak(s) exceed the allowed maximum ${(maximums.secretLeakCount ?? 0)}`,
    );
  }

  return {
    failed: reasons.length > 0,
    reasons,
    datasetSha256: actualHash,
  };
}
