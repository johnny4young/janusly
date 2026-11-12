//go:build integration

package agentsessions

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/agentsession"
	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/hookwire"
	"github.com/johnny4young/janusly/internal/mcpserver"
	"github.com/johnny4young/janusly/internal/ratelimit"
	"github.com/johnny4young/janusly/internal/store"
)

type tenant struct{ org, creator string }

type ingestHarness struct {
	pool     *pgxpool.Pool
	endpoint string
}

func newIngestHarness(t *testing.T, limiter bool) ingestHarness {
	t.Helper()
	if os.Getenv("JANUSLY_DATABASE_URL") == "" {
		t.Skip("JANUSLY_DATABASE_URL not set; run through `make test`")
	}
	pool, err := pgxpool.New(context.Background(), os.Getenv("JANUSLY_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var rl *ratelimit.Limiter
	if limiter {
		rl = ratelimit.New(pool, ratelimit.Hooks{})
	}
	handler := mcpserver.GuardAgentHTTP(mcpserver.AgentAuth(mcpserver.Deps{
		Audit: audit.NewWriter(grammar.Persister{}), Pool: pool, Limiter: rl, Transport: "hooks",
	}, Ingest(IngestDeps{Pool: pool, Limiter: rl, NewID: uuid.NewString})), mcpserver.HTTPOptions{})
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return ingestHarness{pool: pool, endpoint: server.URL + hookwire.Path}
}

func seedTenant(t *testing.T, pool *pgxpool.Pool, label string) tenant {
	t.Helper()
	suffix := uuid.NewString()[:8]
	tn := tenant{org: "hooks-" + label + "-" + suffix, creator: label + "-creator-" + suffix}
	if _, err := pool.Exec(t.Context(), `INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, 'editor')`,
		uuid.NewString(), tn.org, tn.creator); err != nil {
		t.Fatal(err)
	}
	return tn
}

func issue(t *testing.T, pool *pgxpool.Pool, tn tenant, capabilities ...string) agentclient.Issued {
	t.Helper()
	q := store.New(pool)
	held, err := agentclient.CreatorPermissions(t.Context(), q, tn.org, tn.creator)
	if err != nil || held == nil {
		t.Fatalf("creator permissions: %v %v", held, err)
	}
	issued, err := agentclient.Issue(t.Context(), q, uuid.NewString(), time.Now(), agentclient.IssueInput{
		OrgID: tn.org, CreatedBy: tn.creator, Name: "bridge", Capabilities: capabilities,
	}, held)
	if err != nil {
		t.Fatal(err)
	}
	return issued
}

type wireEvent struct {
	eventType string
	data      map[string]any
	at        time.Time
}

func (e wireEvent) body(t *testing.T) []byte {
	t.Helper()
	at := e.at
	if at.IsZero() {
		at = time.Now()
	}
	raw, err := json.Marshal(map[string]any{
		"specversion": "1.0", "id": hookwire.EventID(fmt.Sprint(e.data), e.eventType),
		"source": hookwire.Source(hookwire.RuntimeClaudeCode), "type": e.eventType,
		"time": at.UTC().Format(time.RFC3339Nano), "data": e.data,
	})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

type reply struct {
	status int
	body   map[string]any
	raw    string
}

func (h ingestHarness) post(t *testing.T, token string, body []byte, sign func([]byte) string) reply {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, h.endpoint, strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if sign != nil {
		req.Header.Set(hookwire.SignatureHeader, sign(body))
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(res.Body)
	out := reply{status: res.StatusCode, raw: string(raw)}
	_ = json.Unmarshal(raw, &out.body)
	return out
}

func signedBy(token string) func([]byte) string {
	return func(body []byte) string {
		return hookwire.Sign(hookwire.SigningKeyFromToken(token), time.Now().Unix(), body)
	}
}

func (h ingestHarness) send(t *testing.T, token string, event wireEvent) reply {
	t.Helper()
	return h.post(t, token, event.body(t), signedBy(token))
}

func TestIngestRecordsAnOrderedSessionAndStoresARetryOnce(t *testing.T) {
	h := newIngestHarness(t, false)
	tn := seedTenant(t, h.pool, "a")
	token := issue(t, h.pool, tn, "report").Token
	session := "sess-" + uuid.NewString()

	started := h.send(t, token, wireEvent{eventType: hookwire.TypeSessionStarted,
		data: map[string]any{"sessionId": session, "project": "billing", "runtimeVersion": "2.1.0", "model": "opus"}})
	if started.status != http.StatusAccepted || started.body["outcome"] != "applied" || started.body["duplicate"] != false {
		t.Fatalf("session.started: %d %s", started.status, started.raw)
	}
	tool := wireEvent{eventType: hookwire.TypeToolCompleted, data: map[string]any{
		"sessionId": session, "toolUseId": "t1", "tool": "mcp__janusly__runs.start", "toolKind": "mcp",
		"mcpServer": "janusly", "status": "ok", "durationMs": 42, "januslyRefs": map[string]any{"runId": "run_1"},
	}}
	if res := h.send(t, token, tool); res.status != http.StatusAccepted {
		t.Fatalf("tool.completed: %d %s", res.status, res.raw)
	}
	retry := h.send(t, token, tool)
	if retry.status != http.StatusOK || retry.body["duplicate"] != true || retry.body["outcome"] != "applied" {
		t.Fatalf("a retried hook was not a duplicate: %d %s", retry.status, retry.raw)
	}
	ended := h.send(t, token, wireEvent{eventType: hookwire.TypeSessionEnded, data: map[string]any{"sessionId": session, "status": "ok"}})
	if ended.status != http.StatusAccepted {
		t.Fatalf("session.ended: %d %s", ended.status, ended.raw)
	}

	var status, project, model string
	var events, lastSeq int64
	if err := h.pool.QueryRow(t.Context(), `SELECT status, project, model, event_count, last_seq FROM agent_sessions
		WHERE org_id = $1 AND external_session_id = $2`, tn.org, session).Scan(&status, &project, &model, &events, &lastSeq); err != nil {
		t.Fatal(err)
	}
	if status != "ended" || project != "billing" || model != "opus" || events != 3 || lastSeq != 3 {
		t.Fatalf("projection: %s %s %s %d %d", status, project, model, events, lastSeq)
	}
	var seqs, refs string
	if err := h.pool.QueryRow(t.Context(), `SELECT string_agg(seq::text, ',' ORDER BY seq), coalesce(string_agg(janusly_refs::text, ''), '')
		FROM agent_session_events e JOIN agent_sessions s ON s.id = e.session_id WHERE s.external_session_id = $1`, session).Scan(&seqs, &refs); err != nil {
		t.Fatal(err)
	}
	if seqs != "1,2,3" || !strings.Contains(refs, "run_1") {
		t.Fatalf("events: seq %s refs %s", seqs, refs)
	}
}

func TestIngestRefusesBadCredentialsSignaturesAndBodies(t *testing.T) {
	h := newIngestHarness(t, false)
	tn := seedTenant(t, h.pool, "a")
	reporter := issue(t, h.pool, tn, "report").Token
	reader := issue(t, h.pool, tn, "read").Token
	event := wireEvent{eventType: hookwire.TypeTurnStopped, data: map[string]any{"sessionId": "s-" + uuid.NewString()}}
	body := event.body(t)

	cases := []struct {
		name   string
		token  string
		body   []byte
		sign   func([]byte) string
		status int
		code   string
	}{
		{"no token", "", body, signedBy(reporter), 401, ""},
		{"unknown token", "jly_agent_" + strings.Repeat("Z", 43), body, signedBy(reporter), 401, ""},
		{"no report capability", reader, body, signedBy(reader), 403, "agent_capability_missing"},
		{"no signature", reporter, body, nil, 401, "agent_session_invalid_signature"},
		{"signed with another token", reporter, body, signedBy(reader), 401, "agent_session_invalid_signature"},
		{"signed outside the window", reporter, body, func(b []byte) string {
			return hookwire.Sign(hookwire.SigningKeyFromToken(reporter), time.Now().Add(-6*time.Minute).Unix(), b)
		}, 401, "agent_session_invalid_signature"},
		{"signature over another body", reporter, body, func([]byte) string {
			return signedBy(reporter)([]byte(`{}`))
		}, 401, "agent_session_invalid_signature"},
		{"strict schema", reporter, []byte(strings.Replace(string(body), `"sessionId"`, `"cwd":"/Users/me","sessionId"`, 1)), signedBy(reporter), 400, "agent_session_invalid_event"},
		{"too large", reporter, []byte(`{"pad":"` + strings.Repeat("x", hookwire.MaxBodyBytes) + `"}`), signedBy(reporter), 413, ""},
	}
	for _, tc := range cases {
		res := h.post(t, tc.token, tc.body, tc.sign)
		if res.status != tc.status || (tc.code != "" && res.body["code"] != tc.code) {
			t.Fatalf("%s: %d %s", tc.name, res.status, res.raw)
		}
		if strings.Contains(res.raw, reporter) || strings.Contains(res.raw, hookwire.SigningKeyFromToken(reporter)) {
			t.Fatalf("%s: response echoed credential material", tc.name)
		}
	}
	var stored int
	if err := h.pool.QueryRow(t.Context(), `SELECT count(*) FROM agent_sessions WHERE org_id = $1`, tn.org).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 0 {
		t.Fatalf("a refused event created %d sessions", stored)
	}
	var metadata string
	if err := h.pool.QueryRow(t.Context(), `SELECT coalesce(string_agg(metadata::text, ' '), '') FROM audit_logs
		WHERE action = 'mcp.auth.rejected' AND metadata->>'transport' = 'hooks'`).Scan(&metadata); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(metadata, "unknown") || strings.Contains(metadata, "jly_agent_") {
		t.Fatalf("rejection audit: %s", metadata)
	}
}

// Isolation: another organization, another client, a revoked or expired
// client and a removed creator never reach a session they did not report.
func TestIngestIsolationMatrix(t *testing.T) {
	h := newIngestHarness(t, false)
	a, b := seedTenant(t, h.pool, "a"), seedTenant(t, h.pool, "b")
	ownerA := issue(t, h.pool, a, "report")
	peerA := issue(t, h.pool, a, "report")
	clientB := issue(t, h.pool, b, "report")
	session := "shared-" + uuid.NewString()
	first := wireEvent{eventType: hookwire.TypePromptSubmitted, data: map[string]any{"sessionId": session}}
	if res := h.send(t, ownerA.Token, first); res.status != http.StatusAccepted {
		t.Fatalf("owner: %d %s", res.status, res.raw)
	}

	// Another client, same organization or not, gets its own session under the
	// same external id: it can neither end A's session nor learn it exists.
	takeover := wireEvent{eventType: hookwire.TypeSessionEnded, data: map[string]any{"sessionId": session, "status": "ok"}}
	for name, token := range map[string]string{"peer": peerA.Token, "org b": clientB.Token} {
		if res := h.send(t, token, takeover); res.status != http.StatusAccepted || res.body["duplicate"] != false {
			t.Fatalf("%s: %d %s", name, res.status, res.raw)
		}
	}
	// The same event id from another client is its own receipt, not a duplicate of A's.
	if res := h.send(t, clientB.Token, first); res.status != http.StatusAccepted || res.body["duplicate"] != false {
		t.Fatalf("org b replay of a's event: %d %s", res.status, res.raw)
	}
	rows := map[string]string{}
	result, err := h.pool.Query(t.Context(), `SELECT agent_client_id, org_id || ':' || status || ':' || event_count FROM agent_sessions WHERE external_session_id = $1`, session)
	if err != nil {
		t.Fatal(err)
	}
	for result.Next() {
		var client, row string
		if err := result.Scan(&client, &row); err != nil {
			t.Fatal(err)
		}
		rows[client] = row
	}
	if rows[ownerA.Client.ID] != a.org+":running:1" || rows[peerA.Client.ID] != a.org+":ended:1" ||
		rows[clientB.Client.ID] != b.org+":ended:2" || len(rows) != 3 {
		t.Fatalf("sessions crossed organizations or clients: %v", rows)
	}

	next := wireEvent{eventType: hookwire.TypeTurnStopped, data: map[string]any{"sessionId": session}}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.pool.Exec(t.Context(), sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`UPDATE agent_clients SET revoked_at = now(), revoked_by = 'x' WHERE id = $1`, peerA.Client.ID)
	if res := h.send(t, peerA.Token, next); res.status != http.StatusUnauthorized {
		t.Fatalf("revoked client: %d %s", res.status, res.raw)
	}
	exec(`UPDATE agent_clients SET token_issued_at = now() - interval '2 days', expires_at = now() - interval '1 second' WHERE id = $1`, clientB.Client.ID)
	if res := h.send(t, clientB.Token, next); res.status != http.StatusUnauthorized {
		t.Fatalf("expired client: %d %s", res.status, res.raw)
	}
	exec(`DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`, a.org, a.creator)
	if res := h.send(t, ownerA.Token, next); res.status != http.StatusUnauthorized {
		t.Fatalf("client of a removed creator: %d %s", res.status, res.raw)
	}
}

func TestIngestLimitsLiveSessionsTruncationAndStaleEvents(t *testing.T) {
	h := newIngestHarness(t, false)
	tn := seedTenant(t, h.pool, "a")
	client := issue(t, h.pool, tn, "report")
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.pool.Exec(t.Context(), sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	for i := range agentsession.MaxLiveSessionsPerClient {
		exec(`INSERT INTO agent_sessions (id, org_id, agent_client_id, external_session_id, runtime, started_at, last_event_at)
			VALUES ($1, $2, $3, $4, 'codex', now(), now())`, uuid.NewString(), tn.org, client.Client.ID, fmt.Sprintf("live-%d-%s", i, uuid.NewString()))
	}
	fresh := wireEvent{eventType: hookwire.TypePromptSubmitted, data: map[string]any{"sessionId": "one-too-many"}}
	if res := h.send(t, client.Token, fresh); res.status != http.StatusTooManyRequests || res.body["code"] != "agent_session_limit" {
		t.Fatalf("live session cap: %d %s", res.status, res.raw)
	}
	exec(`UPDATE agent_sessions SET last_event_at = now() - interval '31 minutes' WHERE agent_client_id = $1`, client.Client.ID)
	if res := h.send(t, client.Token, fresh); res.status != http.StatusAccepted {
		t.Fatalf("idle sessions still counted as live: %d %s", res.status, res.raw)
	}

	exec(`UPDATE agent_sessions SET truncated = true WHERE org_id = $1 AND external_session_id = 'one-too-many'`, tn.org)
	tool := wireEvent{eventType: hookwire.TypeToolRequested, data: map[string]any{"sessionId": "one-too-many", "tool": "Read", "toolKind": "builtin"}}
	if res := h.send(t, client.Token, tool); res.status != http.StatusConflict || res.body["code"] != "agent_session_truncated" {
		t.Fatalf("truncated session took a tool event: %d %s", res.status, res.raw)
	}
	stop := wireEvent{eventType: hookwire.TypeSessionEnded, data: map[string]any{"sessionId": "one-too-many", "status": "ok"}}
	if res := h.send(t, client.Token, stop); res.status != http.StatusAccepted {
		t.Fatalf("truncated session refused its closing event: %d %s", res.status, res.raw)
	}

	exec(`UPDATE agent_sessions SET ended_at = now() - interval '2 hours' WHERE org_id = $1 AND external_session_id = 'one-too-many'`, tn.org)
	var base int
	if err := h.pool.QueryRow(t.Context(), `SELECT event_count FROM agent_sessions WHERE org_id = $1 AND external_session_id = 'one-too-many'`, tn.org).Scan(&base); err != nil {
		t.Fatal(err)
	}
	late := wireEvent{eventType: hookwire.TypeTurnStopped, data: map[string]any{"sessionId": "one-too-many"}}
	res := h.send(t, client.Token, late)
	if res.status != http.StatusAccepted || res.body["outcome"] != "stale" {
		t.Fatalf("late event: %d %s", res.status, res.raw)
	}
	var count, lastSeq int
	if err := h.pool.QueryRow(t.Context(), `SELECT event_count, last_seq FROM agent_sessions WHERE org_id = $1 AND external_session_id = 'one-too-many'`,
		tn.org).Scan(&count, &lastSeq); err != nil {
		t.Fatal(err)
	}
	if count != base+1 || lastSeq != 2 {
		t.Fatalf("a stale event moved the order or escaped the cap: count %d (was %d), seq %d", count, base, lastSeq)
	}
	// Past the hard cap nothing is stored, closing or stale.
	exec(`UPDATE agent_sessions SET event_count = $2 WHERE org_id = $1 AND external_session_id = 'one-too-many'`,
		tn.org, agentsession.MaxEventsPerSession+50)
	again := wireEvent{eventType: hookwire.TypeSessionEnded, data: map[string]any{"sessionId": "one-too-many", "status": "error"}}
	if res := h.send(t, client.Token, again); res.status != http.StatusConflict {
		t.Fatalf("a full session still stored an event: %d %s", res.status, res.raw)
	}
}

func TestIngestBucketIsSeparateFromMCPTools(t *testing.T) {
	h := newIngestHarness(t, true)
	tn := seedTenant(t, h.pool, "a")
	client := issue(t, h.pool, tn, "report")
	session := "burst-" + uuid.NewString()
	var limited reply
	for i := range 2*clientBurst.Max + 1 {
		res := h.send(t, client.Token, wireEvent{eventType: hookwire.TypeToolRequested, data: map[string]any{
			"sessionId": session, "toolUseId": fmt.Sprint(i), "tool": "Read", "toolKind": "builtin",
		}})
		if res.status == http.StatusTooManyRequests {
			limited = res
			break
		}
	}
	if limited.status != http.StatusTooManyRequests || limited.body["code"] != "rate_limited" {
		t.Fatalf("burst never limited: %+v", limited)
	}
	var mcpBuckets int
	if err := h.pool.QueryRow(t.Context(), `SELECT count(*) FROM rate_limit_windows WHERE key = $1 AND name NOT LIKE 'agent.hooks.%'`,
		client.Client.ID).Scan(&mcpBuckets); err != nil {
		t.Fatal(err)
	}
	if mcpBuckets != 0 {
		t.Fatalf("hook events spent %d MCP buckets", mcpBuckets)
	}
}

func TestRetentionPurgesSilentSessionsWithTheirEvents(t *testing.T) {
	h := newIngestHarness(t, false)
	tn := seedTenant(t, h.pool, "a")
	client := issue(t, h.pool, tn, "report")
	old, fresh := "old-"+uuid.NewString(), "fresh-"+uuid.NewString()
	for _, session := range []string{old, fresh} {
		if res := h.send(t, client.Token, wireEvent{eventType: hookwire.TypeTurnStopped, data: map[string]any{"sessionId": session}}); res.status != http.StatusAccepted {
			t.Fatalf("seed %s: %d", session, res.status)
		}
	}
	if _, err := h.pool.Exec(t.Context(), `UPDATE agent_sessions SET last_event_at = now() - interval '15 days' WHERE external_session_id = $1`, old); err != nil {
		t.Fatal(err)
	}
	deleted, err := store.New(h.pool).DeleteExpiredAgentSessionsBatch(t.Context(), store.DeleteExpiredAgentSessionsBatchParams{
		Cutoff: time.Now().Add(-agentsession.Retention), BatchSize: 1000,
	})
	if err != nil || deleted < 1 {
		t.Fatalf("purge: %d %v", deleted, err)
	}
	var sessions, events int
	if err := h.pool.QueryRow(t.Context(), `SELECT
		(SELECT count(*) FROM agent_sessions WHERE org_id = $1),
		(SELECT count(*) FROM agent_session_events WHERE org_id = $1)`, tn.org).Scan(&sessions, &events); err != nil {
		t.Fatal(err)
	}
	if sessions != 1 || events != 1 {
		t.Fatalf("after purge: %d sessions, %d events", sessions, events)
	}
}

// One event id sent under two sessions at once is stored once; the loser is a
// duplicate and neither session gains a phantom event.
func TestIngestReusedEventIDAcrossSessionsIsStoredOnce(t *testing.T) {
	h := newIngestHarness(t, false)
	tn := seedTenant(t, h.pool, "a")
	client := issue(t, h.pool, tn, "report")
	id := hookwire.EventID("shared", uuid.NewString())
	body := func(session string) []byte {
		raw, _ := json.Marshal(map[string]any{
			"specversion": "1.0", "id": id, "source": hookwire.Source(hookwire.RuntimeCodex),
			"type": hookwire.TypeTurnStopped, "time": time.Now().UTC().Format(time.RFC3339Nano),
			"data": map[string]any{"sessionId": session},
		})
		return raw
	}
	replies := make(chan reply, 2)
	for _, session := range []string{"race-a-" + uuid.NewString(), "race-b-" + uuid.NewString()} {
		go func() { replies <- h.post(t, client.Token, body(session), signedBy(client.Token)) }()
	}
	duplicates := 0
	for range 2 {
		res := <-replies
		if res.status != http.StatusAccepted && res.status != http.StatusOK {
			t.Fatalf("race: %d %s", res.status, res.raw)
		}
		if res.body["duplicate"] == true {
			duplicates++
		}
	}
	var receipts, counted int
	if err := h.pool.QueryRow(t.Context(), `SELECT
		(SELECT count(*) FROM agent_session_events WHERE agent_client_id = $1),
		(SELECT coalesce(sum(event_count), 0) FROM agent_sessions WHERE agent_client_id = $1)`, client.Client.ID).Scan(&receipts, &counted); err != nil {
		t.Fatal(err)
	}
	if duplicates != 1 || receipts != 1 || counted != 1 {
		t.Fatalf("duplicates %d, receipts %d, counted %d", duplicates, receipts, counted)
	}
}
