/**
 * Tests for the recovery circuit breaker's pure decision layer (* containment slice). The mechanism is destructive — a tripped breaker stops a
 * workflow from accepting work — so this matrix pins BOTH directions: what
 * must trip, and everything that must not.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  MAX_CIRCUIT_BREAKER_THRESHOLD,
  isCircuitBreakerEnabled,
  readWorkflowCircuitBreaker,
  resolveCircuitBreakerThreshold,
  shouldTripCircuitBreaker,
} from "./circuit-breaker";

describe("resolveCircuitBreakerThreshold", () => {
  it("prefers the workflow knob, then the org default, then the built-in", () => {
    expect(resolveCircuitBreakerThreshold({ workflowThreshold: 3, orgThreshold: 10, enabled: true })).toBe(3);
    expect(resolveCircuitBreakerThreshold({ orgThreshold: 10, enabled: true })).toBe(10);
    expect(resolveCircuitBreakerThreshold({ enabled: true })).toBe(DEFAULT_CIRCUIT_BREAKER_THRESHOLD);
  });

  it("lets a workflow opt out entirely — some pipelines are meant to fail loudly", () => {
    expect(resolveCircuitBreakerThreshold({ workflowThreshold: false, orgThreshold: 5, enabled: true })).toBeNull();
  });

  it("treats a sub-2 threshold as an opt-out rather than a hair trigger", () => {
    // 1 would trip on a single blip — that's not a breaker, that's an outage.
    expect(resolveCircuitBreakerThreshold({ workflowThreshold: 1, enabled: true })).toBeNull();
    expect(resolveCircuitBreakerThreshold({ workflowThreshold: 0, enabled: true })).toBeNull();
    expect(resolveCircuitBreakerThreshold({ workflowThreshold: -3, enabled: true })).toBeNull();
  });

  it("caps an absurd threshold and floors a fractional one", () => {
    expect(resolveCircuitBreakerThreshold({ workflowThreshold: 5_000, enabled: true })).toBe(MAX_CIRCUIT_BREAKER_THRESHOLD);
    expect(resolveCircuitBreakerThreshold({ workflowThreshold: 3.9, enabled: true })).toBe(3);
  });

  it("falls back to the default for a non-finite value instead of throwing", () => {
    expect(resolveCircuitBreakerThreshold({ workflowThreshold: Number.NaN, enabled: true })).toBe(DEFAULT_CIRCUIT_BREAKER_THRESHOLD);
  });

  it("returns null when the tier is disabled", () => {
    expect(resolveCircuitBreakerThreshold({ workflowThreshold: 3, enabled: false })).toBeNull();
  });
});

describe("shouldTripCircuitBreaker", () => {
  it("trips exactly at the threshold, not before", () => {
    expect(shouldTripCircuitBreaker({ consecutiveFailures: 4, threshold: 5, workflowStatus: "active" })).toBe(false);
    expect(shouldTripCircuitBreaker({ consecutiveFailures: 5, threshold: 5, workflowStatus: "active" })).toBe(true);
    expect(shouldTripCircuitBreaker({ consecutiveFailures: 9, threshold: 5, workflowStatus: "active" })).toBe(true);
  });

  it("never trips a workflow that isn't active", () => {
    // Already paused (by the breaker or upstream-health) or tombstoned —
    // re-pausing would clobber the existing reason.
    for (const status of ["paused_circuit_breaker", "paused_upstream_degraded", "archived"]) {
      expect(shouldTripCircuitBreaker({ consecutiveFailures: 99, threshold: 5, workflowStatus: status })).toBe(false);
    }
  });

  it("never trips when the workflow opted out", () => {
    expect(shouldTripCircuitBreaker({ consecutiveFailures: 99, threshold: null, workflowStatus: "active" })).toBe(false);
  });
});

describe("readWorkflowCircuitBreaker", () => {
  it("reads both the shorthand number and the object form", () => {
    expect(readWorkflowCircuitBreaker({ recovery: { circuitBreaker: 3 } })).toBe(3);
    expect(readWorkflowCircuitBreaker({ recovery: { circuitBreaker: { consecutiveFailures: 7 } } })).toBe(7);
  });

  it("reads the opt-out in both forms", () => {
    expect(readWorkflowCircuitBreaker({ recovery: { circuitBreaker: false } })).toBe(false);
    expect(readWorkflowCircuitBreaker({ recovery: { circuitBreaker: { consecutiveFailures: false } } })).toBe(false);
  });

  it("reads absent / malformed config as undefined (org default applies)", () => {
    expect(readWorkflowCircuitBreaker(undefined)).toBeUndefined();
    expect(readWorkflowCircuitBreaker(null)).toBeUndefined();
    expect(readWorkflowCircuitBreaker({})).toBeUndefined();
    expect(readWorkflowCircuitBreaker({ recovery: null })).toBeUndefined();
    expect(readWorkflowCircuitBreaker({ recovery: { circuitBreaker: "five" } })).toBeUndefined();
    expect(readWorkflowCircuitBreaker({ recovery: [] })).toBeUndefined();
    expect(readWorkflowCircuitBreaker([{ recovery: { circuitBreaker: 3 } }])).toBeUndefined();
  });
});

describe("isCircuitBreakerEnabled", () => {
  it("defaults ON and opts out only on the explicit string 'false'", () => {
    expect(isCircuitBreakerEnabled({})).toBe(true);
    expect(isCircuitBreakerEnabled({ JANUSLY_CIRCUIT_BREAKER_ENABLED: "false" })).toBe(false);
  });
});

describe("resolveCircuitBreakerThreshold — org tier", () => {
  // Regression: the adapter passed `orgThreshold: null` unconditionally, so
  // this tier resolved but was never actually reachable in production.
  it("uses the org default when the workflow says nothing", () => {
    expect(resolveCircuitBreakerThreshold({ orgThreshold: 12, enabled: true })).toBe(12);
  });

  it("lets a per-workflow knob beat the org default", () => {
    expect(resolveCircuitBreakerThreshold({ workflowThreshold: 3, orgThreshold: 12, enabled: true })).toBe(3);
  });

  it("lets a workflow opt out even when the org sets a default", () => {
    expect(resolveCircuitBreakerThreshold({ workflowThreshold: false, orgThreshold: 12, enabled: true })).toBeNull();
  });

  it("falls back to the built-in default when neither tier says anything", () => {
    expect(resolveCircuitBreakerThreshold({ orgThreshold: null, enabled: true })).toBe(DEFAULT_CIRCUIT_BREAKER_THRESHOLD);
  });

  it("stays off when the kill switch is off, whatever the tiers say", () => {
    expect(resolveCircuitBreakerThreshold({ workflowThreshold: 3, orgThreshold: 12, enabled: false })).toBeNull();
  });
});
