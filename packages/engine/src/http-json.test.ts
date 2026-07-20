import { describe, expect, it } from "vitest";

import { HTTP_JSON_PROJECTION_MAX_BYTES, isJsonMediaType, projectHttpJson } from "./http-json";

describe("HTTP JSON projection", () => {
  it.each([
    "application/json",
    "APPLICATION/JSON; Charset=UTF-8",
    "application/problem+json",
    "application/vnd.api+json; profile=example",
  ])("accepts the JSON media type %s", (value) => {
    expect(isJsonMediaType(value)).toBe(true);
  });

  it.each(["text/json", "text/plain", "application/javascript", "application/jsonp", undefined])(
    "rejects the non-JSON media type %s",
    (value) => expect(isJsonMediaType(value)).toBe(false),
  );

  it("parses JSON from a case-insensitive content-type header", () => {
    expect(projectHttpJson('{"customer":{"id":42}}', { "Content-Type": "application/json" })).toEqual({
      json: { customer: { id: 42 } },
    });
  });

  it("reports invalid declared JSON without exposing the parser message or body", () => {
    expect(projectHttpJson("secret body {", { "content-type": "application/problem+json" })).toEqual({
      jsonParseError: true,
    });
  });

  it("does not parse JSON-looking text without a JSON media type", () => {
    expect(projectHttpJson('{"id":1}', { "content-type": "text/plain" })).toEqual({});
  });

  it("keeps the automatic projection below the safe-persistence budget", () => {
    const atLimit = JSON.stringify("a".repeat(HTTP_JSON_PROJECTION_MAX_BYTES - 2));
    const overLimit = JSON.stringify("a".repeat(HTTP_JSON_PROJECTION_MAX_BYTES - 1));

    expect(projectHttpJson(atLimit, { "content-type": "application/json" })).toEqual({
      json: "a".repeat(HTTP_JSON_PROJECTION_MAX_BYTES - 2),
    });
    expect(projectHttpJson(overLimit, { "content-type": "application/json" })).toEqual({
      jsonParseSkipped: "body_too_large",
    });
  });

  it("measures the UTF-8 payload rather than JavaScript code units", () => {
    const multibyte = JSON.stringify("é".repeat(HTTP_JSON_PROJECTION_MAX_BYTES / 2));
    expect(projectHttpJson(multibyte, { "content-type": "application/json" })).toEqual({
      jsonParseSkipped: "body_too_large",
    });
  });
});
