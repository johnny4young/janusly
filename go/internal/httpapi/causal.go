// GET /causal (T-520; reference run-routes/diagnostics.ts): the
// deterministic decision explorer — replays a recorded decision.made
// event's ranking under current preferences. No LLM; always available.
package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/auth"
	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/store"
)

// decisionCandidatesFromPayload mirrors the reference parser: rows come
// from payload.ranking, keyed by breakdown.{cost,latency,quality};
// rows without a nodeId are dropped.
func decisionCandidatesFromPayload(payload []byte) (candidates []domain.DecisionCandidate, chosenNodeID string) {
	var envelope struct {
		ChosenNodeID string `json:"chosenNodeId"`
		Ranking      []struct {
			NodeID    string `json:"nodeId"`
			Breakdown struct {
				Cost    float64 `json:"cost"`
				Latency float64 `json:"latency"`
				Quality float64 `json:"quality"`
			} `json:"breakdown"`
		} `json:"ranking"`
	}
	_ = json.Unmarshal(payload, &envelope)
	for _, item := range envelope.Ranking {
		if item.NodeID == "" {
			continue
		}
		candidates = append(candidates, domain.DecisionCandidate{
			NodeID: item.NodeID, AvgCost: item.Breakdown.Cost,
			AvgLatencyMs: item.Breakdown.Latency, SuccessRate: item.Breakdown.Quality,
		})
	}
	return candidates, envelope.ChosenNodeID
}

func (s *V1Server) causalCore(r *http.Request, rc v1Request) opResult {
	query := r.URL.Query()
	runID, eventID, nodeID := query.Get("runId"), query.Get("eventId"), query.Get("nodeId")
	if runID == "" || eventID == "" || nodeID == "" {
		return opError(http.StatusBadRequest, "runs_run_id_event_id_and_node_id_required",
			"runId, eventId, and nodeId are required", nil)
	}
	ctx := r.Context()
	q := store.New(s.pool)
	if _, err := q.GetRun(ctx, store.GetRunParams{ID: runID, OrgID: rc.orgID}); err != nil {
		return opError(http.StatusForbidden, "runs_forbidden", "Forbidden", nil)
	}
	event, err := q.GetDecisionEvent(ctx, store.GetDecisionEventParams{
		ID: eventID, RunID: runID,
		NodeID: pgtype.Text{String: nodeID, Valid: true},
	})
	if err != nil {
		return opError(http.StatusNotFound, "runs_no_decision_event", "No decision event", nil)
	}
	candidates, chosenNodeID := decisionCandidatesFromPayload(event.Payload)
	result := domain.ReplayDecision(domain.DecisionReplayInput{
		ChosenNodeID: chosenNodeID, Candidates: candidates, Strategy: "auto",
	})
	raw, err := json.Marshal(result)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	var envelope map[string]any
	_ = json.Unmarshal(raw, &envelope)
	return opOK(envelope)
}

func (s *V1Server) mountCausalRoutes(mux *http.ServeMux) {
	s.route(mux, "GET /causal", routeGate{auth.RoleViewer, "runs.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.causalCore(r, rc))
	})
}
