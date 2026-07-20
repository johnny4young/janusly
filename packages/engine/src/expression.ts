/**
 * Engine compatibility shim for the canonical zero-dependency expression
 * parser. The implementation lives in `@janusly/shared` so the Inspector can
 * validate authoring input with the exact runtime grammar.
 *
 * Used by engine executors, workflow validation, and existing engine tests.
 */

export {
  evaluateExpression,
  validateExpression,
} from '@janusly/shared/src/expression'
