// The product surface trio (reference snippets-routes.ts,
// solution-packs-routes.ts, onboarding-routes.ts):
//
//   - Snippets: built-ins ship in CODE and are never persisted; the list
//     concatenates them ahead of the org's custom rows; every mutating
//     route rejects a `builtin:` id with 409. Insertion is a pure
//     client-side canvas delta, so `/{id}/inserted` is an audit beacon.
//   - Solution packs: the embedded catalog (internal/packs) + install as
//     a draft workflow version, one-click sandbox sample run, and a
//     deterministic recovery drills that cross the real worker/DLQ or
//     stalled-node reaper boundary.
//   - Onboarding: derive-on-read milestones from durable org state (no
//     event hooks); the persisted row is only the per-user high-water +
//     status latch; completion audits exactly once via CAS.
package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/packs"
	"github.com/johnny4young/janusly/internal/store"
)

/* ---------------------------- built-in snippets ------------------------ */

const builtinSnippetPrefix = "builtin:"

type builtinSnippet struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Category    string `json:"category"`
	Tags        []string
	Nodes       []map[string]any
	Edges       []map[string]any
	EntryNodeID string
}

func (s builtinSnippet) view() map[string]any {
	return map[string]any{
		"id": s.ID, "name": s.Name, "description": s.Description,
		"category": s.Category, "tags": s.Tags, "builtin": true,
		"nodes": s.Nodes, "edges": s.Edges, "entryNodeId": s.EntryNodeID,
	}
}

// builtinSnippets ports the contract BUILTIN_SNIPPETS catalog (9 entries).
var builtinSnippets = []builtinSnippet{
	{ID: "builtin:retry-with-backoff", Name: "Retry with backoff", Category: "retry",
		Description: "An HTTP call wrapped with bounded exponential-backoff retries.",
		Tags:        []string{"http", "resilience"},
		Nodes: []map[string]any{{"id": "call", "type": "http", "config": map[string]any{
			"method": "GET", "url": "https://api.example.com/resource",
			"retryPolicy": map[string]any{"maxAttempts": 4, "backoff": "exponential", "initialDelayMs": 500},
		}}},
		Edges: []map[string]any{}, EntryNodeID: "call"},
	{ID: "builtin:approval-with-timeout", Name: "Approval with timeout", Category: "approval",
		Description: "A human approval gate followed by a timed wait before the action proceeds.",
		Tags:        []string{"approval", "human-in-the-loop"},
		Nodes: []map[string]any{
			{"id": "approve", "type": "approval", "config": map[string]any{"message": "Approve before continuing?"}},
			{"id": "wait", "type": "wait_until", "config": map[string]any{"durationSeconds": 3600}},
		},
		Edges: []map[string]any{{"from": "approve", "to": "wait"}}, EntryNodeID: "approve"},
	{ID: "builtin:slack-on-failure", Name: "Slack on failure", Category: "notification",
		Description: "Post a Slack message when an upstream step fails (wire the condition edge to your failure branch).",
		Tags:        []string{"slack", "alerting"},
		Nodes: []map[string]any{{"id": "notify", "type": "tool", "config": map[string]any{
			"tool": "slack.post", "input": map[string]any{"credentialName": "slack_webhook", "text": "A workflow step failed."},
		}}},
		Edges: []map[string]any{}, EntryNodeID: "notify"},
	{ID: "builtin:condition-then-branch", Name: "Condition then branch", Category: "transform",
		Description: "A condition node that splits into a true branch and a false branch.",
		Tags:        []string{"condition", "branching"},
		Nodes: []map[string]any{
			{"id": "check", "type": "condition", "config": map[string]any{"expression": "context.input.amount > 100"}},
			{"id": "high", "type": "noop", "config": map[string]any{}},
			{"id": "low", "type": "noop", "config": map[string]any{}},
		},
		Edges: []map[string]any{
			{"from": "check", "to": "high", "condition": "context.input.amount > 100"},
			{"from": "check", "to": "low"},
		}, EntryNodeID: "check"},
	{ID: "builtin:parallel-fan-out", Name: "Parallel fan-out", Category: "transform",
		Description: "Fork into two parallel branches and join their results.",
		Tags:        []string{"parallel", "fan-out"},
		Nodes: []map[string]any{
			{"id": "fork", "type": "parallel_fork", "config": map[string]any{"branches": []any{"a", "b"}}},
			{"id": "branch_a", "type": "noop", "config": map[string]any{}},
			{"id": "branch_b", "type": "noop", "config": map[string]any{}},
			{"id": "join", "type": "join", "config": map[string]any{"sources": map[string]any{"a": "branch_a", "b": "branch_b"}}},
		},
		Edges: []map[string]any{
			{"from": "fork", "to": "branch_a"}, {"from": "fork", "to": "branch_b"},
			{"from": "branch_a", "to": "join"}, {"from": "branch_b", "to": "join"},
		}, EntryNodeID: "fork"},
	{ID: "builtin:transform-and-cache", Name: "Transform and cache", Category: "transform",
		Description: "Reshape an upstream payload then persist the result for downstream reuse.",
		Tags:        []string{"transform", "mapping"},
		Nodes: []map[string]any{
			{"id": "shape", "type": "transform", "config": map[string]any{"mapping": map[string]any{
				"id": "{{context.fetch.output.id}}", "total": "{{context.fetch.output.amount}}",
			}}},
			{"id": "cache", "type": "tool", "config": map[string]any{
				"tool": "kv.set", "input": map[string]any{"key": "last_result", "value": "{{context.shape.output}}"},
			}},
		},
		Edges: []map[string]any{{"from": "shape", "to": "cache"}}, EntryNodeID: "shape"},
	{ID: "builtin:http-with-circuit-breaker", Name: "HTTP with circuit breaker", Category: "error_handling",
		Description: "An HTTP call guarded by a condition that short-circuits when the upstream is unhealthy.",
		Tags:        []string{"http", "circuit-breaker", "resilience"},
		Nodes: []map[string]any{
			{"id": "breaker", "type": "condition", "config": map[string]any{"expression": "context.health.output.healthy == true"}},
			{"id": "request", "type": "http", "config": map[string]any{
				"method": "POST", "url": "https://api.example.com/action",
				"retryPolicy": map[string]any{"maxAttempts": 2, "backoff": "fixed", "initialDelayMs": 250},
			}},
			{"id": "short_circuit", "type": "noop", "config": map[string]any{"note": "upstream unhealthy — skipped"}},
		},
		Edges: []map[string]any{
			{"from": "breaker", "to": "request", "condition": "context.health.output.healthy == true"},
			{"from": "breaker", "to": "short_circuit"},
		}, EntryNodeID: "breaker"},
	{ID: "builtin:dlq-friendly-error-flow", Name: "DLQ-friendly error flow", Category: "error_handling",
		Description: "An action node with capped retries that lands in the dead-letter queue on exhaustion, plus a failure notifier.",
		Tags:        []string{"dlq", "error-handling", "resilience"},
		Nodes: []map[string]any{
			{"id": "action", "type": "http", "config": map[string]any{
				"method": "POST", "url": "https://api.example.com/submit",
				"retryPolicy": map[string]any{"maxAttempts": 3, "backoff": "exponential", "initialDelayMs": 1000},
			}},
			{"id": "on_failure", "type": "condition", "config": map[string]any{"expression": "context.action.output.ok == false"}},
			{"id": "alert", "type": "tool", "config": map[string]any{
				"tool": "slack.post", "input": map[string]any{"credentialName": "slack_webhook", "text": "Submit failed after retries — check the DLQ."},
			}},
		},
		Edges: []map[string]any{
			{"from": "action", "to": "on_failure"},
			{"from": "on_failure", "to": "alert", "condition": "context.action.output.ok == false"},
		}, EntryNodeID: "action"},
	{ID: "builtin:webhook-to-transform", Name: "Webhook to transform", Category: "trigger",
		Description: "An inbound webhook trigger feeding a payload reshape — the smallest event-driven starter.",
		Tags:        []string{"webhook", "trigger"},
		Nodes: []map[string]any{
			{"id": "inbox", "type": "webhook_received", "config": map[string]any{"endpointKey": "orders"}},
			{"id": "shape", "type": "transform", "config": map[string]any{"mapping": map[string]any{
				"total": "{{context.inbox.output.event.payload.total}}",
			}}},
		},
		Edges: []map[string]any{{"from": "inbox", "to": "shape"}}, EntryNodeID: "inbox"},
}

func builtinSnippetByID(id string) *builtinSnippet {
	for index := range builtinSnippets {
		if builtinSnippets[index].ID == id {
			return &builtinSnippets[index]
		}
	}
	return nil
}

func customSnippetView(row store.Snippet) map[string]any {
	var tags, nodes, edges any
	_ = json.Unmarshal(row.Tags, &tags)
	_ = json.Unmarshal(row.NodesJson, &nodes)
	_ = json.Unmarshal(row.EdgesJson, &edges)
	return map[string]any{
		"id": row.ID, "name": row.Name, "description": row.Description,
		"category": row.Category, "tags": tags, "builtin": false,
		"nodes": nodes, "edges": edges, "entryNodeId": textOrNull(row.EntryNodeID),
		"createdAt": isoMillis(row.CreatedAt), "updatedAt": isoMillis(row.UpdatedAt),
	}
}

type snippetBody struct {
	Name        string           `json:"name"`
	Description string           `json:"description"`
	Category    string           `json:"category"`
	Tags        []string         `json:"tags"`
	Nodes       []map[string]any `json:"nodes"`
	Edges       []map[string]any `json:"edges"`
	EntryNodeID string           `json:"entryNodeId"`
}

var snippetCategories = map[string]bool{
	"retry": true, "approval": true, "notification": true,
	"transform": true, "error_handling": true, "trigger": true,
}

func validateSnippetBody(body *snippetBody) string {
	body.Name = strings.TrimSpace(body.Name)
	switch {
	case body.Name == "" || len(body.Name) > 120:
		return "name must be 1..120 characters"
	case !snippetCategories[body.Category]:
		return "unknown snippet category"
	case len(body.Tags) > 10:
		return "at most 10 tags"
	case len(body.Nodes) == 0 || len(body.Nodes) > 20:
		return "snippets carry 1..20 nodes"
	case len(body.Edges) > 40:
		return "at most 40 edges"
	}
	return ""
}

/* ------------------------------- routes -------------------------------- */

func (s *V1Server) mountProductSurfaceRoutes(mux *http.ServeMux) {
	/* snippets */
	mux.HandleFunc("GET /snippets", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		custom, err := store.New(s.pool).ListSnippets(r.Context(), rc.orgID)
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		views := make([]map[string]any, 0, len(builtinSnippets)+len(custom))
		for _, snippet := range builtinSnippets {
			views = append(views, snippet.view())
		}
		for _, row := range custom {
			views = append(views, customSnippetView(row))
		}
		writeUnversioned(w, opOK(map[string]any{"snippets": views}))
	}))

	mux.HandleFunc("POST /snippets", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body snippetBody
		if err := decodeBody(r, &body); err != nil {
			writeUnversioned(w, opError(http.StatusUnprocessableEntity, "snippet_invalid", "invalid snippet body", nil))
			return
		}
		if message := validateSnippetBody(&body); message != "" {
			writeUnversioned(w, opError(http.StatusUnprocessableEntity, "snippet_invalid", message, nil))
			return
		}
		q := store.New(s.pool)
		if _, err := q.FindSnippetByName(r.Context(), store.FindSnippetByNameParams{
			OrgID: rc.orgID, Lower: body.Name,
		}); err == nil {
			writeUnversioned(w, opError(http.StatusConflict, "snippet_name_exists", "A snippet with that name already exists", nil))
			return
		}
		tags, _ := json.Marshal(orEmptySlice(body.Tags))
		nodes, _ := json.Marshal(body.Nodes)
		edges, _ := json.Marshal(orEmptyMaps(body.Edges))
		row, err := q.InsertSnippet(r.Context(), store.InsertSnippetParams{
			ID: s.newID(), OrgID: rc.orgID, Name: body.Name,
			Description: body.Description,
			Category:    body.Category, Tags: tags, NodesJson: nodes, EdgesJson: edges,
			EntryNodeID: pgtype.Text{String: body.EntryNodeID, Valid: body.EntryNodeID != ""},
			CreatedBy:   pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "snippet.created", audit.Options{
			TargetType: "snippet", TargetID: row.ID,
			Metadata: map[string]any{"name": row.Name, "category": row.Category, "nodeCount": len(body.Nodes)},
		})
		writeUnversioned(w, opResult{status: http.StatusCreated, data: map[string]any{"snippet": customSnippetView(row)}})
	}))

	mux.HandleFunc("POST /snippets/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		id := r.PathValue("id")
		if strings.HasPrefix(id, builtinSnippetPrefix) {
			writeUnversioned(w, opError(http.StatusConflict, "snippet_builtin_immutable", "Built-in snippets are read-only", nil))
			return
		}
		var body snippetBody
		if err := decodeBody(r, &body); err != nil {
			writeUnversioned(w, opError(http.StatusUnprocessableEntity, "snippet_invalid", "invalid snippet body", nil))
			return
		}
		if message := validateSnippetBody(&body); message != "" {
			writeUnversioned(w, opError(http.StatusUnprocessableEntity, "snippet_invalid", message, nil))
			return
		}
		q := store.New(s.pool)
		if clash, err := q.FindSnippetByName(r.Context(), store.FindSnippetByNameParams{
			OrgID: rc.orgID, Lower: body.Name,
		}); err == nil && clash.ID != id {
			writeUnversioned(w, opError(http.StatusConflict, "snippet_name_exists", "A snippet with that name already exists", nil))
			return
		}
		tags, _ := json.Marshal(orEmptySlice(body.Tags))
		nodes, _ := json.Marshal(body.Nodes)
		edges, _ := json.Marshal(orEmptyMaps(body.Edges))
		row, err := q.UpdateSnippet(r.Context(), store.UpdateSnippetParams{
			OrgID: rc.orgID, ID: id, Name: body.Name,
			Description: body.Description,
			Category:    body.Category, Tags: tags, NodesJson: nodes, EdgesJson: edges,
			EntryNodeID: pgtype.Text{String: body.EntryNodeID, Valid: body.EntryNodeID != ""},
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusNotFound, "snippet_not_found", "Snippet not found", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "snippet.updated", audit.Options{
			TargetType: "snippet", TargetID: id,
			Metadata: map[string]any{"name": row.Name, "category": row.Category},
		})
		writeUnversioned(w, opOK(map[string]any{"snippet": customSnippetView(row)}))
	}))

	mux.HandleFunc("DELETE /snippets/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		id := r.PathValue("id")
		if strings.HasPrefix(id, builtinSnippetPrefix) {
			writeUnversioned(w, opError(http.StatusConflict, "snippet_builtin_immutable", "Built-in snippets are read-only", nil))
			return
		}
		row, err := store.New(s.pool).DeleteSnippet(r.Context(), store.DeleteSnippetParams{OrgID: rc.orgID, ID: id})
		if err != nil {
			writeUnversioned(w, opError(http.StatusNotFound, "snippet_not_found", "Snippet not found", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "snippet.deleted", audit.Options{
			TargetType: "snippet", TargetID: id,
			Metadata: map[string]any{"name": row.Name, "category": row.Category},
		})
		writeUnversioned(w, opOK(map[string]any{"ok": true}))
	}))

	mux.HandleFunc("POST /snippets/{id}/inserted", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		id := r.PathValue("id")
		builtin := strings.HasPrefix(id, builtinSnippetPrefix)
		exists := builtin && builtinSnippetByID(id) != nil
		if !builtin {
			_, err := store.New(s.pool).GetSnippet(r.Context(), store.GetSnippetParams{OrgID: rc.orgID, ID: id})
			exists = err == nil
		}
		if !exists {
			writeUnversioned(w, opError(http.StatusNotFound, "snippet_not_found", "Snippet not found", nil))
			return
		}
		var body struct {
			WorkflowID        string  `json:"workflowId"`
			InsertedNodeCount float64 `json:"insertedNodeCount"`
		}
		_ = decodeBody(r, &body)
		audit.Write(r.Context(), s.pool, rc.authContext, "snippet.inserted", audit.Options{
			TargetType: "snippet", TargetID: id,
			Metadata: map[string]any{
				"snippetId": id, "builtin": builtin,
				"workflowId": body.WorkflowID, "insertedNodeCount": body.InsertedNodeCount,
			},
		})
		writeUnversioned(w, opOK(map[string]any{"ok": true}))
	}))

	/* solution packs */
	mux.HandleFunc("GET /solution-packs", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		views := make([]map[string]any, 0, len(packs.List()))
		for _, pack := range packs.List() {
			views = append(views, s.packView(r, rc, pack))
		}
		writeUnversioned(w, opOK(map[string]any{"packs": views}))
	}))

	mux.HandleFunc("GET /solution-packs/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		pack := packs.Get(r.PathValue("id"))
		if pack == nil {
			writeUnversioned(w, opError(http.StatusNotFound, "solution_pack_not_found", "Solution pack not found", nil))
			return
		}
		view := s.packView(r, rc, *pack)
		var workflowDoc any
		_ = json.Unmarshal(pack.WorkflowJSON, &workflowDoc)
		view["workflow"] = workflowDoc
		writeUnversioned(w, opOK(map[string]any{"pack": view}))
	}))

	mux.HandleFunc("POST /workflows/import-pack", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct {
			PackID string `json:"packId"`
		}
		if err := decodeBody(r, &body); err != nil || body.PackID == "" {
			writeUnversioned(w, opError(http.StatusBadRequest, "solution_pack_invalid_request", "packId is required", nil))
			return
		}
		pack := packs.Get(body.PackID)
		if pack == nil {
			writeUnversioned(w, opError(http.StatusNotFound, "solution_pack_not_found", "Solution pack not found", nil))
			return
		}
		workflowID, versionID, err := s.installPackWorkflow(r, rc, pack)
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.pack_imported", audit.Options{
			TargetType: "workflow", TargetID: workflowID,
			Metadata: map[string]any{"packId": pack.ID, "packVersion": pack.Version, "versionId": versionID},
		})
		writeUnversioned(w, opResult{status: http.StatusCreated, data: map[string]any{
			"ok": true, "workflowId": workflowID, "versionId": versionID, "packId": pack.ID,
		}})
	}))

	mux.HandleFunc("POST /solution-packs/{id}/sample-run", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		pack := packs.Get(r.PathValue("id"))
		if pack == nil {
			writeUnversioned(w, opError(http.StatusNotFound, "pack_not_found", "Solution pack not found", nil))
			return
		}
		body, rejection := decodeJSONRecord(r, 1_048_576)
		if rejection != nil {
			writeUnversioned(w, *rejection)
			return
		}
		samplePayloadID := ""
		if raw, present := body["samplePayloadId"]; present {
			value, valid := raw.(string)
			samplePayloadID = strings.TrimSpace(value)
			if !valid || samplePayloadID == "" {
				writeUnversioned(w, opResult{status: http.StatusUnprocessableEntity, data: map[string]any{
					"error": "invalid sample-run body",
					"issues": []map[string]any{{
						"path": []string{"samplePayloadId"}, "message": "Expected a non-empty string",
					}},
				}})
				return
			}
		}
		var sample *packs.SamplePayload
		for i := range pack.SamplePayloads {
			if samplePayloadID == "" || pack.SamplePayloads[i].ID == samplePayloadID {
				sample = &pack.SamplePayloads[i]
				break
			}
		}
		if sample == nil {
			writeUnversioned(w, opError(http.StatusBadRequest, "pack_missing_sample_payload",
				"No matching sample payload for this pack", nil))
			return
		}
		wf, _ := domain.Parse(pack.WorkflowJSON)
		if wf == nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "pack workflow unparseable", nil))
			return
		}
		// The sample run is a SANDBOX whose external trigger has already fired:
		// roots carry the bundled payload while write sides remain dry-run skipped.
		runID, err := s.engine.StartSandboxRun(r.Context(), engine.SandboxRunInput{
			OrgID: rc.orgID, Workflow: wf, CreatedBy: rc.userID,
			Input: sample.Input, Source: "pack:" + pack.ID,
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "solution_pack.sample_run_started", audit.Options{
			TargetType: "solution_pack", TargetID: pack.ID,
			Metadata: map[string]any{
				"packId": pack.ID, "samplePayloadId": sample.ID, "runId": runID,
			},
		})
		writeUnversioned(w, opOK(map[string]any{"runId": runID, "samplePayloadId": sample.ID}))
	}))

	mux.HandleFunc("POST /solution-packs/{id}/inject-failure", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		pack := packs.Get(r.PathValue("id"))
		if pack == nil {
			writeUnversioned(w, opError(http.StatusNotFound, "pack_not_found", "Solution pack not found", nil))
			return
		}
		body, rejection := decodeJSONRecord(r, 1_048_576)
		if rejection != nil {
			writeUnversioned(w, *rejection)
			return
		}
		fixtureID := ""
		if raw, present := body["fixtureId"]; present {
			value, valid := raw.(string)
			fixtureID = strings.TrimSpace(value)
			if !valid || fixtureID == "" {
				writeUnversioned(w, opResult{status: http.StatusUnprocessableEntity, data: map[string]any{
					"error": "invalid inject-failure body",
					"issues": []map[string]any{{
						"path": []string{"fixtureId"}, "message": "Expected a non-empty string",
					}},
				}})
				return
			}
		}
		var fixture *packs.FailureFixture
		for i := range pack.FailureFixtures {
			if fixtureID == "" || pack.FailureFixtures[i].ID == fixtureID {
				fixture = &pack.FailureFixtures[i]
				break
			}
		}
		if fixture == nil {
			writeUnversioned(w, opError(http.StatusBadRequest, "pack_no_failure_fixture", "No matching failure fixture for this pack", nil))
			return
		}
		wf, _ := domain.Parse(pack.WorkflowJSON)
		if wf == nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Pack workflow is not executable", nil))
			return
		}
		// Once this organization installs the pack, drills must exercise that
		// persisted workflow identity and latest draft—not the catalog's global
		// template id. Otherwise a validated recovery later tries to save the
		// template id, which can belong to another tenant under the global
		// workflows PK and fails with a misleading conflict.
		installedWorkflowID := wf.ID + "-" + shortHash(rc.orgID, 8)
		latest, latestErr := store.New(s.pool).GetLatestWorkflowVersion(r.Context(), store.GetLatestWorkflowVersionParams{
			WorkflowID: installedWorkflowID,
			OrgID:      rc.orgID,
		})
		switch {
		case latestErr == nil:
			wf, _ = domain.Parse(latest.DagJson)
			if wf == nil {
				writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Installed pack workflow is not executable", nil))
				return
			}
		case !errors.Is(latestErr, pgx.ErrNoRows):
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		source := engine.RecoveryDrillSource{
			Kind: "solution_pack_drill", PackID: pack.ID, FixtureID: fixture.ID,
			FailureMode: fixture.FailureMode, RecoveryPath: fixture.RecoveryPath,
		}
		drillInput := engine.RecoveryDrillInput{
			OrgID: rc.orgID, CreatedBy: rc.userID, Workflow: wf,
			FailedNodeID: fixture.FailedNodeID, Source: source,
		}
		if len(pack.SamplePayloads) > 0 {
			drillInput.Input = pack.SamplePayloads[0].Input
		}

		var runID, deadLetterID string
		var evidence any
		switch fixture.RecoveryPath {
		case "runtime_failure":
			result, err := s.engine.RunRuntimeFailureDrill(r.Context(), drillInput)
			if err != nil {
				slog.Error("solution-pack runtime recovery drill failed",
					"packId", pack.ID, "fixtureId", fixture.ID, "error", err)
				writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Recovery drill failed", nil))
				return
			}
			runID, deadLetterID, evidence = result.RunID, result.DeadLetterID, result.Evidence
		case "stalled_node_reaper":
			result, err := s.engine.RunStalledNodeDrill(r.Context(), drillInput)
			if err != nil {
				slog.Error("solution-pack stalled-node recovery drill failed",
					"packId", pack.ID, "fixtureId", fixture.ID, "error", err)
				writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Recovery drill failed", nil))
				return
			}
			runID, deadLetterID, evidence = result.RunID, result.DeadLetterID, result.Evidence
		default:
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Unsupported recovery drill path", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "solution_pack.failure_injected", audit.Options{
			TargetType: "solution_pack", TargetID: pack.ID,
			Metadata: map[string]any{
				"packId": pack.ID, "fixtureId": fixture.ID,
				"failureMode": fixture.FailureMode, "recoveryPath": fixture.RecoveryPath,
				"failedNodeId": fixture.FailedNodeID, "runId": runID,
				"deadLetterId": deadLetterID, "evidence": evidence,
			},
		})
		writeUnversioned(w, opOK(map[string]any{
			"runId": runID, "deadLetterId": deadLetterID,
			"fixtureId": fixture.ID, "failureMode": fixture.FailureMode,
			"recoveryPath": fixture.RecoveryPath, "evidence": evidence,
		}))
	}))

	/* onboarding */
	mux.HandleFunc("GET /onboarding", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.loadOnboardingState(r, rc))
	}))
	mux.HandleFunc("POST /onboarding", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct {
			Action string `json:"action"`
		}
		if err := decodeBody(r, &body); err != nil ||
			(body.Action != "skip" && body.Action != "resume" && body.Action != "restart") {
			writeUnversioned(w, opError(http.StatusBadRequest, "onboarding_invalid_action", "Unknown onboarding action", nil))
			return
		}
		q := store.New(s.pool)
		_ = q.EnsureOnboardingRow(r.Context(), store.EnsureOnboardingRowParams{
			ID: s.newID(), OrgID: rc.orgID, UserID: rc.userID,
		})
		switch body.Action {
		case "restart":
			if changed, err := q.RestartOnboarding(r.Context(), store.RestartOnboardingParams{
				OrgID: rc.orgID, UserID: rc.userID,
			}); err == nil && changed > 0 {
				audit.Write(r.Context(), s.pool, rc.authContext, "onboarding.restarted", audit.Options{TargetType: "onboarding"})
			}
		default:
			status := "active"
			action := audit.Action("onboarding.resumed")
			if body.Action == "skip" {
				status, action = "skipped", audit.Action("onboarding.skipped")
			}
			if changed, err := q.SetOnboardingStatus(r.Context(), store.SetOnboardingStatusParams{
				OrgID: rc.orgID, UserID: rc.userID, Status: status,
			}); err == nil && changed > 0 {
				audit.Write(r.Context(), s.pool, rc.authContext, action, audit.Options{TargetType: "onboarding"})
			}
		}
		writeUnversioned(w, s.loadOnboardingState(r, rc))
	}))
}

/* --------------------------- onboarding core --------------------------- */

var onboardingSteps = []string{
	"org_created", "credential_configured", "pack_installed",
	"first_run_succeeded", "failure_injected", "recovery_applied", "completed",
}

var onboardingTargets = map[string]string{
	"org_created": "/", "credential_configured": "/credentials",
	"pack_installed": "/solution-packs", "first_run_succeeded": "/runs",
	"failure_injected": "/dlq", "recovery_applied": "/recovery", "completed": "/",
}

func onboardingStepOrder(step string) int {
	for index, candidate := range onboardingSteps {
		if candidate == step {
			return index
		}
	}
	return 0
}

func (s *V1Server) loadOnboardingState(r *http.Request, rc v1Request) opResult {
	ctx := r.Context()
	// Tenant toggle: disabled skips the row create + all derivation.
	if !orgconfig.LoadBool(ctx, s.pool, rc.orgID, "onboarding.enabled") {
		if value := orgconfig.LoadValue(ctx, s.pool, rc.orgID, "onboarding.enabled"); value != nil {
			return opOK(hiddenOnboardingState())
		}
		// Absent row = catalog default TRUE; fall through.
	}
	q := store.New(s.pool)
	_ = q.EnsureOnboardingRow(ctx, store.EnsureOnboardingRowParams{
		ID: s.newID(), OrgID: rc.orgID, UserID: rc.userID,
	})
	row, err := q.GetOnboardingProgress(ctx, store.GetOnboardingProgressParams{
		OrgID: rc.orgID, UserID: rc.userID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opOK(hiddenOnboardingState())
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	if row.Status == "completed" {
		return opOK(composeOnboardingState(row, func(string) bool { return true }, true))
	}
	signals, err := q.ResolveOnboardingSignals(ctx, store.ResolveOnboardingSignalsParams{
		OrgID: rc.orgID, Since: row.RestartedAt,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	done := map[string]bool{
		"org_created":           true,
		"credential_configured": signals.CredentialConfigured,
		"pack_installed":        signals.PackInstalled,
		"first_run_succeeded":   signals.FirstRunSucceeded,
		"failure_injected":      signals.FailureInjected,
		"recovery_applied":      signals.RecoveryApplied.Bool,
	}
	furthest := "org_created"
	allSix := true
	for _, step := range onboardingSteps[:6] {
		if done[step] {
			furthest = step
		} else {
			allSix = false
		}
	}
	// High-water advances monotonically.
	if onboardingStepOrder(furthest) > onboardingStepOrder(row.Step) {
		_ = q.SetOnboardingStep(ctx, store.SetOnboardingStepParams{
			OrgID: rc.orgID, UserID: rc.userID, Step: furthest,
		})
	}
	if allSix {
		if changed, err := q.CompleteOnboardingCas(ctx, store.CompleteOnboardingCasParams{
			OrgID: rc.orgID, UserID: rc.userID,
		}); err == nil && changed > 0 {
			audit.Write(ctx, s.pool, rc.authContext, "onboarding.completed", audit.Options{TargetType: "onboarding"})
		}
		row, _ = q.GetOnboardingProgress(ctx, store.GetOnboardingProgressParams{
			OrgID: rc.orgID, UserID: rc.userID,
		})
	}
	return opOK(composeOnboardingState(row, func(step string) bool {
		if step == "completed" {
			return allSix
		}
		return done[step]
	}, allSix))
}

func hiddenOnboardingState() map[string]any {
	milestones := make([]map[string]any, 0, len(onboardingSteps))
	for order, step := range onboardingSteps {
		milestones = append(milestones, map[string]any{
			"step": step, "order": order, "target": onboardingTargets[step], "done": false,
		})
	}
	return map[string]any{
		"enabled": false, "status": "active", "currentStep": nil, "completed": false,
		"skippedAt": nil, "completedAt": nil, "milestones": milestones,
	}
}

func composeOnboardingState(row store.OnboardingProgress, doneFor func(string) bool, completed bool) map[string]any {
	milestones := make([]map[string]any, 0, len(onboardingSteps))
	var current any
	for order, step := range onboardingSteps {
		done := doneFor(step)
		if current == nil && !done {
			current = step
		}
		milestones = append(milestones, map[string]any{
			"step": step, "order": order, "target": onboardingTargets[step], "done": done,
		})
	}
	return map[string]any{
		"enabled": true, "status": row.Status, "currentStep": current, "completed": completed,
		"skippedAt": timeOrNull(row.SkippedAt), "completedAt": timeOrNull(row.CompletedAt),
		"milestones": milestones,
	}
}

/* ------------------------------ pack helpers ---------------------------- */

// packView projects one pack plus per-org dependency hints (credential
// EXISTENCE only — never a secretRef).
func (s *V1Server) packView(r *http.Request, rc v1Request, pack packs.SolutionPack) map[string]any {
	q := store.New(s.pool)
	credentials := make([]map[string]any, 0, len(pack.RequiredCredentials))
	for _, required := range pack.RequiredCredentials {
		_, err := q.GetCredentialByName(r.Context(), store.GetCredentialByNameParams{
			OrgID: rc.orgID, Kind: required.Kind, Name: required.Name,
		})
		credentials = append(credentials, map[string]any{
			"name": required.Name, "kind": required.Kind, "purpose": required.Purpose,
			"configured": err == nil,
		})
	}
	samples := make([]map[string]any, 0, len(pack.SamplePayloads))
	for _, sample := range pack.SamplePayloads {
		samples = append(samples, map[string]any{"id": sample.ID, "label": sample.Label})
	}
	samplePayloadIDs := make([]string, 0, len(pack.SamplePayloads))
	for _, sample := range pack.SamplePayloads {
		samplePayloadIDs = append(samplePayloadIDs, sample.ID)
	}
	fixtureIDs := make([]string, 0, len(pack.FailureFixtures))
	fixtures := make([]map[string]any, 0, len(pack.FailureFixtures))
	for _, fixture := range pack.FailureFixtures {
		fixtureIDs = append(fixtureIDs, fixture.ID)
		fixtures = append(fixtures, map[string]any{
			"id": fixture.ID, "label": fixture.Label, "description": fixture.Description,
			"failureMode": fixture.FailureMode, "recoveryPath": fixture.RecoveryPath,
		})
	}
	// The contract's toPublicPack projection (nodeCount/failureFixtures
	// included — the packs panel iterates them); `configured` on each
	// credential and the labeled `samples` list are additive runtime fields.
	return map[string]any{
		"id": pack.ID, "name": pack.Name, "description": pack.Description,
		"category": pack.Category, "version": pack.Version,
		"assurance": map[string]any{
			"intentContract":            pack.IntentContract,
			"recoveryContractVersion":   pack.RecoveryContractVersion,
			"qualificationFixtureCount": pack.QualificationFixtureCount,
		},
		"requiredCredentials": credentials, "requiredOrgConfigs": pack.RequiredOrgConfigs,
		"samples": samples, "sampleCount": len(pack.SamplePayloads),
		"nodeCount": pack.NodeCount, "failureCount": len(pack.FailureFixtures),
		"samplePayloadIds": samplePayloadIDs, "failureFixtureIds": fixtureIDs,
		"failureFixtures": fixtures,
	}
}

// installPackWorkflow persists the pack's workflow as a draft version
// (repeat installs append versions) and re-syncs its schedules.
func (s *V1Server) installPackWorkflow(r *http.Request, rc v1Request, pack *packs.SolutionPack) (string, string, error) {
	ctx := r.Context()
	wf, _ := domain.Parse(pack.WorkflowJSON)
	if wf == nil {
		return "", "", fmt.Errorf("pack workflow unparseable")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(tx)
	// workflows.id is a global PK: the installed id is deterministic PER
	// ORG so two tenants can install the same pack and a re-install in the
	// same org appends versions to the same workflow.
	workflowID := wf.ID + "-" + shortHash(rc.orgID, 8)
	wf.ID = workflowID
	if _, err := q.GetWorkflow(ctx, store.GetWorkflowParams{ID: workflowID, OrgID: rc.orgID}); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return "", "", err
		}
		if err := q.InsertWorkflow(ctx, store.InsertWorkflowParams{
			ID: workflowID, OrgID: rc.orgID, Name: wf.Name,
			CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		}); err != nil {
			return "", "", err
		}
	}
	version, err := q.CountWorkflowVersions(ctx, store.CountWorkflowVersionsParams{
		WorkflowID: workflowID, OrgID: rc.orgID,
	})
	if err != nil {
		return "", "", err
	}
	versionID := s.newID()
	var dagDocument map[string]any
	if err := json.Unmarshal(pack.WorkflowJSON, &dagDocument); err != nil {
		return "", "", err
	}
	dagDocument["id"] = workflowID
	dagJSON, err := json.Marshal(dagDocument)
	if err != nil {
		return "", "", err
	}
	if err := q.InsertWorkflowVersion(ctx, store.InsertWorkflowVersionParams{
		ID: versionID, OrgID: rc.orgID, WorkflowID: workflowID,
		Version: int32(version) + 1, DagJson: dagJSON,
		CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
	}); err != nil {
		return "", "", err
	}
	if err := s.engine.SyncWorkflowSchedules(ctx, q, rc.orgID, workflowID, versionID, rc.userID, wf); err != nil {
		return "", "", err
	}
	return workflowID, versionID, tx.Commit(ctx)
}

func orEmptySlice(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func orEmptyMaps(values []map[string]any) []map[string]any {
	if values == nil {
		return []map[string]any{}
	}
	return values
}

var _ = time.Now
