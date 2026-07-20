/**
 * Read-only memory governance surface.
 *
 * `GET /memory/consent-status` returns the two-flag consent posture and the
 * deterministic BullMQ purge-job projection for the authenticated tenant.
 * It never returns environment names, Redis state, or raw infrastructure
 * errors. The route is safe for every operator with recovery-read access so
 * the Recovery Center can warn about a pending deletion before it fires.
 */

import { getOrgConfigSnapshot } from "@janusly/data";
import { getMemoryPurgeStatus } from "@janusly/engine/src/memory-purge-scheduler";

import { memoryConsentStatusContract } from "../api-contracts";
import { sendJson } from "../http";
import type { Route } from "../routes";

export const memoryRoutes: Route[] = [
  {
    method: "GET",
    match: "/memory/consent-status",
    role: "viewer",
    permission: "recovery.read",
    contract: memoryConsentStatusContract,
    handler: async ({ res, auth }) => {
      const [snapshot, purge] = await Promise.all([
        getOrgConfigSnapshot(auth.orgId),
        getMemoryPurgeStatus({ orgId: auth.orgId }),
      ]);
      const processEnabled = process.env.JANUSLY_MEMORY_ENABLED === "true";
      const tenantEnabled = snapshot.memory.enabled;
      return sendJson(res, {
        enabled: processEnabled && tenantEnabled,
        processEnabled,
        tenantEnabled,
        purge,
      });
    },
  },
];
