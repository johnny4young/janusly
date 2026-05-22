/**
 * `@janusly/shared` barrel — re-exports contracts and zero-I/O helpers so
 * every workspace can import stable primitives from "@janusly/shared"
 * without reaching into internal files.
 *
 * Used by: every workspace that touches workflow JSON (api, engine, ai, web,
 * data). This package is intentionally tiny and has zero runtime dependencies,
 * so it can be imported from any layer including the browser bundle.
 */

export * from './workflow'
export * from './workflow-slo'
export * from './status'
export * from './iso-duration'
export * from './prompt-variables'
export * from './alert-policy'
export * from './alert-pattern'
export * from './alert-message'
