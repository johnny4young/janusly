/** Ambient types for Vite's virtual catalog modules. */

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
