/**
 * Engine compatibility re-export for the shared ISO duration parser.
 *
 * Used by `tool-registry.ts` (`time.add`) and `wait-until.ts`. The parser
 * lives in `@janusly/shared` so AI promotion and engine validation use the
 * same grammar.
 */

export { ISO_DURATION_PATTERN, parseIsoDuration } from "@janusly/shared";
