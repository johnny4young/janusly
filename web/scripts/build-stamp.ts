const HTML_ROOT = '<html lang="en">'
const SAFE_BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Keep per-build metadata in the no-cache HTML shell, not hashed JS chunks. */
export function injectBuildStamp(html: string, buildId: string): string {
  if (!SAFE_BUILD_ID.test(buildId)) throw new Error('Invalid build ID')
  if (!html.includes(HTML_ROOT)) throw new Error('Missing HTML root for build ID')
  return html.replace(HTML_ROOT, `<html lang="en" data-build-id="${buildId}">`)
}
