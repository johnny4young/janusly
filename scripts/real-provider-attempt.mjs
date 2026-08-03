import { access, writeFile } from "node:fs/promises";

export async function assertProviderCostAttemptAvailable(path) {
  try {
    await access(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    "a provider-cost attempt is already recorded; obtain a new explicit authorization before removing its local record",
  );
}

export async function reserveProviderCostAttempt({
  path,
  budgetUsd,
  source,
  provider,
  model,
  now = () => new Date(),
}) {
  const record = {
    status: "reserved",
    reservedAt: now().toISOString(),
    authorizedBudgetUsd: budgetUsd,
    provider,
    model,
    source,
  };
  try {
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new Error(
        "a provider-cost attempt is already recorded; obtain a new explicit authorization before removing its local record",
      );
    }
    throw error;
  }
  return record;
}

export async function completeProviderCostAttempt({
  path,
  record,
  observedCostUsd,
  now = () => new Date(),
}) {
  const completed = {
    ...record,
    status: "completed",
    completedAt: now().toISOString(),
    observedCostUsd,
  };
  await writeFile(path, `${JSON.stringify(completed, null, 2)}\n`, {
    mode: 0o600,
  });
  return completed;
}

export async function failProviderCostAttempt({
  path,
  record,
  observedCostUsd = null,
  usageCalls = null,
  accountingComplete = false,
  now = () => new Date(),
}) {
  const failed = {
    ...record,
    status: "failed",
    failedAt: now().toISOString(),
    observedCostUsd,
    usageCalls,
    accountingComplete,
  };
  await writeFile(path, `${JSON.stringify(failed, null, 2)}\n`, {
    mode: 0o600,
  });
  return failed;
}
