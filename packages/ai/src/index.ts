/**
 * `@janusly/ai` barrel — re-exports the run explainer.
 *
 * Used by `apps/api/src/index.ts` (`/ai/explain-run` route). Kept tiny on
 * purpose; ENG-011 will expand this with provider-neutral primitives once
 * the Vercel AI SDK migration lands.
 */

export * from "./runExplainer";
