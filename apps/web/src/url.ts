/**
 * Shared URL guards for the web layer.
 *
 * `isLikelyHttpUrl` flags a value that does NOT parse as an absolute http(s)
 * URL — used for inline form validation before a round-trip. It is a UX hint,
 * not a security boundary: the engine SSRF policy is the authoritative
 * server-side check on any outbound target.
 *
 * Trims before parsing so the guard is self-contained — a call site that
 * forgets to pre-trim (e.g. a pasted value with leading/trailing whitespace)
 * still gets the right answer.
 *
 * Used by the MCP-connection + report-delivery forms.
 */
export function isLikelyHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
