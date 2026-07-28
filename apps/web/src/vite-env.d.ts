/**
 * Compile-time constants injected by Vite's `define` (see `vite.config.ts`).
 */

/** Build stamp `<date>-<short-sha>`, or `"dev"` outside a git checkout. */
declare const __BUILD_ID__: string

declare module '*?janusly-catalog=keys' {
  const keys: readonly string[]
  export default keys
}

declare module '*?janusly-catalog=values' {
  const values: readonly string[]
  export default values
}
