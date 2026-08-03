/**
 * Onboarding step constants + types — the single source of truth for the
 * "first recovered run" guided checklist shared by the API (which derives
 * progress) and the web (which renders the banner).
 *
 * This file has **zero runtime dependencies** (no Zod) so the web bundle can
 * pull it via `@/lib/onboarding` without dragging the workflow
 * Zod schemas into the browser — same posture as `./status` and
 * `./workflow-diff`. The API does its own inline Zod validation of inbound
 * request bodies.
 *
 * Used by:
 * - `apps/api/src/routes/onboarding-routes.ts` — derives each milestone from
 *   durable org-state and composes the `OnboardingState` response.
 * - The backend onboarding store — the persisted
 *   `onboarding_progress.step` high-water column stores one of
 *   `ONBOARDING_STEPS`; `stepIndex` is the high-water comparison key.
 * - `apps/web/src/components/OnboardingBanner.tsx` — renders the ordered
 *   milestones and resolves the current step's CTA target.
 *
 * Invariants:
 * - `ONBOARDING_STEPS` order is canonical and load-bearing: a step's index in
 *   this tuple IS its `order` AND the monotonic high-water comparison key.
 *   Inserting a step shifts every later step's index — coordinate with the
 *   persisted `onboarding_progress.step` column if you ever reorder.
 * - The six milestones before `completed` are each independently derivable
 *   from durable org-state; `completed` is the aggregate (all six done) and
 *   is never advanced on its own.
 */

/**
 * Ordered onboarding milestones. The tuple index is the canonical `order`
 * and the high-water comparison key. `completed` is the terminal aggregate.
 */
export const ONBOARDING_STEPS = [
  "org_created",
  "credential_configured",
  "pack_installed",
  "first_run_succeeded",
  "failure_injected",
  "recovery_applied",
  "completed",
] as const;

/** One onboarding milestone key. */
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Persisted lifecycle status of a user's onboarding row. */
export const ONBOARDING_STATUSES = ["active", "skipped", "completed"] as const;

/** Lifecycle status of a `(orgId, userId)` onboarding row. */
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

/**
 * Operator-driven transitions accepted by `POST /onboarding`.
 * - `skip` / `resume` toggle the banner (active ⇄ skipped).
 * - `restart` replays the whole flow on the same tenant: it stamps a restart
 *   epoch so milestone derivation only counts activity AFTER the restart, so
 *   even a completed onboarding shows the banner again from step one.
 */
export const ONBOARDING_ACTIONS = ["skip", "resume", "restart"] as const;

/** One accepted `POST /onboarding` action. */
export type OnboardingAction = (typeof ONBOARDING_ACTIONS)[number];

/**
 * Panel a milestone's CTA links into. A closed subset of the web's
 * `ActiveTab` values, declared here as its own union so the shared module
 * stays free of any web-side type import.
 */
export type OnboardingTarget = "home" | "credentials" | "packs";

/**
 * Panel each milestone's CTA navigates to. Server-owned single source of
 * truth — the route stamps each milestone's `target` from this map so the
 * web never hard-codes step→panel routing.
 */
export const ONBOARDING_STEP_TARGETS: Record<OnboardingStep, OnboardingTarget> = {
  org_created: "home",
  credential_configured: "credentials",
  pack_installed: "packs",
  first_run_succeeded: "packs",
  failure_injected: "packs",
  recovery_applied: "home",
  completed: "home",
};

/** One milestone in the `OnboardingState.milestones` array. */
export type OnboardingMilestone = {
  /** The milestone key. */
  step: OnboardingStep;
  /** Whether the milestone has been achieved (derived OR the high-water floor). */
  done: boolean;
  /** Canonical position — the index of `step` in `ONBOARDING_STEPS`. */
  order: number;
  /** Panel the banner CTA navigates to for this step. */
  target: OnboardingTarget;
};

/**
 * Full onboarding snapshot returned by `GET /onboarding`. The server owns
 * the milestone order + link targets; the web renders this verbatim and
 * never re-derives the sequence.
 */
export type OnboardingState = {
  /**
   * Whether onboarding is enabled for this org (the `org_configs.onboarding.enabled`
   * tenant toggle, default `true`). When `false` the server skips all milestone
   * derivation and the banner renders nothing — the operator can flip this off
   * once the team is past onboarding.
   */
  enabled: boolean;
  /** Persisted lifecycle status. */
  status: OnboardingStatus;
  /** First milestone with `done=false`, or `null` when all are done. UI hint only — never a gate. */
  currentStep: OnboardingStep | null;
  /** Derived: all six advanceable milestones are done. */
  completed: boolean;
  /** Whether an AI provider key is configured for the org (drives the banner's fallback copy). */
  aiAvailable: boolean;
  /** ISO timestamp the user skipped onboarding, or `null`. */
  skippedAt: string | null;
  /** ISO timestamp onboarding completed, or `null`. */
  completedAt: string | null;
  /** Ordered milestones (length === `ONBOARDING_STEPS.length`). */
  milestones: OnboardingMilestone[];
};

const ONBOARDING_STEP_SET: ReadonlySet<string> = new Set(ONBOARDING_STEPS);

/** Type guard for an onboarding step string from a persisted row / payload. */
export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return typeof value === "string" && ONBOARDING_STEP_SET.has(value);
}

const ONBOARDING_ACTION_SET: ReadonlySet<string> = new Set(ONBOARDING_ACTIONS);

/** Type guard for an accepted `POST /onboarding` action string. */
export function isOnboardingAction(value: unknown): value is OnboardingAction {
  return typeof value === "string" && ONBOARDING_ACTION_SET.has(value);
}

/**
 * Canonical index of a step — its position in `ONBOARDING_STEPS`. The
 * monotonic high-water comparison key and a milestone's `order`. Returns
 * `-1` for a non-step value (callers treat that as "no progress").
 */
export function stepIndex(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step);
}
