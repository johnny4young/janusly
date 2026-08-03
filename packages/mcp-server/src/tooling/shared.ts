/** Pure helpers shared by MCP route translators and argument validators. */

const V1_PREFIX = "/v1";

export function v1(path: string): string {
  return `${V1_PREFIX}${path}`;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
