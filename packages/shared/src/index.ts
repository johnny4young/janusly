/**
 * `@janusly/shared` barrel — re-exports the workflow contract module so that
 * every workspace can `import { WorkflowSchema, NodeType, ... } from
 * "@janusly/shared"` without reaching into `./workflow`.
 *
 * Used by: every workspace that touches workflow JSON (api, engine, ai, web,
 * data). This package is intentionally tiny — it only owns the schemas, with
 * zero runtime dependencies, so it can be imported from any layer including
 * the browser bundle.
 */

export * from './workflow'
export * from './status'
