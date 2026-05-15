/**
 * Pin the Accept-Language → ApiLocale mapping that AI routes use to
 * pick a locale for LLM prompts. Closed enum (`en` / `es`) with a
 * defensive `en` default mirrors the web's FALLBACK_LOCALE.
 */

import { describe, expect, it } from "vitest";

import { localeFromRequest } from "./locale";

function req(value: string | string[] | undefined): { headers: Record<string, string | string[] | undefined> } {
  return { headers: { "accept-language": value } };
}

describe("localeFromRequest", () => {
  it("returns 'en' when the header is missing", () => {
    expect(localeFromRequest({ headers: {} })).toBe("en");
    expect(localeFromRequest(req(undefined))).toBe("en");
  });

  it("returns the supported language for a bare tag", () => {
    expect(localeFromRequest(req("es"))).toBe("es");
    expect(localeFromRequest(req("en"))).toBe("en");
  });

  it("strips the region from a regional tag", () => {
    expect(localeFromRequest(req("es-MX"))).toBe("es");
    expect(localeFromRequest(req("en-US"))).toBe("en");
  });

  it("walks a comma-separated list and picks the first supported tag", () => {
    expect(localeFromRequest(req("fr-FR, es-ES, en-US"))).toBe("es");
    expect(localeFromRequest(req("de-DE, fr-FR, en"))).toBe("en");
  });

  it("ignores quality factors when selecting", () => {
    // The header sender's order is enough for `en|es` — q-values are
    // dropped by `split(';')[0]` before the supported-tag check runs.
    expect(localeFromRequest(req("es;q=0.9, en;q=0.8"))).toBe("es");
  });

  it("falls back to 'en' for unsupported languages", () => {
    expect(localeFromRequest(req("fr-FR"))).toBe("en");
    expect(localeFromRequest(req("ja-JP, ko-KR"))).toBe("en");
  });

  it("treats array values as a comma-separated header (Node.js shape)", () => {
    expect(localeFromRequest(req(["es-MX", "en"]))).toBe("es");
    expect(localeFromRequest(req(["fr-FR", "es-MX"]))).toBe("es");
  });

  it("is case-insensitive", () => {
    expect(localeFromRequest(req("ES"))).toBe("es");
    expect(localeFromRequest(req("EN-Us"))).toBe("en");
  });
});
