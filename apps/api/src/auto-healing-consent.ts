/**
 * Thin re-export of the engine-side consent helpers so api routes
 * import from `apps/api` instead of reaching into `packages/engine`
 * directly. Matches the `apps/api/src/mcp-consent.ts` precedent where
 * consent helpers live close to the route layer.
 *
 * The actual gate logic lives in
 * `packages/engine/src/auto-healing-consent.ts` because the engine-side
 * scanner is the primary caller; routes are secondary.
 */

export {
  isAutoApplyAllowed,
  isAutoHealingAllowed,
  type AutoHealingConsentResult,
} from "@janusly/engine/src/auto-healing-consent";
