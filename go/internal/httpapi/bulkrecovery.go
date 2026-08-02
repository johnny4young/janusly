// Bulk DLQ recovery — the multi-select surfaces over the cluster
// substrate: GET /dlq/cluster-members (the bounded id list whose
// normalized signature matches a claimed cluster), POST /dlq/cluster-apply
// (replay up to 100 same-signature rows in series, each RE-validated
// server-side against the claimed signature so a stale member list can't
// sneak through), POST /dlq/bulk-replay (mixed-batch retry, no signature
// required), and POST /dlq/resolve + /dlq/bulk-resolve (accept the loss;
// the linked recovery item closes honestly as accepted_loss). Every loop
// returns the 200 partial-success envelope — one bad row never aborts
// the batch.
package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/aiconfig"
	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/engine"
	"github.com/johnny4young/janusly/go/internal/ratelimit"
	"github.com/johnny4young/janusly/go/internal/signature"
	"github.com/johnny4young/janusly/go/internal/store"
)

// clusterMembersMaxLimit caps the member list AND the bulk-apply request,
// so a single request can never replay more than this.
const clusterMembersMaxLimit = 100

func (s *V1Server) clusterMembersCore(r *http.Request, rc v1Request) opResult {
	sig := r.URL.Query().Get("signature")
	if sig == "" {
		return opError(http.StatusBadRequest, "dlq_field_required", "signature is required",
			map[string]any{"field": "signature"})
	}
	windowDays := 30
	if raw := r.URL.Query().Get("windowDays"); raw != "" {
		if n, err := parsePositiveInt(raw, 90); err == nil {
			windowDays = n
		}
	}
	limit := clusterMembersMaxLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := parsePositiveInt(raw, clusterMembersMaxLimit); err == nil {
			limit = n
		}
	}
	since := time.Now().UTC().AddDate(0, 0, -windowDays)
	rows, err := store.New(s.pool).ListOpenDeadLetterClusterMembers(r.Context(),
		store.ListOpenDeadLetterClusterMembersParams{OrgID: rc.orgID, CreatedAt: &since})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	matched := make([]string, 0, limit)
	total := 0
	for _, row := range rows {
		sample := signature.FailureSample{
			Source: "dead_letter", ID: row.ID, RunID: row.RunID, NodeID: row.NodeID,
			ErrorJSON: row.ErrorJson,
		}
		enrichSampleFromRunInput(&sample, row.InputJson)
		result := signature.NormalizeJSON(sample.ErrorJSON, signature.Context{
			NodeType: sample.NodeType, NodeID: sample.NodeID, ToolName: sample.ToolName,
		})
		if result.Signature != sig {
			continue
		}
		total++
		if len(matched) < limit {
			matched = append(matched, row.ID)
		}
	}
	return opOK(map[string]any{
		"deadLetterIds": matched, "total": total, "capped": total > limit, "windowDays": windowDays,
	})
}

// recheckDeadLetterSignature re-normalizes one DLQ row's error and
// asserts it still matches the claimed cluster — the stale-member-list
// defense the reference applies per row at apply time.
func recheckDeadLetterSignature(item store.GetDeadLetterRow, claimed string) bool {
	var node struct {
		Type   string         `json:"type"`
		Config map[string]any `json:"config"`
	}
	_ = json.Unmarshal(item.NodeJson, &node)
	nodeType := node.Type
	if nodeType == "" {
		nodeType = "node"
	}
	toolName, _ := node.Config["tool"].(string)
	result := signature.NormalizeJSON(item.ErrorJson, signature.Context{
		NodeType: nodeType, NodeID: item.NodeID, ToolName: toolName,
	})
	return result.Signature == claimed
}

// fixAppliesToMember: a cluster spans workflows (it groups by failure
// signature), so the representative fix applies ONLY to members of the
// SAME workflow whose failing node survives the patch.
func fixAppliesToMember(fix *domain.Workflow, memberWorkflowJSON []byte, failingNodeID string) bool {
	if fix == nil || fix.ID == "" {
		return false
	}
	var wf struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(memberWorkflowJSON, &wf)
	if wf.ID != fix.ID {
		return false
	}
	for _, node := range fix.Nodes {
		if node.ID == failingNodeID {
			return true
		}
	}
	return false
}

// dismissLinkedRecoveryItem closes the incident behind a manually
// resolved DLQ row as accepted_loss (dismiss is NOT a replay — the
// resolution reason stays honest). No-op without an item; never fails
// the caller.
func (s *V1Server) dismissLinkedRecoveryItem(ctx context.Context, rc v1Request, deadLetterID string) {
	q := store.New(s.pool)
	item, err := q.GetRecoveryItemForDeadLetter(ctx, store.GetRecoveryItemForDeadLetterParams{
		OrgID: rc.orgID, DeadLetterID: deadLetterID,
	})
	if err != nil || item.Status == "resolved" {
		return
	}
	moved, err := q.TransitionRecoveryItem(ctx, store.TransitionRecoveryItemParams{
		OrgID: rc.orgID, ID: item.ID, ToStatus: "resolved",
		ResolutionReason: pgtype.Text{String: "accepted_loss", Valid: true},
		Actor:            pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		FromStatuses:     []string{"open", "acknowledged", "in_progress", "waiting_external", "reopened"},
	})
	if err != nil || moved == 0 {
		return
	}
	audit.Write(ctx, s.pool, rc.authContext, "recovery.item.resolved", audit.Options{
		TargetType: "recovery-item", TargetID: item.ID,
		Metadata: map[string]any{"via": "dlq_resolve", "resolutionReason": "accepted_loss"},
	})
}

func (s *V1Server) resolveDeadLetterCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		ID string `json:"id"`
	}
	if err := decodeBody(r, &body); err != nil || body.ID == "" {
		return opError(http.StatusBadRequest, "dlq_field_required", "id is required",
			map[string]any{"field": "id"})
	}
	if _, err := store.New(s.pool).MarkDeadLetterResolved(r.Context(), store.MarkDeadLetterResolvedParams{
		OrgID: rc.orgID, ID: body.ID,
	}); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "dlq.resolved", audit.Options{
		TargetType: "dlq", TargetID: body.ID,
	})
	s.dismissLinkedRecoveryItem(r.Context(), rc, body.ID)
	return opOK(map[string]any{"ok": true})
}

// readBulkDeadLetterIDs validates the shared deadLetterIds body contract.
func readBulkDeadLetterIDs(raw []any, present bool) ([]string, *opResult) {
	if !present || len(raw) == 0 {
		res := opError(http.StatusBadRequest, "dlq_ids_required",
			"deadLetterIds is required and must be a non-empty array", nil)
		return nil, &res
	}
	if len(raw) > clusterMembersMaxLimit {
		res := opError(http.StatusBadRequest, "dlq_ids_cap_exceeded",
			"deadLetterIds exceeds the per-request cap", map[string]any{"cap": clusterMembersMaxLimit})
		return nil, &res
	}
	ids := make([]string, 0, len(raw))
	for _, candidate := range raw {
		id, ok := candidate.(string)
		if !ok || id == "" {
			res := opError(http.StatusBadRequest, "dlq_ids_invalid_entries",
				"deadLetterIds must contain non-empty strings", nil)
			return nil, &res
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func (s *V1Server) bulkResolveCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		DeadLetterIds []any `json:"deadLetterIds"`
	}
	_ = decodeBody(r, &body)
	ids, bad := readBulkDeadLetterIDs(body.DeadLetterIds, body.DeadLetterIds != nil)
	if bad != nil {
		return *bad
	}
	q := store.New(s.pool)
	errorsOut := make([]map[string]any, 0)
	resolved := 0
	for _, id := range ids {
		if _, err := q.GetDeadLetter(r.Context(), store.GetDeadLetterParams{ID: id, OrgID: rc.orgID}); err != nil {
			errorsOut = append(errorsOut, map[string]any{"deadLetterId": id, "error": "DLQ entry not found"})
			continue
		}
		if _, err := q.MarkDeadLetterResolved(r.Context(), store.MarkDeadLetterResolvedParams{
			OrgID: rc.orgID, ID: id,
		}); err != nil {
			errorsOut = append(errorsOut, map[string]any{"deadLetterId": id, "error": err.Error()})
			continue
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "dlq.resolved", audit.Options{
			TargetType: "dlq", TargetID: id, Metadata: map[string]any{"bulk": true},
		})
		s.dismissLinkedRecoveryItem(r.Context(), rc, id)
		resolved++
	}
	return opOK(map[string]any{"resolved": resolved, "failed": len(errorsOut), "errors": errorsOut})
}

func (s *V1Server) bulkReplayCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		DeadLetterIds []any `json:"deadLetterIds"`
	}
	_ = decodeBody(r, &body)
	ids, bad := readBulkDeadLetterIDs(body.DeadLetterIds, body.DeadLetterIds != nil)
	if bad != nil {
		return *bad
	}
	q := store.New(s.pool)
	errorsOut := make([]map[string]any, 0)
	replayed := 0
	for index, id := range ids {
		item, err := q.GetDeadLetter(r.Context(), store.GetDeadLetterParams{ID: id, OrgID: rc.orgID})
		if err != nil {
			errorsOut = append(errorsOut, map[string]any{"deadLetterId": id, "error": "DLQ entry not found"})
			continue
		}
		// Only open entries replay — re-firing an already-replayed row
		// across a batch would double-enqueue downstream work.
		if item.Status != "open" {
			errorsOut = append(errorsOut, map[string]any{"deadLetterId": id, "error": "DLQ entry already " + item.Status})
			continue
		}
		if err := s.engine.RedriveDeadLetterWithOptions(r.Context(), rc.orgID, id,
			engine.RedriveOptions{RequestedBy: rc.userID}); err != nil {
			errorsOut = append(errorsOut, map[string]any{"deadLetterId": id, "error": err.Error()})
			continue
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "dlq.replayed", audit.Options{
			TargetType: "dlq", TargetID: id,
			Metadata: map[string]any{"bulk": true, "sequenceIndex": index, "total": len(ids)},
		})
		replayed++
	}
	return opOK(map[string]any{"replayed": replayed, "failed": len(errorsOut), "errors": errorsOut})
}

func (s *V1Server) clusterApplyCore(r *http.Request, rc v1Request) opResult {
	_, settings := aiconfig.Resolve(r.Context(), s.pool, rc.orgID)
	if limitErr := s.limiter.Enforce(r.Context(), rc.orgID, ratelimit.Options{
		Name: "ai", Max: settings.RateLimitPerMin, Window: time.Minute,
	}); limitErr != nil {
		return opError(http.StatusTooManyRequests, "rate_limited", limitErr.Error(), nil)
	}
	var body struct {
		ClusterSignature             string          `json:"clusterSignature"`
		DeadLetterIds                []any           `json:"deadLetterIds"`
		SuggestedWorkflow            json.RawMessage `json:"suggestedWorkflow"`
		RecoveryPlaybookID           string          `json:"recoveryPlaybookId"`
		RecoveryValidationRunID      string          `json:"recoveryValidationRunId"`
		RecoveryPlaybookDeadLetterID string          `json:"recoveryPlaybookDeadLetterId"`
	}
	_ = decodeBody(r, &body)
	if body.ClusterSignature == "" {
		return opError(http.StatusBadRequest, "dlq_field_required", "clusterSignature is required",
			map[string]any{"field": "clusterSignature"})
	}
	ids, bad := readBulkDeadLetterIDs(body.DeadLetterIds, body.DeadLetterIds != nil)
	if bad != nil {
		return *bad
	}
	// The applied fix is validated ONCE through the same grammar gate as
	// /dlq/validate-fix, then applied per member below.
	var fix *domain.Workflow
	var fixJSON []byte
	if len(body.SuggestedWorkflow) > 0 && string(body.SuggestedWorkflow) != "null" {
		parsed, issues := domain.Parse(body.SuggestedWorkflow)
		if parsed == nil {
			reason := "unknown"
			if len(issues) > 0 {
				reason = issues[0].Message
			}
			return opError(http.StatusBadRequest, "dlq_workflow_schema_invalid",
				"suggestedWorkflow failed schema validation", map[string]any{"reason": reason})
		}
		fix = parsed
		fixJSON, _ = json.Marshal(parsed)
	}
	if (body.RecoveryPlaybookID == "") != (body.RecoveryValidationRunID == "") {
		return opError(http.StatusBadRequest, "recovery_playbook_invalid_body",
			"recoveryPlaybookId and recoveryValidationRunId must be provided together", nil)
	}
	q := store.New(s.pool)
	hasClaim := body.RecoveryPlaybookID != ""
	if hasClaim {
		representativeOK := false
		if body.RecoveryPlaybookDeadLetterID != "" && fix != nil {
			if slices.Contains(ids, body.RecoveryPlaybookDeadLetterID) {
				representativeOK = true
			}
		}
		if representativeOK {
			representative, err := q.GetDeadLetter(r.Context(), store.GetDeadLetterParams{
				ID: body.RecoveryPlaybookDeadLetterID, OrgID: rc.orgID,
			})
			representativeOK = err == nil && representative.Status == "open" &&
				s.engine.VerifyPlaybookReplayClaim(r.Context(), rc.orgID, representative, fix,
					body.RecoveryPlaybookID, body.RecoveryValidationRunID)
		}
		if !representativeOK {
			return opError(http.StatusUnprocessableEntity, "recovery_playbook_outcome_invalid",
				"Recovery Playbook replay evidence cannot be verified", nil)
		}
	}

	errorsOut := make([]map[string]any, 0)
	replayed := 0
	for index, id := range ids {
		item, err := q.GetDeadLetter(r.Context(), store.GetDeadLetterParams{ID: id, OrgID: rc.orgID})
		if err != nil {
			errorsOut = append(errorsOut, map[string]any{"deadLetterId": id, "error": "DLQ entry not found"})
			continue
		}
		if item.Status != "open" {
			errorsOut = append(errorsOut, map[string]any{"deadLetterId": id, "error": "DLQ entry already " + item.Status})
			continue
		}
		if !recheckDeadLetterSignature(item, body.ClusterSignature) {
			errorsOut = append(errorsOut, map[string]any{
				"deadLetterId": id, "error": "DLQ entry signature no longer matches the claimed cluster",
			})
			continue
		}
		opts := engine.RedriveOptions{SignatureOverride: body.ClusterSignature, RequestedBy: rc.userID}
		if fixAppliesToMember(fix, item.WorkflowJson, item.NodeID) {
			opts.FixWorkflowJSON = fixJSON
			if hasClaim && id == body.RecoveryPlaybookDeadLetterID {
				opts.PlaybookID = body.RecoveryPlaybookID
				opts.ValidationRunID = body.RecoveryValidationRunID
			}
		}
		if err := s.engine.RedriveDeadLetterWithOptions(r.Context(), rc.orgID, id, opts); err != nil {
			errorsOut = append(errorsOut, map[string]any{"deadLetterId": id, "error": err.Error()})
			continue
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "recovery.cluster_apply", audit.Options{
			TargetType: "dlq", TargetID: id,
			Metadata: map[string]any{
				"clusterSignature": body.ClusterSignature,
				"sequenceIndex":    index, "totalInCluster": len(ids),
			},
		})
		replayed++
	}
	// The synchronous enqueue cannot truthfully claim any downtime ended;
	// terminal impact is read from the ledger after node success.
	return opOK(map[string]any{
		"replayed": replayed, "failed": len(errorsOut), "errors": errorsOut, "downtimeEndedMs": 0,
	})
}

func (s *V1Server) mountBulkRecoveryRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /dlq/cluster-members", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.clusterMembersCore(r, rc))
	}))
	mux.HandleFunc("POST /dlq/resolve", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.resolveDeadLetterCore(r, rc))
	}))
	mux.HandleFunc("POST /dlq/bulk-resolve", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.bulkResolveCore(r, rc))
	}))
	mux.HandleFunc("POST /dlq/bulk-replay", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.bulkReplayCore(r, rc))
	}))
	mux.HandleFunc("POST /dlq/cluster-apply", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.clusterApplyCore(r, rc))
	}))
}
