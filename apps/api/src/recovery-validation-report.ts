/** Stable download rendering for the controlled-drill validation dossier. */

import type {
  RecoveryValidationBreakdown,
  RecoveryValidationReport,
} from "@janusly/data";

import { slugify } from "./report-download";

export type RecoveryValidationExportFormat = "markdown" | "json";

/** Build a filesystem-safe, organization-identifiable evidence filename. */
export function buildRecoveryValidationFilename(args: {
  orgId: string;
  windowDays: number;
  exportedAt: Date;
  format: RecoveryValidationExportFormat;
}): { asciiFilename: string; utf8Filename: string } {
  const orgSlug = slugify(args.orgId.slice(0, 8)) || "org";
  const datePart = args.exportedAt.toISOString().slice(0, 10);
  const extension = args.format === "json" ? "json" : "md";
  const filename = `janusly-recovery-validation-${orgSlug}-${datePart}-${args.windowDays}d.${extension}`;
  return { asciiFilename: filename, utf8Filename: filename };
}

function percent(value: number | null): string {
  return value == null ? "not enough completed evidence" : `${value.toFixed(1)}%`;
}

function duration(value: number | null): string {
  if (value == null) return "not enough completed evidence";
  if (value < 1_000) return `${value} ms`;
  const totalSeconds = Math.round(value / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [
    hours > 0 ? `${hours}h` : "",
    minutes > 0 ? `${minutes}m` : "",
    seconds > 0 || (hours === 0 && minutes === 0) ? `${seconds}s` : "",
  ].filter(Boolean).join(" ");
}

function markdownCell(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");
}

function appendBreakdown(
  lines: string[],
  title: string,
  entries: RecoveryValidationBreakdown[],
): void {
  lines.push(`## ${title}`, "");
  if (entries.length === 0) {
    lines.push("No controlled drill evidence in this window.", "");
    return;
  }
  lines.push("| Category | Drills | Completed | Recovered | Accepted loss | Recovery rate |", "| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const entry of entries) {
    lines.push(`| ${markdownCell(entry.key)} | ${entry.total} | ${entry.completed} | ${entry.recovered} | ${entry.acceptedLoss} | ${percent(entry.recoveryRatePercent)} |`);
  }
  lines.push("");
}

/** Render a shareable report without overstating private-beta completion. */
export function buildRecoveryValidationMarkdown(args: {
  orgId: string;
  report: RecoveryValidationReport;
}): string {
  const { report } = args;
  const lines: string[] = [
    `# Recovery Validation Dossier — last ${report.windowDays} days`,
    "",
    "> **Scope:** controlled recovery drills for one organization. This dossier does not measure external partner count or setup time and is not proof that private-beta acceptance is complete.",
    "",
    `_Organization: ${markdownCell(args.orgId.slice(0, 120))} · Generated: ${report.generatedAt}_`,
    "",
    "## Evidence summary",
    "",
    `- **Controlled drills observed**: ${report.totals.drills}${report.sampleCapped ? ` (newest ${report.sampleLimit}; sample capped)` : ""}`,
    `- **Completed outcomes**: ${report.totals.completed}/${report.totals.drills} (${percent(report.totals.completionRatePercent)})`,
    `- **Recovery rate among completed outcomes**: ${report.totals.recovered}/${report.totals.completed} (${percent(report.totals.recoveryRatePercent)})`,
    `- **Accepted loss**: ${report.totals.acceptedLoss}`,
    `- **Awaiting action / replay in progress**: ${report.totals.awaitingAction} / ${report.totals.replayInProgress}`,
    `- **Incomplete / missing evidence**: ${report.totals.measurementIncomplete} / ${report.totals.missingEvidence}`,
    `- **Median measured recovery time**: ${duration(report.timing.medianElapsedMs)} (recovered outcomes; n=${report.timing.sampleSize})`,
    `- **p90 measured recovery time**: ${duration(report.timing.p90ElapsedMs)} (recovered outcomes; n=${report.timing.sampleSize})`,
    `- **Average / p95 measured recovery time**: ${duration(report.timing.averageElapsedMs)} / ${duration(report.timing.p95ElapsedMs)} (recovered outcomes; n=${report.timing.sampleSize})`,
    "",
    "## Resolution ownership",
    "",
    `- **Operator-resolved**: ${report.resolution.operator}`,
    `- **Automated**: ${report.resolution.automated}`,
    `- **Unknown actor**: ${report.resolution.unknown}`,
    `- **Operator intervention among known actors**: ${percent(report.resolution.operatorInterventionRatePercent)}`,
    "",
  ];

  appendBreakdown(lines, "Failure-mode coverage", report.byFailureMode);
  appendBreakdown(lines, "Recovery-path coverage", report.byRecoveryPath);

  lines.push("## Drill evidence", "");
  if (report.samples.length === 0) {
    lines.push("No controlled drill evidence in this window.", "");
  } else {
    lines.push("| Run | Pack / fixture | Failure mode | Recovery path | Outcome | Resolution | Elapsed | Evidence |", "| --- | --- | --- | --- | --- | --- | ---: | --- |");
    for (const sample of report.samples) {
      lines.push(`| ${markdownCell(sample.runId)} | ${markdownCell(`${sample.packId} / ${sample.fixtureId}`)} | ${markdownCell(sample.failureMode)} | ${markdownCell(sample.recoveryPath)} | ${sample.outcome?.status ?? "missing_evidence"} | ${sample.resolutionMode} | ${duration(sample.outcome?.elapsedMs ?? null)} | ${sample.outcome?.evidence ?? "none"} |`);
    }
    lines.push("");
  }

  lines.push(
    "## Interpretation boundaries",
    "",
    "- Recovery requires an immutable terminal impact event; enqueueing a replay is not recovery.",
    "- Recovery rate uses completed outcomes only: recovered / (recovered + accepted loss). Pending, incomplete, and missing evidence remain visible but stay out of that denominator.",
    "- Recovery-time statistics use verified recovered outcomes only; accepted loss is not recovery-time evidence.",
    "- Operator intervention excludes completed outcomes whose actor cannot be identified.",
    "- Partner recruitment, production onboarding time, and willingness-to-pay remain external validation evidence.",
    "",
  );
  return lines.join("\n");
}
