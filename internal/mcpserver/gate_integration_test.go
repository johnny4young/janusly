//go:build integration

package mcpserver

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/httpapi/publishrequests"
	"github.com/johnny4young/janusly/internal/httpkit"
)

// personRoutes mounts feature routes as a signed-in person, so the test drives
// the real handlers without the API's resolver chain.
type personRoutes struct{}

func (personRoutes) Route(mux *http.ServeMux, pattern string, _ httpkit.Gate, handler httpkit.HandlerFunc) {
	mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		org, user := r.Header.Get("x-org-id"), r.Header.Get("x-user-id")
		handler(w, r, httpkit.Request{OrgID: org, UserID: user,
			Auth: &auth.Context{OrgID: org, UserID: user, Mode: auth.ModeDevHeaders, Source: auth.SourceWeb}})
	})
}

func gateCall(t *testing.T, session *mcp.ClientSession, tool string, args map[string]any) (bool, map[string]any, string) {
	t.Helper()
	res, payload := callTool(t, session, tool, args)
	return !res.IsError, payload, resultText(res)
}

func waitQualification(t *testing.T, session *mcp.ClientSession, id string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		ok, payload, text := gateCall(t, session, "qualifications.get", map[string]any{"qualificationId": id})
		if !ok {
			t.Fatalf("qualifications.get: %s", text)
		}
		if payload["status"] != "running" {
			return payload
		}
		if time.Now().After(deadline) {
			t.Fatalf("qualification %s never settled: %v", id, payload)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// uppercaseDraft varies only the declared output, a logic change that keeps
// the outbound surface, so a qualified revision publishes without a person.
func uppercaseDraft(suffix string, withContract bool) map[string]any {
	document := map[string]any{
		"name": "Shout", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "upper", "type": "tool", "config": map[string]any{
			"tool": "text.uppercase", "input": map[string]any{"value": "{{context.input.text}}"},
		}}},
		"edges": []any{},
	}
	if withContract {
		document["outputs"] = map[string]any{"text": "{{context.upper.output.result.value}}" + suffix}
	}
	return document
}

func shoutFixture(expected string) []any {
	return []any{map[string]any{"name": "shouts", "input": map[string]any{"text": "hi"},
		"expect": map[string]any{"status": "succeeded", "output": map[string]any{"text": expected}}}}
}

func TestAgentPublishesThroughTheGate(t *testing.T) {
	pool, eng := agentTestPool(t)
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stopWorkers := context.WithCancel(context.Background())
	workersDone := make(chan struct{})
	go func() {
		defer close(workersDone)
		_ = eng.RunWorkers(workerCtx, 2, 30*time.Millisecond, dispatcher.Execute, slog.New(slog.NewTextHandler(io.Discard, nil)))
	}()
	t.Cleanup(func() { stopWorkers(); <-workersDone })

	tenant := seedAgentTenant(t, pool, eng, "gate")
	reviewer := "reviewer-" + uuid.NewString()[:8]
	if _, err := pool.Exec(t.Context(), `INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, 'editor')`,
		uuid.NewString(), tenant.org, reviewer); err != nil {
		t.Fatal(err)
	}
	issued := issueAgentClient(t, pool, tenant, agentclient.IssueInput{Capabilities: []string{"propose", "test", "publish"}})
	session := agentSession(t, pool, eng, issued.Token)
	mux := http.NewServeMux()
	publishrequests.Mount(mux, publishrequests.Deps{Pool: pool, Engine: eng, Audit: audit.Writer{}, Routes: personRoutes{}})
	people := httptest.NewServer(mux)
	t.Cleanup(people.Close)
	decide := func(user, requestID, verb string) (int, map[string]any) {
		t.Helper()
		req, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, people.URL+"/publish-requests/"+requestID+"/"+verb, nil)
		req.Header.Set("x-org-id", tenant.org)
		req.Header.Set("x-user-id", user)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = res.Body.Close() }()
		var body map[string]any
		_ = json.NewDecoder(res.Body).Decode(&body)
		return res.StatusCode, body
	}

	// A draft without a contract or fixtures fails the gate with repairable checks.
	ok, saved, text := gateCall(t, session, "drafts.save", map[string]any{"workflow": uppercaseDraft("", false)})
	if !ok || saved["newWorkflow"] != true || !strings.HasPrefix(saved["workflowId"].(string), "wf_") {
		t.Fatalf("drafts.save: %s", text)
	}
	workflowID := saved["workflowId"].(string)
	ok, receipt, text := gateCall(t, session, "workflows.qualify", map[string]any{"draftId": saved["draftId"]})
	raw, _ := json.Marshal(receipt["checks"])
	if !ok || receipt["status"] != "failed" || !strings.Contains(string(raw), "intent_missing") || !strings.Contains(string(raw), "fixtures_missing") {
		t.Fatalf("an incomplete draft passed the gate: %s %s", text, raw)
	}
	if ok, _, text := gateCall(t, session, "workflows.publish", map[string]any{"draftId": saved["draftId"], "qualificationId": receipt["qualificationId"]}); ok || !strings.Contains(text, "qualification_failed") {
		t.Fatalf("a failed qualification published: %s", text)
	}

	// The repaired draft of the same new workflow qualifies through a real fixture run.
	ok, repaired, text := gateCall(t, session, "drafts.save", map[string]any{
		"workflowId": workflowID, "workflow": uppercaseDraft("", true), "fixtures": shoutFixture("HI"),
	})
	if !ok || repaired["workflowId"] != workflowID {
		t.Fatalf("revising the new workflow's draft: %s", text)
	}
	_, receipt, _ = gateCall(t, session, "workflows.qualify", map[string]any{"draftId": repaired["draftId"]})
	if settled := waitQualification(t, session, receipt["qualificationId"].(string)); settled["status"] != "passed" {
		t.Fatalf("a sound draft failed the gate: %v", settled)
	}

	// A first publication waits for a person; the agent cannot publish it alone.
	ok, published, text := gateCall(t, session, "workflows.publish", map[string]any{"draftId": repaired["draftId"], "qualificationId": receipt["qualificationId"]})
	if !ok || published["status"] != "approval_required" || !strings.Contains(text, "first_publish") {
		t.Fatalf("first publication: %s", text)
	}
	requestID := published["publishRequestId"].(string)
	if versions := countVersions(t, pool, tenant.org, workflowID); versions != 0 {
		t.Fatalf("a version exists before approval: %d", versions)
	}
	if status, body := decide(tenant.creator, requestID, "approve"); status != http.StatusOK {
		t.Fatalf("creator approval: %d %v", status, body)
	}
	if _, status, _ := gateCall(t, session, "publish.status", map[string]any{"publishRequestId": requestID}); status["status"] != "published" || status["versionId"] == nil {
		t.Fatalf("publish.status after approval: %v", status)
	}
	var author string
	if err := pool.QueryRow(t.Context(), `SELECT created_by FROM workflow_versions WHERE org_id = $1 AND workflow_id = $2`,
		tenant.org, workflowID).Scan(&author); err != nil || author != tenant.creator {
		t.Fatalf("the approver did not author the version: %q %v", author, err)
	}

	// Two drafts on version 1: the first read-only change publishes at once,
	// the second is refused because publishing it would undo the first.
	_, first, _ := gateCall(t, session, "drafts.save", map[string]any{
		"workflowId": workflowID, "workflow": uppercaseDraft("!", true), "fixtures": shoutFixture("HI!"),
	})
	_, second, _ := gateCall(t, session, "drafts.save", map[string]any{
		"workflowId": workflowID, "workflow": uppercaseDraft("?", true), "fixtures": shoutFixture("HI?"),
	})
	_, firstReceipt, _ := gateCall(t, session, "workflows.qualify", map[string]any{"draftId": first["draftId"]})
	_, secondReceipt, _ := gateCall(t, session, "workflows.qualify", map[string]any{"draftId": second["draftId"]})
	waitQualification(t, session, firstReceipt["qualificationId"].(string))
	waitQualification(t, session, secondReceipt["qualificationId"].(string))
	ok, direct, text := gateCall(t, session, "workflows.publish", map[string]any{"draftId": first["draftId"], "qualificationId": firstReceipt["qualificationId"]})
	if !ok || direct["status"] != "published" {
		t.Fatalf("a qualified read-only change waited for a person: %s", text)
	}
	if ok, _, text := gateCall(t, session, "workflows.publish", map[string]any{"draftId": second["draftId"], "qualificationId": secondReceipt["qualificationId"]}); ok || !strings.Contains(text, "changed since this draft") {
		t.Fatalf("a stale draft overwrote a newer version: %s", text)
	}

	// A fixture the workflow does not satisfy fails the receipt.
	_, wrong, _ := gateCall(t, session, "drafts.save", map[string]any{
		"workflowId": workflowID, "workflow": uppercaseDraft("", true), "fixtures": shoutFixture("hello"),
	})
	_, wrongReceipt, _ := gateCall(t, session, "workflows.qualify", map[string]any{"draftId": wrong["draftId"]})
	settled := waitQualification(t, session, wrongReceipt["qualificationId"].(string))
	raw, _ = json.Marshal(settled["checks"])
	if settled["status"] != "failed" || !strings.Contains(string(raw), "fixture_failed") {
		t.Fatalf("a failing fixture passed: %v", settled)
	}

	// With a second person required, the creator cannot approve alone.
	if _, err := pool.Exec(t.Context(), `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
		VALUES ($1, $2, $3, 'true', 'agents', 'test', 'boolean')`, uuid.NewString(), tenant.org, publishrequests.SecondPersonKey); err != nil {
		t.Fatal(err)
	}
	_, fresh, _ := gateCall(t, session, "drafts.save", map[string]any{"workflow": uppercaseDraft("", true), "fixtures": shoutFixture("HI")})
	_, freshReceipt, _ := gateCall(t, session, "workflows.qualify", map[string]any{"draftId": fresh["draftId"]})
	waitQualification(t, session, freshReceipt["qualificationId"].(string))
	_, pending, _ := gateCall(t, session, "workflows.publish", map[string]any{"draftId": fresh["draftId"], "qualificationId": freshReceipt["qualificationId"]})
	freshRequest := pending["publishRequestId"].(string)
	if status, body := decide(tenant.creator, freshRequest, "approve"); status != http.StatusForbidden {
		t.Fatalf("the creator approved alone despite the setting: %d %v", status, body)
	}
	if status, body := decide(reviewer, freshRequest, "reject"); status != http.StatusOK || body["request"].(map[string]any)["status"] != "rejected" {
		t.Fatalf("a second person's rejection: %d %v", status, body)
	}
	if status, _ := decide(reviewer, freshRequest, "approve"); status != http.StatusConflict {
		t.Fatalf("a settled request was decided again: %d", status)
	}
}

func countVersions(t *testing.T, pool *pgxpool.Pool, org, workflowID string) int {
	t.Helper()
	var count int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM workflow_versions WHERE org_id = $1 AND workflow_id = $2`, org, workflowID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}
