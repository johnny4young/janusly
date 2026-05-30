/**
 * Pure-unit tests for the upstream-health feed parsers + status mapping.
 *
 * Covers the upstream-health awareness acceptance cases:
 *   - statuspage.io component JSON parsing → derived status
 *   - the page-level indicator (status.json) path
 *   - missing-component handling → fail-open (`ok: false`)
 *   - the degraded-status classification (degraded / partial / major are pause
 *     triggers; operational / maintenance / unknown are NOT)
 *   - custom_feed + http_probe parsing
 *   - config Zod schema bounds (interval clamp, name regex)
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_CHECK_INTERVAL_SECONDS,
  MAX_CHECK_INTERVAL_SECONDS,
  MIN_CHECK_INTERVAL_SECONDS,
  UpstreamHealthSourceConfigSchema,
  isDegradedStatus,
  mapStatuspageStatus,
  parseCustomFeed,
  parseHttpProbe,
  parseStatuspageFeed,
  parseUpstreamFeed,
} from "./upstream-health";

describe("mapStatuspageStatus", () => {
  it("maps Statuspage component-status strings", () => {
    expect(mapStatuspageStatus("operational")).toBe("operational");
    expect(mapStatuspageStatus("degraded_performance")).toBe("degraded_performance");
    expect(mapStatuspageStatus("partial_outage")).toBe("partial_outage");
    expect(mapStatuspageStatus("major_outage")).toBe("major_outage");
    expect(mapStatuspageStatus("under_maintenance")).toBe("under_maintenance");
  });

  it("maps top-level indicator values (none/minor/major/critical)", () => {
    expect(mapStatuspageStatus("none")).toBe("operational");
    expect(mapStatuspageStatus("minor")).toBe("degraded_performance");
    expect(mapStatuspageStatus("major")).toBe("major_outage");
    expect(mapStatuspageStatus("critical")).toBe("major_outage");
  });

  it("returns unknown for unrecognised / non-string values (fail-open path)", () => {
    expect(mapStatuspageStatus("banana")).toBe("unknown");
    expect(mapStatuspageStatus(42)).toBe("unknown");
    expect(mapStatuspageStatus(null)).toBe("unknown");
    expect(mapStatuspageStatus(undefined)).toBe("unknown");
  });
});

describe("isDegradedStatus", () => {
  it("treats degraded / partial / major as pause triggers", () => {
    expect(isDegradedStatus("degraded_performance")).toBe(true);
    expect(isDegradedStatus("partial_outage")).toBe(true);
    expect(isDegradedStatus("major_outage")).toBe(true);
  });
  it("treats operational / maintenance / unknown as NOT pause triggers", () => {
    expect(isDegradedStatus("operational")).toBe(false);
    expect(isDegradedStatus("under_maintenance")).toBe(false);
    expect(isDegradedStatus("unknown")).toBe(false);
  });
});

describe("parseStatuspageFeed — component scoped", () => {
  const componentsJson = {
    components: [
      { id: "a", name: "API", status: "operational" },
      { id: "b", name: "Dashboard", status: "degraded_performance" },
      { id: "c", name: "Webhooks", status: "major_outage" },
    ],
  };

  it("derives operational when every watched component is operational", () => {
    const result = parseStatuspageFeed(componentsJson, ["API"]);
    expect(result).toEqual({
      ok: true,
      status: "operational",
      degraded: false,
      components: [{ name: "API", status: "operational" }],
    });
  });

  it("rolls multiple watched components up to the WORST status", () => {
    const result = parseStatuspageFeed(componentsJson, ["API", "Dashboard"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("degraded_performance");
      expect(result.degraded).toBe(true);
    }
  });

  it("flags major_outage as degraded", () => {
    const result = parseStatuspageFeed(componentsJson, ["Webhooks"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("major_outage");
      expect(result.degraded).toBe(true);
    }
  });

  it("matches component names case-insensitively", () => {
    const result = parseStatuspageFeed(componentsJson, ["api", "DASHBOARD"]);
    expect(result.ok).toBe(true);
  });

  it("FAILS OPEN (component_not_found) when a watched component is missing", () => {
    const result = parseStatuspageFeed(componentsJson, ["NonExistentService"]);
    expect(result).toEqual({ ok: false, reason: "component_not_found" });
  });

  it("FAILS OPEN (unparseable) when the components array is missing", () => {
    const result = parseStatuspageFeed({ foo: "bar" }, ["API"]);
    expect(result).toEqual({ ok: false, reason: "unparseable" });
  });

  it("FAILS OPEN (unparseable) on a non-object body", () => {
    expect(parseStatuspageFeed(null, ["API"])).toEqual({ ok: false, reason: "unparseable" });
    expect(parseStatuspageFeed("not json", ["API"])).toEqual({ ok: false, reason: "unparseable" });
  });
});

describe("parseStatuspageFeed — page-level indicator", () => {
  it("uses status.indicator when no components are declared", () => {
    const result = parseStatuspageFeed({ status: { indicator: "major", description: "down" } }, []);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("major_outage");
      expect(result.degraded).toBe(true);
      expect(result.components).toEqual([]);
    }
  });

  it("derives operational from indicator 'none'", () => {
    const result = parseStatuspageFeed({ status: { indicator: "none" } }, []);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.degraded).toBe(false);
  });

  it("FAILS OPEN (no_status) when neither components nor an indicator are present", () => {
    expect(parseStatuspageFeed({ page: {} }, [])).toEqual({ ok: false, reason: "no_status" });
  });
});

describe("parseCustomFeed", () => {
  it("reads a top-level status string", () => {
    const result = parseCustomFeed({ status: "degraded_performance" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.degraded).toBe(true);
  });
  it("FAILS OPEN when status is missing", () => {
    expect(parseCustomFeed({ foo: 1 })).toEqual({ ok: false, reason: "no_status" });
  });
  it("FAILS OPEN when status is unrecognised", () => {
    expect(parseCustomFeed({ status: "wat" })).toEqual({ ok: false, reason: "no_status" });
  });
});

describe("parseHttpProbe", () => {
  it("2xx → operational (healthy)", () => {
    expect(parseHttpProbe(200)).toEqual({ ok: true, status: "operational", degraded: false, components: [] });
    expect(parseHttpProbe(204)).toEqual({ ok: true, status: "operational", degraded: false, components: [] });
  });
  it("non-2xx → major_outage (degraded)", () => {
    expect(parseHttpProbe(503)).toEqual({ ok: true, status: "major_outage", degraded: true, components: [] });
    expect(parseHttpProbe(0)).toEqual({ ok: true, status: "major_outage", degraded: true, components: [] });
  });
});

describe("parseUpstreamFeed dispatch", () => {
  it("routes statuspage_io + atlassian_statuspage to the statuspage parser", () => {
    const json = { status: { indicator: "minor" } };
    expect(parseUpstreamFeed({ kind: "statuspage_io", expectedComponents: [], json }).ok).toBe(true);
    expect(parseUpstreamFeed({ kind: "atlassian_statuspage", expectedComponents: [], json }).ok).toBe(true);
  });
  it("routes custom_feed to the custom parser", () => {
    expect(parseUpstreamFeed({ kind: "custom_feed", expectedComponents: [], json: { status: "operational" } }).ok).toBe(true);
  });
  it("routes http_probe to the probe parser", () => {
    expect(parseUpstreamFeed({ kind: "http_probe", expectedComponents: [], statusCode: 200 }).ok).toBe(true);
  });
});

describe("UpstreamHealthSourceConfigSchema", () => {
  const valid = {
    name: "stripe-prod",
    kind: "statuspage_io" as const,
    url: "https://status.stripe.com/api/v2/status.json",
  };

  it("applies defaults for interval / components / enabled", () => {
    const parsed = UpstreamHealthSourceConfigSchema.parse(valid);
    expect(parsed.checkIntervalSeconds).toBe(DEFAULT_CHECK_INTERVAL_SECONDS);
    expect(parsed.expectedComponents).toEqual([]);
    expect(parsed.enabled).toBe(true);
  });

  it("rejects an out-of-range interval", () => {
    expect(UpstreamHealthSourceConfigSchema.safeParse({ ...valid, checkIntervalSeconds: MIN_CHECK_INTERVAL_SECONDS - 1 }).success).toBe(false);
    expect(UpstreamHealthSourceConfigSchema.safeParse({ ...valid, checkIntervalSeconds: MAX_CHECK_INTERVAL_SECONDS + 1 }).success).toBe(false);
  });

  it("rejects a non-http(s) url", () => {
    expect(UpstreamHealthSourceConfigSchema.safeParse({ ...valid, url: "ftp://status.stripe.com" }).success).toBe(false);
  });

  it("rejects a name with leading punctuation", () => {
    expect(UpstreamHealthSourceConfigSchema.safeParse({ ...valid, name: "-bad" }).success).toBe(false);
  });
});
