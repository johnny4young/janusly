/** The HTML shell is no-cache; hashed JS assets can remain identical across builds. */
export function readBuildId(): string {
  return document.documentElement.dataset.buildId || 'dev'
}
