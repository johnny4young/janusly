export function assertUpgradeQualificationRequest(argumentsList) {
  if (!argumentsList.includes("--confirm-reset")) {
    throw new Error(
      "upgrade qualification removes all local Auth and Janusly data; repeat with --confirm-reset",
    );
  }
}

export function validateMigrationUpgrade(baseline, current) {
  if (!Array.isArray(baseline) || baseline.length === 0) {
    throw new Error("upgrade baseline must contain at least one migration");
  }
  if (!Array.isArray(current) || current.length <= baseline.length) {
    throw new Error("upgrade candidate must add at least one migration");
  }

  for (const [index, entry] of baseline.entries()) {
    const candidate = current[index];
    if (
      candidate?.path !== entry.path
      || candidate.sha256 !== entry.sha256
    ) {
      throw new Error(
        `historical migration prefix changed at ${entry.path}`,
      );
    }
  }
  return current.slice(baseline.length);
}
