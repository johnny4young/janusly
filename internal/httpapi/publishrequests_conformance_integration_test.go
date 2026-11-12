//go:build integration

package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// publishRequestSeed stores an agent's draft, its passed receipt and a
// pending publish request for it, as workflows.publish would.
type publishRequestSeed struct {
	t                         *testing.T
	h                         *apiHarness
	agent, onBehalfOf         string
	workflowID, baseVersionID string
	document                  map[string]any
	digest, suffix            string
	expiresIn, receiptAge     string
	reasons                   string
}

func (s publishRequestSeed) insert() string {
	s.t.Helper()
	pool := testPool(s.t)
	exec := func(sql string, args ...any) {
		s.t.Helper()
		if _, err := pool.Exec(s.t.Context(), sql, args...); err != nil {
			s.t.Fatalf("seed: %v", err)
		}
	}
	if s.expiresIn == "" {
		s.expiresIn = "1 day"
	}
	if s.receiptAge == "" {
		s.receiptAge = "0 seconds"
	}
	if s.reasons == "" {
		s.reasons = "{first_publish,writes}"
	}
	raw, _ := json.Marshal(s.document)
	draftID, qualificationID, requestID := "draft-"+s.suffix, "qual-"+s.suffix, "pub-"+s.suffix
	var base any
	if s.baseVersionID != "" {
		base = s.baseVersionID
	}
	exec(`INSERT INTO workflow_drafts (id, org_id, workflow_id, base_version_id, document, digest, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`, draftID, s.h.org, s.workflowID, base, raw, s.digest, s.agent)
	exec(`INSERT INTO draft_qualifications (id, org_id, draft_id, digest, status, checks, fixture_runs, created_by, completed_at, created_at)
		VALUES ($1, $2, $3, $4, 'passed', '[{"code":"static","status":"passed","message":"structure passed"}]',
		'[{"fixture":"happy path","runId":"run-1","status":"passed"}]', $5, now(), now() - $6::interval)`,
		qualificationID, s.h.org, draftID, s.digest, s.agent, s.receiptAge)
	exec(`INSERT INTO publish_requests (id, org_id, workflow_id, draft_id, qualification_id, reasons, requested_by, on_behalf_of, drafted_by, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $7, now() + $9::interval)`,
		requestID, s.h.org, s.workflowID, draftID, qualificationID, s.reasons, s.agent, s.onBehalfOf, s.expiresIn)
	return requestID
}

// publishedVersion reads the version a decision published.
func publishedVersion(t *testing.T, h *apiHarness, requestID string) string {
	t.Helper()
	var version string
	if err := testPool(t).QueryRow(t.Context(), `SELECT published_version_id FROM publish_requests WHERE org_id = $1 AND id = $2`,
		h.org, requestID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	return version
}

// conformancePublishRequests approves an agent's first publication, then
// reviews and rejects a change that removes a step, so the detail carries
// effects, changes and the production document.
func conformancePublishRequests(t *testing.T, h *apiHarness, rec *conformanceRecorder) {
	t.Helper()
	pool := testPool(t)
	decider, creator := "conformance-decider-"+h.org, "conformance-creator-"+h.org
	if _, err := pool.Exec(t.Context(), `INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, 'editor'), ($4, $2, $5, 'editor')`,
		"m-"+decider, h.org, decider, "m-"+creator, creator); err != nil {
		t.Fatal(err)
	}
	clientID := "conformance-publisher-" + h.org
	if _, err := pool.Exec(t.Context(), `INSERT INTO agent_clients (id, org_id, name, capabilities, token_digest, token_last4, created_by, expires_at)
		VALUES ($1, $2, 'Publishing agent', ARRAY['read','propose','test','publish'], sha256(convert_to($1, 'UTF8')), 'abcd', $3, now() + interval '1 day')`,
		clientID, h.org, creator); err != nil {
		t.Fatal(err)
	}
	as := map[string]string{"x-user-id": decider}
	workflowID := "conformance-publish-" + h.org
	first := makeLinearWorkflow(workflowID)
	first["nodes"] = append(first["nodes"].([]any), map[string]any{"id": "notify", "type": "http", "config": map[string]any{
		"url": "https://hooks.example.com/notify", "method": "POST",
		"headers": map[string]any{"Authorization": "Bearer {{secret.notify_token}}"},
	}})
	first["edges"] = append(first["edges"].([]any), map[string]any{"from": "done", "to": "notify"})
	seed := publishRequestSeed{t: t, h: h, agent: "agent:" + clientID, onBehalfOf: creator, workflowID: workflowID,
		document: first, digest: strings.Repeat("e", 64), suffix: "approve-" + h.org}
	approved := seed.insert()

	rec.record("GET /v1/publish-requests", h.callWithHeaders("GET", "/v1/publish-requests?status=pending", nil, "", as), http.StatusOK)
	detail := rec.record("GET /v1/publish-requests/{id}", h.callWithHeaders("GET", "/v1/publish-requests/"+approved, nil, "", as), http.StatusOK)
	if effects, _ := detail["effects"].([]any); len(effects) == 0 {
		t.Fatalf("a first publication that calls out must list its effects: %+v", detail)
	}
	rec.record("POST /v1/publish-requests/{id}/approve", h.callWithHeaders("POST", "/v1/publish-requests/"+approved+"/approve",
		map[string]any{"reason": "conformance"}, "", as), http.StatusOK)

	shrunk := makeLinearWorkflow(workflowID)
	seed.document, seed.digest, seed.suffix = shrunk, strings.Repeat("f", 64), "reject-"+h.org
	seed.baseVersionID, seed.reasons = publishedVersion(t, h, approved), "{steps_removed}"
	rejected := seed.insert()
	changed := rec.record("GET /v1/publish-requests/{id}", h.callWithHeaders("GET", "/v1/publish-requests/"+rejected, nil, "", as), http.StatusOK)
	if changed["current"] == nil || !strings.Contains(fmtJSON(changed["changes"]), "notify") {
		t.Fatalf("a change to a live workflow must carry production and what it removes: %+v", changed)
	}
	rec.record("POST /v1/publish-requests/{id}/reject", h.callWithHeaders("POST", "/v1/publish-requests/"+rejected+"/reject",
		map[string]any{"reason": "keep the notification"}, "", as), http.StatusOK)
	rec.record("GET /v1/publish-requests", h.callWithHeaders("GET", "/v1/publish-requests", nil, "", as), http.StatusOK)
	rec.record("GET /v1/publish-requests/{id}", h.callWithHeaders("GET", "/v1/publish-requests/"+rejected, nil, "", as), http.StatusOK)
}

func fmtJSON(value any) string {
	raw, _ := json.Marshal(value)
	return string(raw)
}
