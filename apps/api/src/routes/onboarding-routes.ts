/**
 * Onboarding routes — the "first recovered run" guided checklist state.
 *
 * Two routes:
 *   - `GET  /onboarding`  (viewer, onboarding.read)  — derive + return state
 *   - `POST /onboarding`  (viewer, onboarding.write) — skip / resume
 *
 * Derive-on-read: the six advanceable milestones are computed live from
 * durable org-state (`resolveOnboardingMilestones`) on each read — no event
 * hook, no engine change. The persisted `onboarding_progress` row is only a
 * per-user cache of the high-water `step` + the `active`/`skipped`/`completed`
 * status. The display booleans are the live-derived signals; the column
 * advances monotonically for the AC's "furthest reached" record and the
 * `completed` short-circuit. A regression of a derived signal during the
 * brief active-onboarding window is immaterial (retention floors are 90+
 * days) and a completed onboarding latches via `status` + the short-circuit.
 *
 * Multi-tenant: the row is scoped to `(auth.orgId, auth.userId)`; every
 * milestone derivation query is org-scoped. The `credential_configured`
 * milestone checks only for the EXISTENCE of a credential row — never a
 * `secretRef` or env-var name.
 *
 * AI-unavailable never deadlocks: no milestone requires AI to advance
 * (pack install is deterministic, the sample-run's AI nodes fall back,
 * inject-failure + dlq.replay are deterministic). `aiAvailable` is surfaced
 * purely so the banner can show the manual-path copy.
 */

import { z } from "zod";

import {
  advanceOnboardingHighWater,
  completeOnboardingCas,
  ensureOnboardingRow,
  getOnboardingProgress,
  isOnboardingEnabled,
  resolveOnboardingMilestones,
  restartOnboarding,
  setOnboardingStatus,
  type OnboardingMilestoneSignals,
  type OnboardingProgressRow,
} from "@janusly/data";
import {
  ONBOARDING_STEPS,
  ONBOARDING_STEP_TARGETS,
  isOnboardingAction,
  type OnboardingState,
  type OnboardingStatus,
  type OnboardingStep,
} from "@janusly/shared/src/onboarding";

import { aiStatus } from "../ai-runtime";
import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendError, sendJson } from "../http";
import type { AuthContext } from "../auth";
import type { Route } from "../routes";

/** The six milestones that advance via derived org-state (excludes `completed`). */
const ADVANCEABLE_STEPS = ONBOARDING_STEPS.filter(
  (step): step is Exclude<OnboardingStep, "completed"> => step !== "completed",
);

/** Map a single advanceable milestone to its derived done-signal. */
function deriveDone(step: OnboardingStep, signals: OnboardingMilestoneSignals): boolean {
  switch (step) {
    case "org_created":
      return true; // always true once authenticated
    case "credential_configured":
      return signals.credentialConfigured;
    case "pack_installed":
      return signals.packInstalled;
    case "first_run_succeeded":
      return signals.firstRunSucceeded;
    case "failure_injected":
      return signals.failureInjected;
    case "recovery_applied":
      return signals.recoveryApplied;
    case "completed":
      return false; // aggregate — computed from the six, never derived directly
  }
}

/** The furthest advanceable step that is currently derived-done (for the high-water write). */
function furthestDerivedStep(signals: OnboardingMilestoneSignals): OnboardingStep {
  let furthest: OnboardingStep = "org_created";
  for (const step of ADVANCEABLE_STEPS) {
    if (deriveDone(step, signals)) furthest = step;
  }
  return furthest;
}

function isoOrNull(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** Compose the wire state from a row + (live or all-done) milestone booleans. */
function composeState(
  row: OnboardingProgressRow,
  doneFor: (step: OnboardingStep) => boolean,
  completed: boolean,
  aiAvailable: boolean,
): OnboardingState {
  const milestones = ONBOARDING_STEPS.map((step, order) => ({
    step,
    order,
    target: ONBOARDING_STEP_TARGETS[step],
    done: doneFor(step),
  }));
  return {
    enabled: true,
    status: row.status as OnboardingStatus,
    currentStep: milestones.find((m) => !m.done)?.step ?? null,
    completed,
    aiAvailable,
    skippedAt: isoOrNull(row.skippedAt),
    completedAt: isoOrNull(row.completedAt),
    milestones,
  };
}

/**
 * Hidden state returned when the `org_configs.onboarding.enabled` toggle is
 * off. Skips all derivation (and the row create) — the banner renders nothing
 * on `enabled: false`. Flipping the toggle back on resumes from the org's
 * derived progress on the next read.
 */
function disabledOnboardingState(): OnboardingState {
  return {
    enabled: false,
    status: "active",
    currentStep: null,
    completed: false,
    aiAvailable: false,
    skippedAt: null,
    completedAt: null,
    milestones: ONBOARDING_STEPS.map((step, order) => ({
      step,
      order,
      target: ONBOARDING_STEP_TARGETS[step],
      done: false,
    })),
  };
}

/**
 * Load (and lazily reconcile) the onboarding state for the request's user.
 * Ensures the row, short-circuits a completed row, otherwise derives the
 * milestones, advances the high-water mark, and auto-completes via CAS
 * (auditing `onboarding.completed` exactly once on the winning transition).
 */
async function loadOnboardingState(auth: AuthContext): Promise<OnboardingState> {
  const { orgId, userId } = auth;

  // Tenant toggle: when disabled, skip the row create + all derivation and
  // return a hidden state. Flipping it back on resumes from derived progress.
  if (!(await isOnboardingEnabled(orgId))) return disabledOnboardingState();

  let row = await ensureOnboardingRow(orgId, userId);
  const { enabled: aiAvailable } = await aiStatus(orgId);

  // Completed rows skip all derivation — the status latch is authoritative.
  if (row.status === "completed") {
    return composeState(row, () => true, true, aiAvailable);
  }

  // After a restart, only count activity since the restart epoch so the
  // operator can replay the whole flow on the same tenant.
  const signals = await resolveOnboardingMilestones(orgId, row.restartedAt ?? undefined);
  await advanceOnboardingHighWater(orgId, userId, furthestDerivedStep(signals));

  const allSixDone = ADVANCEABLE_STEPS.every((step) => deriveDone(step, signals));
  if (allSixDone) {
    const transitioned = await completeOnboardingCas(orgId, userId);
    if (transitioned) {
      await auditAction(auth, "onboarding.completed", { targetType: "onboarding" });
      row = transitioned;
    } else {
      // A concurrent read won the completion — re-read for authoritative status.
      row = (await getOnboardingProgress(orgId, userId)) ?? row;
    }
  }

  const doneFor = (step: OnboardingStep): boolean =>
    step === "completed" ? allSixDone : deriveDone(step, signals);
  return composeState(row, doneFor, allSixDone, aiAvailable);
}

const OnboardingActionBodySchema = z.object({ action: z.string() });

export const onboardingRoutes: Route[] = [
  {
    method: "GET",
    match: (url) => url === "/onboarding" || url.startsWith("/onboarding?"),
    role: "viewer",
    permission: "onboarding.read",
    handler: async ({ res, auth }) => sendJson(res, await loadOnboardingState(auth)),
  },
  {
    method: "POST",
    match: (url) => url === "/onboarding" || url.startsWith("/onboarding?"),
    role: "viewer",
    permission: "onboarding.write",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parsed = OnboardingActionBodySchema.safeParse(body);
      const action = parsed.success ? parsed.data.action : null;
      if (!isOnboardingAction(action)) {
        return sendError(res, "onboarding_invalid_action", "Unknown onboarding action", 400);
      }

      await ensureOnboardingRow(auth.orgId, auth.userId);
      if (action === "restart") {
        const restarted = await restartOnboarding(auth.orgId, auth.userId);
        if (restarted) {
          await auditAction(auth, "onboarding.restarted", { targetType: "onboarding" });
        }
      } else {
        const transitioned = await setOnboardingStatus(
          auth.orgId,
          auth.userId,
          action === "skip" ? "skipped" : "active",
        );
        if (transitioned) {
          await auditAction(auth, action === "skip" ? "onboarding.skipped" : "onboarding.resumed", {
            targetType: "onboarding",
          });
        }
      }

      return sendJson(res, await loadOnboardingState(auth));
    },
  },
];
