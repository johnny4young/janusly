/**
 * Composition point for the AI mutation surfaces. Each route now lives in
 * its own per-route(-group) module (split out to keep per-session context
 * small); this file just re-composes them into the single `aiRoutes`
 * registry `apps/api/src/index.ts` spreads.
 *
 * The order below is load-bearing: the API dispatcher is first-match-wins,
 * so it preserves the original ordering (health, generate, explain-workflow,
 * review, patch, improve, explain-run).
 *
 * Every module upholds the AI-fallback contract (wrap the LLM call in
 * try/catch, degrade to `{ mode: "fallback", aiError, ... }` on any failure)
 * and the AGENTS.md AI-mutation audit invariant: review / patch /
 * suggest-improvement audit on BOTH ai-mode and fallback; generate /
 * explain-workflow / explain-run audit their fallback paths too so AI
 * outages stay visible in the audit trail.
 */
import { aiHealthRoutes } from "./ai-health-route";
import { aiGenerateRoutes } from "./ai-generate-route";
import { aiExplainRoutes } from "./ai-explain-route";
import { aiReviewRoutes } from "./ai-review-route";
import { aiPatchRoutes } from "./ai-patch-route";
import { aiImproveRoutes } from "./ai-improve-route";
import type { Route } from "../routes";

export const aiRoutes: Route[] = [
  ...aiHealthRoutes,
  ...aiGenerateRoutes,
  ...aiExplainRoutes,
  ...aiReviewRoutes,
  ...aiPatchRoutes,
  ...aiImproveRoutes,
];
