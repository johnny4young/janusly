/**
 * Shared URL guards for the web layer.
 *
 * `isLikelyHttpUrl` flags a value that does NOT parse as an absolute http(s)
 * URL — used for inline form validation before a round-trip. It is a UX hint,
 * not a security boundary: the engine SSRF policy is the authoritative
 * server-side check on any outbound target.
 *
 * Used by the MCP-connection + report-delivery forms.
 */
export function isLikelyHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
