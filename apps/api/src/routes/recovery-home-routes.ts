/**
 * Coalesced Home read model.
 *
 * Each section settles independently so one unavailable projection never
 * erases healthy recovery data. The full scope replaces the landing page's
 * initial request burst; the impact scope keeps the lightweight convergence
 * poll to one request.
 */

import {
  listRecoveryCases,
  queryOperatorRecoveryCount,
  queryRecoveryHeatmap,
  queryRecoveryLedger,
  queryRecoveryValidation,
} from "@janusly/data";

import {
  countDeadLettersByStatus,
  queryRecoveryQueuePage,
} from "../dlq";
import { sendJson } from "../http";
import { requirePermission } from "../permissions";
import {
  queryFailureClustersReadModel,
  queryRecoveryMetricsReadModel,
} from "../recovery-read-models";
import type { AuthContext } from "../auth";
import type { Route } from "../routes";

type HomeSection<T> =
  | { status: "ok"; value: T }
  | { status: "unavailable" };

async function settle<T>(
  loader: () => Promise<T>,
): Promise<HomeSection<T>> {
  try {
    return { status: "ok", value: await loader() };
  } catch {
    return { status: "unavailable" };
  }
}

async function requireSectionPermission(
  auth: AuthContext,
  permission: Parameters<typeof requirePermission>[2],
): Promise<void> {
  await requirePermission(
    auth.orgId,
    auth.userId,
    permission,
    auth.mode,
  );
}

async function queryQueueOverview(
  auth: AuthContext,
  permissionCheck = requireSectionPermission(auth, "dlq.read"),
) {
  await permissionCheck;
  const [counts, oldestPage] = await Promise.all([
    countDeadLettersByStatus(auth.orgId),
    queryRecoveryQueuePage(
      auth.orgId,
      { status: "open", sort: "oldest" },
      1,
    ),
  ]);
  return {
    counts,
    oldestOpen: oldestPage.items[0] ?? null,
  };
}

async function queryImpactSections(
  auth: AuthContext,
  dlqPermission?: Promise<void>,
) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [ledger, wins, queue] = await Promise.all([
    settle(() => queryRecoveryLedger(auth.orgId)),
    settle(async () => ({
      recovered: await queryOperatorRecoveryCount(
        auth.orgId,
        auth.userId,
        since,
      ),
      windowDays: 30,
    })),
    settle(() => queryQueueOverview(auth, dlqPermission)),
  ]);
  return { ledger, wins, queue };
}

async function queryFullSections(auth: AuthContext) {
  const dlqPermission = requireSectionPermission(auth, "dlq.read");
  const [
    metrics,
    clusters,
    heatmap,
    validation,
    cases,
    impact,
  ] = await Promise.all([
    settle(() => queryRecoveryMetricsReadModel(auth.orgId, 30)),
    settle(async () => {
      await dlqPermission;
      return queryFailureClustersReadModel(auth.orgId, 30);
    }),
    settle(async () => ({
      days: await queryRecoveryHeatmap(auth.orgId, 90),
      windowDays: 90,
    })),
    settle(async () => {
      await requireSectionPermission(auth, "reports.read");
      return queryRecoveryValidation(auth.orgId, 30);
    }),
    settle(async () => ({
      cases: await listRecoveryCases(auth.orgId, {
        openOnly: true,
        limit: 50,
      }),
    })),
    queryImpactSections(auth, dlqPermission),
  ]);
  return {
    metrics,
    clusters,
    heatmap,
    validation,
    cases,
    ...impact,
  };
}

export const recoveryHomeRoutes: Route[] = [
  {
    method: "GET",
    match: (url) =>
      url === "/recovery/home" ||
      url.startsWith("/recovery/home?"),
    role: "viewer",
    permission: "recovery.read",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const scope = url.searchParams.get("scope") === "impact"
        ? "impact"
        : "full";
      const sections = scope === "impact"
        ? await queryImpactSections(auth)
        : await queryFullSections(auth);
      return sendJson(res, {
        scope,
        generatedAt: new Date().toISOString(),
        sections,
      });
    },
  },
];
