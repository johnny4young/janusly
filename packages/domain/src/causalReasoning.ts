/**
 * Causal-reasoning replay — given a recorded decision (the chosen candidate +
 * the alternatives), recomputes scores under the current preferences so the
 * UI can show "why this won" without re-running the original LLM call.
 *
 * Pure logic, no I/O. Used by `apps/api/src/index.ts` for the decision
 * explorer that backs the AI Studio's per-step inspector.
 */

import { scoreCandidate, type DecisionCandidate, type DecisionPreferences } from "./decisionEngine";

export type DecisionReplayInput = {
  chosenNodeId?: string;
  candidates: DecisionCandidate[];
  preferences?: DecisionPreferences;
  strategy?: "auto" | "cheapest" | "fastest" | "balanced";
};

export function replayDecision(input: DecisionReplayInput) {
  let ranking = input.candidates.map((candidate) => scoreCandidate(candidate, input.preferences));

  if (input.strategy === "cheapest") ranking = ranking.sort((a, b) => a.breakdown.cost - b.breakdown.cost);
  else if (input.strategy === "fastest") ranking = ranking.sort((a, b) => a.breakdown.latency - b.breakdown.latency);
  else ranking = ranking.sort((a, b) => a.score - b.score);

  const chosen = ranking.find((item) => item.nodeId === input.chosenNodeId) ?? ranking[0];
  const best = ranking[0];

  const alternatives = ranking
    .filter((item) => item.nodeId !== chosen?.nodeId)
    .map((item) => ({
      nodeId: item.nodeId,
      scoreDelta: item.score - (chosen?.score ?? 0),
      costDelta: item.breakdown.cost - (chosen?.breakdown.cost ?? 0),
      latencyDelta: item.breakdown.latency - (chosen?.breakdown.latency ?? 0),
      qualityDelta: item.breakdown.quality - (chosen?.breakdown.quality ?? 0),
      breakdown: item.breakdown,
    }));

  return {
    chosen,
    best,
    ranking,
    alternatives,
    explanation: chosen
      ? `Chosen ${chosen.nodeId} because it ranked with score=${chosen.score}. Best replay candidate is ${best?.nodeId}.`
      : "No candidate could be replayed.",
  };
}
