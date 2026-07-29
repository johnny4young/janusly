/**
 * Compile-time constants injected by Vite's `define` (see `vite.config.ts`).
 */

/** Build stamp `<date>-<short-sha>`, or `"dev"` outside a git checkout. */
declare const __BUILD_ID__: string

declare module '*?janusly-catalog=keys&janusly-namespace=core' {
  const keys: string
  export default keys
}

declare module '*?janusly-catalog=keys&janusly-namespace=workspace' {
  const keys: string
  export default keys
}

declare module '*?janusly-catalog=values&janusly-namespace=core' {
  const values: string
  export default values
}

declare module '*?janusly-catalog=values&janusly-namespace=workspace' {
  const values: string
  export default values
}
