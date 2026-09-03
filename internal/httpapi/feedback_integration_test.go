//go:build integration

package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func seedFeedbackDeadLetter(t *testing.T, orgID, workflowID, suffix string, saved bool) string {
	t.Helper()
	pool := testPool(t)
	ctx := t.Context()
	runID := "run-feedback-" + suffix
	deadLetterID := "dlq-feedback-" + suffix
	workflowJSON := `{}`
	if saved {
		workflowJSON = fmt.Sprintf(`{"id":%q}`, workflowID)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO runs
		(id, org_id, workflow_version_id, status, input_json)
		VALUES ($1, $2, $3, 'failed', '{}')`, runID, orgID, workflowID); err != nil {
		t.Fatalf("seed feedback run: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO dead_letters
		(id, org_id, run_id, node_id, workflow_json, node_json, error_json)
		VALUES ($1, $2, $3, 'request', $4::jsonb,
		        '{"type":"http","config":{"tool":"http.request"}}',
		        '{"message":"HTTP 401 with Bearer sk-aaaaaaaaaaaaaaaaaaaaaaaa"}')`,
		deadLetterID, orgID, runID, workflowJSON); err != nil {
		t.Fatalf("seed feedback DLQ: %v", err)
	}
	return deadLetterID
}

func requireFeedbackError(t *testing.T, res apiResponse, status int, code string) {
	t.Helper()
	if res.status != status || res.body["code"] != code {
		t.Fatalf("feedback error: status=%d body=%+v want=%d/%s", res.status, res.body, status, code)
	}
}

func TestRecoveryFeedbackDerivesSavedWorkflowAndRecordsDurableProjection(t *testing.T) {
	t.Setenv("JANUSLY_MEMORY_ENABLED", "false")
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	suffix := fmt.Sprint(time.Now().UnixNano())
	workflowID := "wf-feedback-" + suffix
	deadLetterID := seedFeedbackDeadLetter(t, h.org, workflowID, suffix, true)

	var memoryUsageBefore int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM usage_events
		WHERE org_id = $1 AND metric = 'memory.commit'`, h.org).Scan(&memoryUsageBefore)
	secretComment := "operator pasted sk-" + strings.Repeat("a", 24)
	hostile := h.call("POST", "/recovery/feedback", map[string]any{
		"deadLetterId":   deadLetterID,
		"workflowId":     "wf-client-must-not-control",
		"suggestionMode": "ai",
		"approachLabel":  "add_retry",
		"accepted":       true,
	}, "")
	if hostile.status != http.StatusBadRequest {
		t.Fatalf("unknown workflowId must be refused, got %d %+v", hostile.status, hostile.body)
	}

	res := h.call("POST", "/recovery/feedback", map[string]any{
		"deadLetterId":   deadLetterID,
		"suggestionMode": "ai",
		"approachLabel":  "add_retry",
		"accepted":       true,
		"comment":        secretComment,
		"rationale":      "Retrying the bounded upstream call is safe.",
		"evalConsent":    true,
		"rawConfidence":  87,
	}, "")
	if res.status != 200 || res.body["ok"] != true {
		t.Fatalf("record feedback: %d %+v", res.status, res.body)
	}

	var storedWorkflow, mode, approach, comment string
	var accepted, evalConsent bool
	var rawConfidence int
	if err := pool.QueryRow(ctx, `SELECT workflow_id, suggestion_mode, approach_label,
		accepted, raw_confidence, comment, eval_consent
		FROM recovery_feedback WHERE org_id = $1 AND dead_letter_id = $2
		ORDER BY created_at DESC LIMIT 1`, h.org, deadLetterID).Scan(
		&storedWorkflow, &mode, &approach, &accepted, &rawConfidence, &comment, &evalConsent,
	); err != nil {
		t.Fatalf("read feedback row: %v", err)
	}
	if storedWorkflow != workflowID || mode != "ai" || approach != "add_retry" ||
		!accepted || rawConfidence != 87 || !evalConsent {
		t.Fatalf("feedback row mismatch: workflow=%s mode=%s approach=%s accepted=%v confidence=%d consent=%v",
			storedWorkflow, mode, approach, accepted, rawConfidence, evalConsent)
	}
	if strings.Contains(comment, "sk-") || !strings.Contains(comment, "[redacted]") {
		t.Fatalf("comment secret must be scrubbed before persistence: %q", comment)
	}

	var feedbackSeen, acceptedSeen time.Time
	if err := pool.QueryRow(ctx, `SELECT feedback_last_seen, accepted_fix_last_seen
		FROM recovery_feedback_health
		WHERE org_id = $1 AND workflow_id = $2 AND approach_label = 'add_retry'`,
		h.org, workflowID).Scan(&feedbackSeen, &acceptedSeen); err != nil {
		t.Fatalf("read feedback-health projection: %v", err)
	}
	if feedbackSeen.IsZero() || acceptedSeen.IsZero() {
		t.Fatalf("accepted feedback must set both freshness clocks: feedback=%s accepted=%s",
			feedbackSeen, acceptedSeen)
	}

	var targetType, targetID string
	var metadataJSON []byte
	if err := pool.QueryRow(ctx, `SELECT target_type, target_id, metadata
		FROM audit_logs WHERE org_id = $1 AND action = 'recovery.feedback' AND target_id = $2
		ORDER BY created_at DESC, id DESC LIMIT 1`, h.org, deadLetterID).Scan(
		&targetType, &targetID, &metadataJSON,
	); err != nil {
		t.Fatalf("read feedback audit: %v", err)
	}
	var metadata map[string]any
	_ = json.Unmarshal(metadataJSON, &metadata)
	if targetType != "dead_letter" || targetID != deadLetterID || metadata["suggestionMode"] != "ai" ||
		metadata["approachLabel"] != "add_retry" || metadata["accepted"] != true ||
		metadata["evalConsent"] != true {
		t.Fatalf("feedback audit mismatch: target=%s/%s metadata=%+v", targetType, targetID, metadata)
	}

	// A later rejection advances feedback freshness without erasing the
	// last accepted-fix clock.
	time.Sleep(time.Millisecond)
	res = h.call("POST", "/recovery/feedback", map[string]any{
		"deadLetterId": deadLetterID, "suggestionMode": "fallback",
		"approachLabel": "add_retry", "accepted": false,
	}, "")
	if res.status != 200 {
		t.Fatalf("record rejection: %d %+v", res.status, res.body)
	}
	var feedbackSeenAfter, acceptedSeenAfter time.Time
	_ = pool.QueryRow(ctx, `SELECT feedback_last_seen, accepted_fix_last_seen
		FROM recovery_feedback_health
		WHERE org_id = $1 AND workflow_id = $2 AND approach_label = 'add_retry'`,
		h.org, workflowID).Scan(&feedbackSeenAfter, &acceptedSeenAfter)
	if feedbackSeenAfter.Before(feedbackSeen) || !acceptedSeenAfter.Equal(acceptedSeen) {
		t.Fatalf("freshness clocks regressed: before=%s/%s after=%s/%s",
			feedbackSeen, acceptedSeen, feedbackSeenAfter, acceptedSeenAfter)
	}

	var memoryUsageAfter int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM usage_events
		WHERE org_id = $1 AND metric = 'memory.commit'`, h.org).Scan(&memoryUsageAfter)
	if memoryUsageAfter != memoryUsageBefore {
		t.Fatalf("memory-disabled feedback must have zero memory side effects: before=%d after=%d",
			memoryUsageBefore, memoryUsageAfter)
	}
}

func TestRecoveryFeedbackRejectsInvalidOrUntrustedInputs(t *testing.T) {
	t.Setenv("JANUSLY_MEMORY_ENABLED", "false")
	h := newAPIHarness(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	workflowID := "wf-feedback-validation-" + suffix
	deadLetterID := seedFeedbackDeadLetter(t, h.org, workflowID, suffix, true)
	valid := map[string]any{
		"deadLetterId": deadLetterID, "suggestionMode": "ai",
		"approachLabel": "other", "accepted": true,
	}

	cases := []struct {
		name string
		edit func(map[string]any)
	}{
		{name: "missing dead letter", edit: func(body map[string]any) { delete(body, "deadLetterId") }},
		{name: "long dead letter", edit: func(body map[string]any) { body["deadLetterId"] = strings.Repeat("x", 257) }},
		{name: "missing mode", edit: func(body map[string]any) { delete(body, "suggestionMode") }},
		{name: "unknown mode", edit: func(body map[string]any) { body["suggestionMode"] = "telepathy" }},
		{name: "unknown approach", edit: func(body map[string]any) { body["approachLabel"] = "guess" }},
		{name: "missing accepted", edit: func(body map[string]any) { delete(body, "accepted") }},
		{name: "null accepted", edit: func(body map[string]any) { body["accepted"] = nil }},
		{name: "long comment", edit: func(body map[string]any) { body["comment"] = strings.Repeat("x", 2001) }},
		{name: "null comment", edit: func(body map[string]any) { body["comment"] = nil }},
		{name: "long rationale", edit: func(body map[string]any) { body["rationale"] = strings.Repeat("x", 2001) }},
		{name: "null consent", edit: func(body map[string]any) { body["evalConsent"] = nil }},
		{name: "fractional confidence", edit: func(body map[string]any) { body["rawConfidence"] = 12.5 }},
		{name: "high confidence", edit: func(body map[string]any) { body["rawConfidence"] = 101 }},
		{name: "null confidence", edit: func(body map[string]any) { body["rawConfidence"] = nil }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := make(map[string]any, len(valid)+1)
			for key, value := range valid {
				body[key] = value
			}
			tc.edit(body)
			requireFeedbackError(t, h.call("POST", "/recovery/feedback", body, ""),
				400, "recovery_invalid_feedback_body")
		})
	}

	requireFeedbackError(t, h.call("POST", "/recovery/feedback", map[string]any{
		"deadLetterId": "missing", "suggestionMode": "ai",
		"approachLabel": "other", "accepted": true,
	}, ""), 404, "dlq_not_found")
	requireFeedbackError(t, h.call("POST", "/recovery/feedback", valid, "other-org-"+suffix),
		404, "dlq_not_found")

	adhocID := seedFeedbackDeadLetter(t, h.org, "adhoc", suffix+"-adhoc", false)
	requireFeedbackError(t, h.call("POST", "/recovery/feedback", map[string]any{
		"deadLetterId": adhocID, "suggestionMode": "playbook",
		"approachLabel": "other", "accepted": true,
	}, ""), 422, "recovery_feedback_saved_only")
}

func TestAcceptedRecoveryFeedbackSchedulesConsentedMemory(t *testing.T) {
	var embeddingCalls atomic.Int32
	embedding := make([]float64, 1024)
	embedding[0] = 1
	embeddingServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/embeddings" {
			http.NotFound(w, r)
			return
		}
		embeddingCalls.Add(1)
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"embedding": embedding})
	}))
	defer embeddingServer.Close()
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	t.Setenv("OLLAMA_BASE_URL", embeddingServer.URL)

	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	suffix := fmt.Sprint(time.Now().UnixNano())
	workflowID := "wf-feedback-memory-" + suffix
	deadLetterID := seedFeedbackDeadLetter(t, h.org, workflowID, suffix, true)
	if _, err := pool.Exec(ctx, `INSERT INTO org_configs
		(id, org_id, key, value_json, category, description, value_type)
		VALUES
		($1, $2, 'memory.enabled', 'true', 'memory', 'test', 'boolean'),
		($3, $2, 'memory.allowedKinds', to_jsonb($4::text), 'memory', 'test', 'string')`,
		"cfg-memory-on-"+suffix, h.org, "cfg-memory-kinds-"+suffix,
		"recovery_rationale,patch_rationale"); err != nil {
		t.Fatalf("enable memory: %v", err)
	}

	res := h.call("POST", "/recovery/feedback", map[string]any{
		"deadLetterId": deadLetterID, "suggestionMode": "ai",
		"approachLabel": "add_retry", "accepted": true,
		"comment":   "works with sk-" + strings.Repeat("a", 24),
		"rationale": "Bearer " + strings.Repeat("b", 20) + " should never persist",
	}, "")
	if res.status != 200 {
		t.Fatalf("accepted feedback: %d %+v", res.status, res.body)
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		var count int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM memory_entries
			WHERE org_id = $1 AND workflow_id = $2 AND run_id IS NOT NULL`,
			h.org, workflowID).Scan(&count)
		if count == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("background memory commits did not converge: count=%d calls=%d",
				count, embeddingCalls.Load())
		}
		time.Sleep(20 * time.Millisecond)
	}
	if embeddingCalls.Load() != 2 {
		t.Fatalf("one embedding per consented memory kind: %d", embeddingCalls.Load())
	}

	rows, err := pool.Query(ctx, `SELECT kind, content, metadata FROM memory_entries
		WHERE org_id = $1 AND workflow_id = $2 ORDER BY kind`, h.org, workflowID)
	if err != nil {
		t.Fatalf("read memories: %v", err)
	}
	defer rows.Close()
	seen := map[string]bool{}
	for rows.Next() {
		var kind, content string
		var metadata []byte
		if err := rows.Scan(&kind, &content, &metadata); err != nil {
			t.Fatalf("scan memory: %v", err)
		}
		if strings.Contains(content, "sk-") || strings.Contains(content, "Bearer ") ||
			!strings.Contains(content, "[redacted]") {
			t.Fatalf("memory content was not scrubbed: kind=%s content=%q", kind, content)
		}
		var projected map[string]any
		_ = json.Unmarshal(metadata, &projected)
		if projected["deadLetterId"] != deadLetterID || projected["approachLabel"] != "add_retry" {
			t.Fatalf("memory metadata: kind=%s metadata=%+v", kind, projected)
		}
		seen[kind] = true
	}
	if !seen["recovery_rationale"] || !seen["patch_rationale"] {
		t.Fatalf("both accepted-feedback memories required: %+v", seen)
	}
}

func TestFeedbackMemorySaturationKeepsPrimaryFeedbackAccepted(t *testing.T) {
	var embeddingCalls atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	var startedOnce sync.Once
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	embedding := make([]float64, 1024)
	embedding[0] = 1
	embeddingServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/embeddings" {
			http.NotFound(w, r)
			return
		}
		embeddingCalls.Add(1)
		startedOnce.Do(func() { close(started) })
		select {
		case <-release:
			w.Header().Set("content-type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"embedding": embedding})
		case <-r.Context().Done():
		}
	}))
	defer embeddingServer.Close()
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	t.Setenv("OLLAMA_BASE_URL", embeddingServer.URL)

	options := DefaultV1ServerOptions()
	options.FeedbackMemoryWorkers = 1
	options.FeedbackMemoryQueueCapacity = 1
	options.FeedbackMemoryTaskTimeout = 30 * time.Second
	options.Logger = quietTestLogger()
	h := newAPIHarnessWithOptions(t, true, options)
	pool := testPool(t)
	ctx := t.Context()
	suffix := fmt.Sprint(time.Now().UnixNano())
	if _, err := pool.Exec(ctx, `INSERT INTO org_configs
		(id, org_id, key, value_json, category, description, value_type)
		VALUES
		($1, $2, 'memory.enabled', 'true', 'memory', 'test', 'boolean'),
		($3, $2, 'memory.allowedKinds', to_jsonb('recovery_rationale'::text), 'memory', 'test', 'string')`,
		"cfg-memory-saturation-on-"+suffix, h.org, "cfg-memory-saturation-kinds-"+suffix); err != nil {
		t.Fatalf("enable memory: %v", err)
	}

	workflowPrefix := "wf-feedback-saturation-" + suffix + "-"
	deadLetters := make([]string, 3)
	for index := range deadLetters {
		deadLetters[index] = seedFeedbackDeadLetter(t, h.org, workflowPrefix+fmt.Sprint(index),
			suffix+"-"+fmt.Sprint(index), true)
	}
	first := h.call("POST", "/recovery/feedback", map[string]any{
		"deadLetterId": deadLetters[0], "suggestionMode": "ai",
		"approachLabel": "add_retry", "accepted": true,
	}, "")
	if first.status != http.StatusOK {
		t.Fatalf("first feedback: %d %+v", first.status, first.body)
	}
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("first feedback memory task did not start")
	}
	for index := 1; index < 3; index++ {
		response := h.call("POST", "/recovery/feedback", map[string]any{
			"deadLetterId": deadLetters[index], "suggestionMode": "ai",
			"approachLabel": "add_retry", "accepted": true,
		}, "")
		if response.status != http.StatusOK || response.body["ok"] != true {
			t.Fatalf("feedback %d must survive optional-memory saturation: %d %+v",
				index, response.status, response.body)
		}
	}
	var feedbackRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM recovery_feedback
		WHERE org_id = $1 AND workflow_id LIKE $2`, h.org, workflowPrefix+"%").Scan(&feedbackRows); err != nil {
		t.Fatalf("count durable feedback: %v", err)
	}
	if feedbackRows != 3 {
		t.Fatalf("primary feedback was lost under saturation: %d", feedbackRows)
	}

	releaseOnce.Do(func() { close(release) })
	deadline := time.Now().Add(5 * time.Second)
	for {
		var memoryRows int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM memory_entries
			WHERE org_id = $1 AND workflow_id LIKE $2`, h.org, workflowPrefix+"%").Scan(&memoryRows)
		if memoryRows == 2 && embeddingCalls.Load() == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("bounded optional memory did not converge: rows=%d calls=%d",
				memoryRows, embeddingCalls.Load())
		}
		time.Sleep(20 * time.Millisecond)
	}
}
