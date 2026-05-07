/**
 * Back-compat re-export. The implementation lives in `@janusly/shared`
 * (zero runtime deps) so it can be imported from both the engine and the
 * web bundle. Consumers importing `@janusly/engine/src/error-signature`
 * keep working.
 */
export {
  FALLBACK_SIGNATURE_MAX_LENGTH,
  SECRET_VALUE_PATTERNS,
  normalizeErrorSignature,
  scrubSecretShapes,
} from "@janusly/shared/src/error-signature";
export type {
  ErrorCategory,
  ErrorContext,
  SignatureResult,
  SuggestedOwner,
} from "@janusly/shared/src/error-signature";
