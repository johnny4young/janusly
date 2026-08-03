// Closed catalog for opt-in browser and runtime qualification profiles. Each
// existing orchestrator remains the owner of its domain-specific assertions.

export const QUALIFICATION_PROFILES = Object.freeze({
  clean_install: {
    description: "Fresh Supabase Auth and empty Janusly installation",
    destructive: true,
    providerCost: false,
    covers: ["local-clean-install.spec.ts"],
    steps: [["pnpm", ["local:clean-install:smoke"]]],
  },
  identity: {
    description: "Supabase identity creation and restart persistence",
    destructive: true,
    providerCost: false,
    covers: ["local-identity-stack.spec.ts"],
    steps: [["pnpm", ["local:auth:ui-smoke"]]],
    cleanup: [["pnpm", ["local:auth:down"]]],
  },
  persistent_stack: {
    description: "Persistent simulator stack and PagerDuty prompt flow",
    destructive: true,
    providerCost: false,
    covers: ["local-persistent-stack.spec.ts", "pagerduty-prompt-flow.spec.ts"],
    steps: [
      ["pnpm", ["local:up"]],
      ["pnpm", ["local:ui-smoke"]],
    ],
    cleanup: [["pnpm", ["local:down"]]],
  },
  security: {
    description: "Managed-secret confidentiality and security UI",
    destructive: true,
    providerCost: false,
    covers: ["local-security.spec.ts"],
    steps: [["pnpm", ["local:security:smoke"]]],
  },
  tenant_isolation: {
    description: "Cross-organization data and membership isolation",
    destructive: true,
    providerCost: false,
    covers: ["local-tenant-isolation.spec.ts"],
    steps: [["pnpm", ["local:tenant-isolation:smoke"]]],
  },
  upgrade_rollback: {
    description: "Forward migration, rollback, and restored identity state",
    destructive: true,
    providerCost: false,
    covers: ["local-upgrade-rollback.spec.ts"],
    steps: [["pnpm", ["local:upgrade-rollback:smoke"]]],
  },
  semantic_outcome: {
    description: "Semantic recovery outcome qualification UI",
    destructive: true,
    providerCost: false,
    covers: ["semantic-outcome-recovery.spec.ts"],
    steps: [
      ["pnpm", ["local:up"]],
      ["pnpm", ["local:semantic-outcome-ui-smoke"]],
    ],
    cleanup: [["pnpm", ["local:down"]]],
  },
  recovery_lab: {
    description: "Persistent recovery lab and evidence-bound UI",
    destructive: true,
    providerCost: false,
    covers: ["real-recovery-lab.spec.ts"],
    steps: [
      ["pnpm", ["local:up"]],
      ["pnpm", ["local:recovery-lab:ui-smoke"]],
    ],
    cleanup: [
      ["pnpm", ["local:recovery-lab:destroy"]],
      ["pnpm", ["local:down"]],
    ],
  },
  load_soak: {
    description: "Bounded local load, queue pressure, drain, and UI evidence",
    destructive: true,
    providerCost: false,
    covers: ["local-load-soak.spec.ts"],
    steps: [["pnpm", ["local:load-soak:smoke", "--", "--confirm-reset"]]],
  },
  go_web: {
    description: "Six Go-only browser smoke journeys on isolated PostgreSQL 18",
    destructive: false,
    providerCost: false,
    covers: ["go-pilot-smoke.spec.ts"],
    steps: [["node", ["go/conformance/run-web-qualification.mjs"]]],
  },
  real_provider: {
    description: "Real Anthropic identity, usage, cost, and browser qualification",
    destructive: true,
    providerCost: true,
    covers: ["local-real-provider.spec.ts"],
    steps: [[
      "pnpm",
      ["local:real-provider:smoke", "--", "--confirm-reset", "--confirm-provider-cost"],
    ]],
  },
});

export const ALL_LOCAL_PROFILES = Object.freeze(
  Object.entries(QUALIFICATION_PROFILES)
    .filter(([, profile]) => !profile.providerCost)
    .map(([id]) => id),
);

export function resolveQualificationProfiles(value) {
  const requested = value === "all_local"
    ? ALL_LOCAL_PROFILES
    : String(value ?? "").split(",").map(item => item.trim()).filter(Boolean);
  if (requested.length === 0) throw new Error("at least one qualification profile is required");
  const unique = [...new Set(requested)];
  for (const id of unique) {
    if (!QUALIFICATION_PROFILES[id]) throw new Error(`unknown qualification profile: ${id}`);
  }
  return unique;
}

export function assertQualificationRequest({ profileIds, confirmDestructive, confirmProviderCost }) {
  const profiles = profileIds.map(id => QUALIFICATION_PROFILES[id]);
  if (profiles.some(profile => profile.destructive) && !confirmDestructive) {
    throw new Error("qualification profiles can reset local data; repeat with --confirm-destructive");
  }
  if (profiles.some(profile => profile.providerCost) && !confirmProviderCost) {
    throw new Error("real-provider qualification spends credits; repeat with --confirm-provider-cost");
  }
  return profileIds;
}
