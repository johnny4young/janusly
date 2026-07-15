/**
 * Pure helpers for the additive JSON projection exposed by buffered HTTP
 * executors. A response is parsed only when its media type explicitly opts
 * into JSON (`application/json` or an `application/*+json` structured suffix).
 *
 * Used by: the `http` node and `http.request` tool.
 */

import { Buffer } from "node:buffer";

export type HttpJsonProjection = {
  json?: unknown;
  /** Present only when the upstream declared JSON but returned invalid JSON. */
  jsonParseError?: true;
  /** Present when parsing was intentionally skipped to keep persisted output bounded. */
  jsonParseSkipped?: "body_too_large";
};

/**
 * Keep `body` plus its parsed projection comfortably below the default
 * 256 KiB safe-persistence cap. Larger JSON can still be parsed explicitly by
 * a downstream `json.parse` node without duplicating it inside one node state.
 */
export const HTTP_JSON_PROJECTION_MAX_BYTES = 64 * 1024;

function contentType(headers: Record<string, string>): string | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type");
  return entry?.[1];
}

/** True only for the registered JSON media type or an application `+json` suffix. */
export function isJsonMediaType(value: string | undefined): boolean {
  if (!value) return false;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json"
    || Boolean(mediaType?.startsWith("application/") && mediaType.endsWith("+json"));
}

/**
 * Build the optional JSON fields for an HTTP output without changing its
 * existing `body: string` contract. Invalid declared JSON is observable but
 * does not turn an otherwise successful request into a failed node.
 */
export function projectHttpJson(body: string, headers: Record<string, string>): HttpJsonProjection {
  if (!isJsonMediaType(contentType(headers))) return {};
  if (Buffer.byteLength(body, "utf8") > HTTP_JSON_PROJECTION_MAX_BYTES) {
    return { jsonParseSkipped: "body_too_large" };
  }
  try {
    return { json: JSON.parse(body) as unknown };
  } catch {
    return { jsonParseError: true };
  }
}
