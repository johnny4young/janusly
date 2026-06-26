/**
 * Pure-unit tests for the `org_configs` catalog: normalization, bounds,
 * validators, and the `memory.*` family.
 *
 * These tests do NOT touch the DB. They exercise `normalizeOrgConfigValue`
 * + `ORG_CONFIG_DEFINITIONS` directly. Importing the module exercises the
 * boot-time `assertSafeOrgConfigDefinition` guard against every definition,
 * so a missing `ALLOWED_CATEGORIES` entry would fail on import.
 */

import { describe, expect, it } from "vitest";

import type { OrgConfigDefinition } from "./orgConfigRepo";
import { ORG_CONFIG_DEFINITIONS, normalizeOrgConfigValue } from "./orgConfigRepo";

const findDef = (key: string): OrgConfigDefinition => {
  const def = ORG_CONFIG_DEFINITIONS.find((d) => d.key === key);
  if (!def) throw new Error(`catalog missing key: ${key}`);
  return def;
};

describe("ORG_CONFIG_DEFINITIONS memory.* family", () => {
  it("catalogues every memory.* key from the memory policy", () => {
    const memoryKeys = ORG_CONFIG_DEFINITIONS.filter((d) => d.key.startsWith("memory.")).map(
      (d) => d.key,
    );
    expect(memoryKeys.sort()).toEqual(
      [
        "memory.enabled",
        "memory.allowedKinds",
        "memory.retentionDaysByKind",
        "memory.recallMaxEntries",
        "memory.recallMaxBytes",
        "memory.embeddingProvider",
        "memory.embeddingModel",
        "memory.embeddingBaseUrl",
      ].sort(),
    );
  });

  it("registers every memory.* entry under the `memory` category", () => {
    for (const def of ORG_CONFIG_DEFINITIONS) {
      if (def.key.startsWith("memory.")) {
        expect(def.category).toBe("memory");
      }
    }
  });

  it("declares safe defaults: disabled, no kinds, no retention overrides", () => {
    expect(findDef("memory.enabled").defaultValue).toBe(false);
    expect(findDef("memory.allowedKinds").defaultValue).toBe("");
    expect(findDef("memory.retentionDaysByKind").defaultValue).toBe("");
    expect(findDef("memory.embeddingProvider").defaultValue).toBe("");
    expect(findDef("memory.embeddingModel").defaultValue).toBe("");
  });

  it("has NO env fallback on the tenant consent flag (mirrors mcp.writeConsent)", () => {
    expect(findDef("memory.enabled").envKeys).toBeUndefined();
  });

  it("documents embedding provider/model env fallbacks", () => {
    expect(findDef("memory.embeddingProvider").envKeys).toEqual(["JANUSLY_EMBEDDING_PROVIDER"]);
    expect(findDef("memory.embeddingModel").envKeys).toEqual(["JANUSLY_EMBEDDING_MODEL"]);
    expect(findDef("memory.embeddingBaseUrl").envKeys).toEqual(["OLLAMA_BASE_URL"]);
  });
});

describe("normalizeOrgConfigValue — memory.enabled", () => {
  const def = findDef("memory.enabled");

  it("accepts true / false", () => {
    expect(normalizeOrgConfigValue(def, true)).toBe(true);
    expect(normalizeOrgConfigValue(def, false)).toBe(false);
  });

  it("rejects non-boolean", () => {
    expect(() => normalizeOrgConfigValue(def, "true")).toThrow(/must be a boolean/);
    expect(() => normalizeOrgConfigValue(def, 1)).toThrow(/must be a boolean/);
  });
});

describe("normalizeOrgConfigValue — memory.allowedKinds CSV validator", () => {
  const def = findDef("memory.allowedKinds");

  it("accepts empty string (no kinds enabled)", () => {
    expect(normalizeOrgConfigValue(def, "")).toBe("");
    expect(normalizeOrgConfigValue(def, "   ")).toBe("");
  });

  it("accepts a single closed-enum kind", () => {
    expect(normalizeOrgConfigValue(def, "recovery_rationale")).toBe("recovery_rationale");
    expect(normalizeOrgConfigValue(def, "workflow_vector")).toBe("workflow_vector");
    expect(normalizeOrgConfigValue(def, "agent_episode")).toBe("agent_episode");
  });

  it("accepts the full closed enum", () => {
    const all = "recovery_rationale,run_summary,runbook_fragment,patch_rationale,generated_workflow,workflow_vector,agent_episode";
    expect(normalizeOrgConfigValue(def, all)).toBe(all);
  });

  it("tolerates whitespace around CSV entries", () => {
    expect(normalizeOrgConfigValue(def, " recovery_rationale , run_summary ")).toBe(
      "recovery_rationale , run_summary",
    );
  });

  it("rejects an unknown kind", () => {
    expect(() => normalizeOrgConfigValue(def, "recovery_rationale,evil_kind")).toThrow(
      /is not one of/,
    );
  });

  it("rejects a misspelling", () => {
    expect(() => normalizeOrgConfigValue(def, "recovery_rational")).toThrow(/is not one of/);
  });
});

describe("normalizeOrgConfigValue — memory.retentionDaysByKind JSON validator", () => {
  const def = findDef("memory.retentionDaysByKind");

  it("accepts empty (use per-kind defaults)", () => {
    expect(normalizeOrgConfigValue(def, "")).toBe("");
  });

  it("accepts a valid kind=>days map", () => {
    const json = '{"recovery_rationale":180,"run_summary":90}';
    expect(normalizeOrgConfigValue(def, json)).toBe(json);
  });

  it("accepts empty JSON object {}", () => {
    expect(normalizeOrgConfigValue(def, "{}")).toBe("{}");
  });

  it("rejects malformed JSON", () => {
    expect(() => normalizeOrgConfigValue(def, "{not-json}")).toThrow(/must be valid JSON/);
  });

  it("rejects JSON array (not an object)", () => {
    expect(() => normalizeOrgConfigValue(def, "[180]")).toThrow(/must be a JSON object/);
  });

  it("rejects JSON null (not an object)", () => {
    expect(() => normalizeOrgConfigValue(def, "null")).toThrow(/must be a JSON object/);
  });

  it("rejects unknown kind", () => {
    expect(() => normalizeOrgConfigValue(def, '{"evil_kind":30}')).toThrow(/is not one of/);
  });

  it("rejects non-integer days", () => {
    expect(() => normalizeOrgConfigValue(def, '{"recovery_rationale":1.5}')).toThrow(
      /positive integer/,
    );
    expect(() => normalizeOrgConfigValue(def, '{"recovery_rationale":"180"}')).toThrow(
      /positive integer/,
    );
  });

  it("rejects zero / negative days", () => {
    expect(() => normalizeOrgConfigValue(def, '{"recovery_rationale":0}')).toThrow(
      /positive integer/,
    );
    expect(() => normalizeOrgConfigValue(def, '{"recovery_rationale":-1}')).toThrow(
      /positive integer/,
    );
  });

  it("enforces the per-kind maximum from the memory policy", () => {
    // recovery_rationale max is 730 days
    expect(() => normalizeOrgConfigValue(def, '{"recovery_rationale":731}')).toThrow(/must be <=/);
    // run_summary max is 365 days
    expect(() => normalizeOrgConfigValue(def, '{"run_summary":366}')).toThrow(/must be <=/);
    // runbook_fragment max is 36,500 days (100-year effective cap)
    expect(() => normalizeOrgConfigValue(def, '{"runbook_fragment":36501}')).toThrow(/must be <=/);
    // patch_rationale max is 730 days
    expect(() => normalizeOrgConfigValue(def, '{"patch_rationale":731}')).toThrow(/must be <=/);
    // generated_workflow max is 730 days
    expect(() => normalizeOrgConfigValue(def, '{"generated_workflow":731}')).toThrow(/must be <=/);
    // workflow_vector max is 730 days
    expect(() => normalizeOrgConfigValue(def, '{"workflow_vector":731}')).toThrow(/must be <=/);
    // agent_episode max is 730 days
    expect(() => normalizeOrgConfigValue(def, '{"agent_episode":731}')).toThrow(/must be <=/);
  });

  it("accepts each kind at its per-kind maximum", () => {
    expect(normalizeOrgConfigValue(def, '{"recovery_rationale":730}')).toBeTruthy();
    expect(normalizeOrgConfigValue(def, '{"run_summary":365}')).toBeTruthy();
    expect(normalizeOrgConfigValue(def, '{"runbook_fragment":36500}')).toBeTruthy();
    expect(normalizeOrgConfigValue(def, '{"patch_rationale":730}')).toBeTruthy();
    expect(normalizeOrgConfigValue(def, '{"generated_workflow":730}')).toBeTruthy();
    expect(normalizeOrgConfigValue(def, '{"workflow_vector":730}')).toBeTruthy();
    expect(normalizeOrgConfigValue(def, '{"agent_episode":730}')).toBeTruthy();
  });
});

describe("normalizeOrgConfigValue — memory.recallMaxEntries bounds", () => {
  const def = findDef("memory.recallMaxEntries");

  it("uses default 8 from the memory policy", () => {
    expect(def.defaultValue).toBe(8);
  });

  it("accepts in-range values", () => {
    expect(normalizeOrgConfigValue(def, 1)).toBe(1);
    expect(normalizeOrgConfigValue(def, 8)).toBe(8);
    expect(normalizeOrgConfigValue(def, 32)).toBe(32);
  });

  it("rejects below minimum (1)", () => {
    expect(() => normalizeOrgConfigValue(def, 0)).toThrow(/>= 1/);
  });

  it("rejects above maximum (32)", () => {
    expect(() => normalizeOrgConfigValue(def, 33)).toThrow(/<= 32/);
    expect(() => normalizeOrgConfigValue(def, 1000)).toThrow(/<= 32/);
  });
});

describe("normalizeOrgConfigValue — memory.recallMaxBytes bounds", () => {
  const def = findDef("memory.recallMaxBytes");

  it("uses default 8192 from the memory policy", () => {
    expect(def.defaultValue).toBe(8192);
  });

  it("accepts in-range values", () => {
    expect(normalizeOrgConfigValue(def, 1024)).toBe(1024);
    expect(normalizeOrgConfigValue(def, 8192)).toBe(8192);
    expect(normalizeOrgConfigValue(def, 65536)).toBe(65536);
  });

  it("rejects below minimum (1024)", () => {
    expect(() => normalizeOrgConfigValue(def, 512)).toThrow(/>= 1024/);
  });

  it("rejects above maximum (65536)", () => {
    expect(() => normalizeOrgConfigValue(def, 131072)).toThrow(/<= 65536/);
  });
});

describe("normalizeOrgConfigValue — memory.embeddingProvider allowedValues", () => {
  const def = findDef("memory.embeddingProvider");

  it("accepts empty (env-default fallback)", () => {
    expect(normalizeOrgConfigValue(def, "")).toBe("");
  });

  it("accepts each provider in the closed enum", () => {
    expect(normalizeOrgConfigValue(def, "ollama")).toBe("ollama");
    expect(normalizeOrgConfigValue(def, "voyage")).toBe("voyage");
    expect(normalizeOrgConfigValue(def, "openai")).toBe("openai");
  });

  it("rejects providers outside the closed enum", () => {
    expect(() => normalizeOrgConfigValue(def, "anthropic")).toThrow(/must be one of/);
    expect(() => normalizeOrgConfigValue(def, "cohere")).toThrow(/must be one of/);
  });
});

describe("normalizeOrgConfigValue — memory.embeddingModel", () => {
  const def = findDef("memory.embeddingModel");

  it("accepts empty (env-default fallback)", () => {
    expect(normalizeOrgConfigValue(def, "")).toBe("");
  });

  it("accepts a model id", () => {
    expect(normalizeOrgConfigValue(def, "voyage-3-large")).toBe("voyage-3-large");
  });

  it("rejects secret-shaped values (forbidden-value guard still applies)", () => {
    expect(() =>
      normalizeOrgConfigValue(def, "sk-ant-secret-token-abc123"),
    ).toThrow(/secret-like/);
    expect(() => normalizeOrgConfigValue(def, "ghp_secrettoken123456")).toThrow(/secret-like/);
  });
});

describe("ORG_CONFIG_DEFINITIONS autoHealing.* family", () => {
  it("catalogues every supervised auto-healing key", () => {
    const autoHealingKeys = ORG_CONFIG_DEFINITIONS.filter((d) => d.key.startsWith("autoHealing.")).map(
      (d) => d.key,
    );
    expect(autoHealingKeys.sort()).toEqual(
      [
        "autoHealing.enabled",
        "autoHealing.autoApply",
        "autoHealing.maxAttemptsPerSignature",
        "autoHealing.loopWindowDays",
      ].sort(),
    );
  });

  it("registers every autoHealing.* entry under the `auto-healing` category", () => {
    for (const def of ORG_CONFIG_DEFINITIONS) {
      if (def.key.startsWith("autoHealing.")) {
        expect(def.category).toBe("auto-healing");
      }
    }
  });

  it("keeps both tenant consent flags disabled by default with no env fallback", () => {
    expect(findDef("autoHealing.enabled").defaultValue).toBe(false);
    expect(findDef("autoHealing.enabled").envKeys).toBeUndefined();
    expect(findDef("autoHealing.autoApply").defaultValue).toBe(false);
    expect(findDef("autoHealing.autoApply").envKeys).toBeUndefined();
  });
});

describe("normalizeOrgConfigValue — autoHealing.enabled / autoApply", () => {
  it("accepts true / false and rejects non-boolean values", () => {
    for (const key of ["autoHealing.enabled", "autoHealing.autoApply"]) {
      const def = findDef(key);
      expect(normalizeOrgConfigValue(def, true)).toBe(true);
      expect(normalizeOrgConfigValue(def, false)).toBe(false);
      expect(() => normalizeOrgConfigValue(def, "true")).toThrow(/must be a boolean/);
      expect(() => normalizeOrgConfigValue(def, 1)).toThrow(/must be a boolean/);
    }
  });
});

describe("normalizeOrgConfigValue — autoHealing.maxAttemptsPerSignature bounds", () => {
  const def = findDef("autoHealing.maxAttemptsPerSignature");

  it("uses default 3 and accepts the 1..10 range", () => {
    expect(def.defaultValue).toBe(3);
    expect(normalizeOrgConfigValue(def, 1)).toBe(1);
    expect(normalizeOrgConfigValue(def, 3)).toBe(3);
    expect(normalizeOrgConfigValue(def, 10)).toBe(10);
  });

  it("rejects values outside 1..10", () => {
    expect(() => normalizeOrgConfigValue(def, 0)).toThrow(/>= 1/);
    expect(() => normalizeOrgConfigValue(def, 11)).toThrow(/<= 10/);
  });
});

describe("normalizeOrgConfigValue — autoHealing.loopWindowDays bounds", () => {
  const def = findDef("autoHealing.loopWindowDays");

  it("uses default 14 and accepts the 1..90 range", () => {
    expect(def.defaultValue).toBe(14);
    expect(normalizeOrgConfigValue(def, 1)).toBe(1);
    expect(normalizeOrgConfigValue(def, 14)).toBe(14);
    expect(normalizeOrgConfigValue(def, 90)).toBe(90);
  });

  it("rejects values outside 1..90", () => {
    expect(() => normalizeOrgConfigValue(def, 0)).toThrow(/>= 1/);
    expect(() => normalizeOrgConfigValue(def, 91)).toThrow(/<= 90/);
  });
});

describe("ORG_CONFIG_DEFINITIONS recovery.* family", () => {
  it("catalogues every recovery ownership key", () => {
    const recoveryKeys = ORG_CONFIG_DEFINITIONS.filter((d) => d.key.startsWith("recovery.")).map(
      (d) => d.key,
    );
    expect(recoveryKeys).toEqual([
      "recovery.autoCreateItems",
      "recovery.debounceWindowSeconds",
    ]);
  });

  it("registers every recovery.* entry under the `recovery` category", () => {
    for (const def of ORG_CONFIG_DEFINITIONS) {
      if (def.key.startsWith("recovery.")) {
        expect(def.category).toBe("recovery");
      }
    }
  });

  it("defaults automatic item creation on with no env fallback", () => {
    const def = findDef("recovery.autoCreateItems");
    expect(def.defaultValue).toBe(true);
    expect(def.envKeys).toBeUndefined();
  });

  it("defaults the debounce window to 300s and accepts 0 (off) within 0..3600", () => {
    const def = findDef("recovery.debounceWindowSeconds");
    expect(def.defaultValue).toBe(300);
    expect(def.valueType).toBe("number");
    expect(normalizeOrgConfigValue(def, 0)).toBe(0); // 0 disables debounce
    expect(() => normalizeOrgConfigValue(def, -1)).toThrow();
    expect(() => normalizeOrgConfigValue(def, 3601)).toThrow();
  });
});

describe("normalizeOrgConfigValue — recovery.autoCreateItems", () => {
  const def = findDef("recovery.autoCreateItems");

  it("accepts true / false and rejects non-boolean values", () => {
    expect(normalizeOrgConfigValue(def, true)).toBe(true);
    expect(normalizeOrgConfigValue(def, false)).toBe(false);
    expect(() => normalizeOrgConfigValue(def, "true")).toThrow(/must be a boolean/);
    expect(() => normalizeOrgConfigValue(def, 1)).toThrow(/must be a boolean/);
  });
});

describe("ORG_CONFIG_DEFINITIONS value.* family", () => {
  it("catalogues every value-dashboard key", () => {
    const valueKeys = ORG_CONFIG_DEFINITIONS.filter((d) => d.key.startsWith("value.")).map(
      (d) => d.key,
    );
    expect(valueKeys.sort()).toEqual(
      [
        "value.hourlyCost",
        "value.minutesSavedPerRecovery",
        "value.baselineMttrSeconds",
      ].sort(),
    );
  });

  it("registers every value.* entry under the `value` category", () => {
    for (const def of ORG_CONFIG_DEFINITIONS) {
      if (def.key.startsWith("value.")) {
        expect(def.category).toBe("value");
      }
    }
  });

  it("uses 0 as the baselineMttrSeconds sentinel (no env fallback)", () => {
    const def = findDef("value.baselineMttrSeconds");
    expect(def.defaultValue).toBe(0);
    expect(def.envKeys).toBeUndefined();
  });
});

describe("normalizeOrgConfigValue — value.hourlyCost bounds", () => {
  const def = findDef("value.hourlyCost");

  it("uses default 50 and accepts the 0..2000 range", () => {
    expect(def.defaultValue).toBe(50);
    expect(normalizeOrgConfigValue(def, 0)).toBe(0);
    expect(normalizeOrgConfigValue(def, 50)).toBe(50);
    expect(normalizeOrgConfigValue(def, 2000)).toBe(2000);
  });

  it("rejects values outside 0..2000", () => {
    expect(() => normalizeOrgConfigValue(def, -1)).toThrow(/>= 0/);
    expect(() => normalizeOrgConfigValue(def, 2001)).toThrow(/<= 2000/);
  });

  it("preserves fractional dollars (does not silently floor $125.75 to $125)", () => {
    // Without fractional: true the normalizer Math.floors integers, biasing
    // the dollar-saved estimate. Catalog flips it on; this pin guards against
    // a regression that re-removes the flag.
    expect(normalizeOrgConfigValue(def, 125.75)).toBe(125.75);
    expect(normalizeOrgConfigValue(def, 0.5)).toBe(0.5);
  });
});

describe("normalizeOrgConfigValue — value.minutesSavedPerRecovery / baselineMttrSeconds bounds", () => {
  it("minutesSavedPerRecovery accepts 0..480 (default 30)", () => {
    const def = findDef("value.minutesSavedPerRecovery");
    expect(def.defaultValue).toBe(30);
    expect(normalizeOrgConfigValue(def, 0)).toBe(0);
    expect(normalizeOrgConfigValue(def, 480)).toBe(480);
    expect(() => normalizeOrgConfigValue(def, -1)).toThrow(/>= 0/);
    expect(() => normalizeOrgConfigValue(def, 481)).toThrow(/<= 480/);
  });

  it("baselineMttrSeconds accepts 0..86400 (default 0)", () => {
    const def = findDef("value.baselineMttrSeconds");
    expect(def.defaultValue).toBe(0);
    expect(normalizeOrgConfigValue(def, 0)).toBe(0);
    expect(normalizeOrgConfigValue(def, 3600)).toBe(3600);
    expect(normalizeOrgConfigValue(def, 86_400)).toBe(86_400);
    expect(() => normalizeOrgConfigValue(def, -1)).toThrow(/>= 0/);
    expect(() => normalizeOrgConfigValue(def, 86_401)).toThrow(/<= 86400/);
  });
});

describe("validate hook is opt-in (unchanged-behaviour smoke)", () => {
  // Pre-existing keys without `validate:` must still normalize byte-for-byte.
  // Pick a representative sample across types.
  it("ai.timeoutMs (number with no validate hook) keeps existing bounds behaviour", () => {
    const def = findDef("ai.timeoutMs");
    expect(normalizeOrgConfigValue(def, 30_000)).toBe(30_000);
    expect(() => normalizeOrgConfigValue(def, 0)).toThrow(/>= 1/);
  });

  it("ai.provider (string with allowedValues, no validate hook) keeps existing enum check", () => {
    const def = findDef("ai.provider");
    expect(def.defaultValue).toBe("anthropic");
    expect(normalizeOrgConfigValue(def, "openai")).toBe("openai");
    expect(normalizeOrgConfigValue(def, "anthropic")).toBe("anthropic");
    expect(() => normalizeOrgConfigValue(def, "unknown-vendor")).toThrow(/must be one of/);
  });

  it("mcp.writeConsent (boolean, no validate hook) keeps existing type check", () => {
    const def = findDef("mcp.writeConsent");
    expect(normalizeOrgConfigValue(def, true)).toBe(true);
    expect(() => normalizeOrgConfigValue(def, "yes")).toThrow(/must be a boolean/);
  });

  it("auth.allowedEmailDomains (string with allowEmpty, no validate hook) accepts empty unchanged", () => {
    const def = findDef("auth.allowedEmailDomains");
    expect(normalizeOrgConfigValue(def, "")).toBe("");
    expect(normalizeOrgConfigValue(def, "acme.com,partner.com")).toBe("acme.com,partner.com");
  });
});

describe("ORG_CONFIG_DEFINITIONS retention.* family", () => {
  it("catalogues exactly the five retention.* keys", () => {
    const retentionKeys = ORG_CONFIG_DEFINITIONS.filter((d) => d.key.startsWith("retention."))
      .map((d) => d.key)
      .sort();
    expect(retentionKeys).toEqual(
      [
        "retention.runEventsDays",
        "retention.auditLogsDays",
        "retention.usageEventsDays",
        "retention.recoveryFeedbackDays",
        "retention.memoryEntriesDays",
      ].sort(),
    );
  });

  it("registers every retention.* entry under the `retention` category as a number", () => {
    for (const def of ORG_CONFIG_DEFINITIONS) {
      if (def.key.startsWith("retention.")) {
        expect(def.category).toBe("retention");
        expect(def.valueType).toBe("number");
      }
    }
  });

  // [defaultValue, min, max] per the AC.
  const SPECS: Array<[string, number, number, number]> = [
    ["retention.runEventsDays", 90, 7, 365],
    ["retention.auditLogsDays", 365, 30, 730],
    ["retention.usageEventsDays", 90, 30, 365],
    ["retention.recoveryFeedbackDays", 180, 30, 365],
    ["retention.memoryEntriesDays", 90, 7, 730],
  ];

  it.each(SPECS)("%s declares default %d and range %d..%d", (key, def, min, max) => {
    const d = findDef(key);
    expect(d.defaultValue).toBe(def);
    expect(d.min).toBe(min);
    expect(d.max).toBe(max);
  });

  it.each(SPECS)("%s normalizes in-range, floors fractional, and rejects out-of-range", (key, _def, min, max) => {
    const d = findDef(key);
    expect(normalizeOrgConfigValue(d, min)).toBe(min);
    expect(normalizeOrgConfigValue(d, max)).toBe(max);
    // Day counts are integer keys (no `fractional`), so a fractional input floors.
    expect(normalizeOrgConfigValue(d, min + 0.9)).toBe(min);
    expect(() => normalizeOrgConfigValue(d, min - 1)).toThrow(new RegExp(`>= ${min}`));
    expect(() => normalizeOrgConfigValue(d, max + 1)).toThrow(new RegExp(`<= ${max}`));
  });
});

describe("normalizeOrgConfigValue — ai.surfaceModels JSON validator", () => {
  const def = findDef("ai.surfaceModels");

  it("defaults to empty string and allows empty / whitespace", () => {
    expect(def.defaultValue).toBe("");
    expect(normalizeOrgConfigValue(def, "")).toBe("");
    expect(normalizeOrgConfigValue(def, "   ")).toBe("");
  });

  it("accepts a valid map of known surfaces to model ids", () => {
    const json = JSON.stringify({
      "patch-workflow": "claude-sonnet-4-5",
      "suggest-improvement": "anthropic/claude-sonnet-4-5",
    });
    expect(normalizeOrgConfigValue(def, json)).toBe(json);
  });

  it("accepts an empty JSON object", () => {
    expect(normalizeOrgConfigValue(def, "{}")).toBe("{}");
  });

  it("rejects malformed JSON", () => {
    expect(() => normalizeOrgConfigValue(def, "{not-json}")).toThrow(/must be valid JSON/);
  });

  it("rejects a non-object JSON value", () => {
    expect(() => normalizeOrgConfigValue(def, '["generate-workflow"]')).toThrow(/must be a JSON object/);
    expect(() => normalizeOrgConfigValue(def, "null")).toThrow(/must be a JSON object/);
  });

  it("rejects an unknown surface key", () => {
    expect(() => normalizeOrgConfigValue(def, '{"evil-surface":"claude-haiku-4-5"}')).toThrow(/is not one of/);
  });

  it("rejects a non-string or empty model value", () => {
    expect(() => normalizeOrgConfigValue(def, '{"patch-workflow":123}')).toThrow(/must be a non-empty string/);
    expect(() => normalizeOrgConfigValue(def, '{"patch-workflow":""}')).toThrow(/must be a non-empty string/);
    expect(() => normalizeOrgConfigValue(def, '{"patch-workflow":"   "}')).toThrow(/must be a non-empty string/);
  });

  it("accepts every known surface slug", () => {
    const all = JSON.stringify({
      "generate-workflow": "claude-haiku-4-5",
      "explain-workflow": "claude-haiku-4-5",
      "review-workflow": "claude-sonnet-4-5",
      "patch-workflow": "claude-sonnet-4-5",
      "suggest-improvement": "claude-sonnet-4-5",
      "explain-run": "claude-haiku-4-5",
    });
    expect(normalizeOrgConfigValue(def, all)).toBe(all);
  });
});
