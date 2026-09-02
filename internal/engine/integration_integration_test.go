//go:build integration

package engine

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/secretstore"
	"github.com/johnny4young/janusly/internal/store"
	"github.com/johnny4young/janusly/internal/tools"
)

// The chokepoint end to end: a webhook.send through the engine-built deps
// delivers a SIGNED payload the receiver verifies, the gate refuses
// missing credentials with generic errors, the org+credential rate limit
// bites, and every call lands one usage row — with the secret never
// echoed in any envelope.
func TestIntegrationChokepoint(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	secretstore.ResetForTests()
	t.Cleanup(secretstore.ResetForTests)
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY",
		base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()
	eng := New(pool)
	q := store.New(pool)
	org := fmt.Sprintf("org-chokepoint-%d", time.Now().UnixNano())
	secretValue := "whsec-super-secret-" + org

	// Managed credential of kind webhook_secret.
	credID := "cred-" + org
	if err := q.InsertCredential(ctx, store.InsertCredentialParams{
		ID: credID, OrgID: org, Name: "partner-hook", Kind: "webhook_secret", SecretRef: "PLACEHOLDER",
		CreatedBy: pgtype.Text{String: "test", Valid: true},
	}); err != nil {
		t.Fatalf("credential: %v", err)
	}
	_, _, secretRef, err := secretstore.CreateCredentialSecretVersion(ctx, q, struct {
		ID           string
		OrgID        string
		CredentialID string
		SecretValue  string
		CreatedBy    string
	}{OrgID: org, CredentialID: credID, SecretValue: secretValue})
	if err != nil {
		t.Fatalf("secret: %v", err)
	}
	if err := q.UpdateCredentialSecretRef(ctx, store.UpdateCredentialSecretRefParams{
		OrgID: org, ID: credID, SecretRef: secretRef,
	}); err != nil {
		t.Fatalf("ref: %v", err)
	}

	// Receiver verifies the Stripe-style signature over the EXACT body.
	var mu sync.Mutex
	verified, received := false, 0
	githubAuth, githubPath, githubTitle := "", "", ""
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(body)
		if strings.HasPrefix(r.URL.Path, "/github/repos/") {
			var payload map[string]any
			_ = json.Unmarshal(body, &payload)
			mu.Lock()
			githubAuth, githubPath = r.Header.Get("authorization"), r.URL.Path
			githubTitle, _ = payload["title"].(string)
			mu.Unlock()
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"number":42,"html_url":"https://github.example/issues/42"}`))
			return
		}
		signature := r.Header.Get("x-janusly-signature")
		mu.Lock()
		received++
		var timestamp int64
		var hexPart string
		if _, err := fmt.Sscanf(signature, "t=%d,v1=%s", &timestamp, &hexPart); err == nil {
			if signature == tools.SignWebhookPayload(secretValue, string(body), timestamp) {
				verified = true
			}
		}
		mu.Unlock()
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer receiver.Close()

	deps := eng.buildIntegrationDeps(org, "run-x", "node-x")
	input := map[string]any{
		"credential": "partner-hook", "url": receiver.URL,
		"payload": map[string]any{"event": "incident", "severity": "high"},
		"headers": map[string]any{"x-idempotency-key": "abc-1"},
	}
	result := tools.ExecuteIntegrationTool(ctx, "webhook.send", input, deps)
	if result["ok"] != true {
		t.Fatalf("send: %+v", result)
	}
	mu.Lock()
	if !verified || received != 1 {
		mu.Unlock()
		t.Fatalf("receiver must verify the signature: verified=%v received=%d", verified, received)
	}
	mu.Unlock()

	// GitHub rides the identical gate/egress/usage chokepoint, uses the
	// contract catalog key for its tenant rate override, and rewrites only
	// behind the explicit local simulator gate.
	githubCredentialID := "cred-github-" + org
	githubSecret := "github-super-secret-" + org
	if err := q.InsertCredential(ctx, store.InsertCredentialParams{
		ID: githubCredentialID, OrgID: org, Name: "bot-github", Kind: "github_token", SecretRef: "PLACEHOLDER",
		CreatedBy: pgtype.Text{String: "test", Valid: true},
	}); err != nil {
		t.Fatalf("github credential: %v", err)
	}
	_, _, githubSecretRef, err := secretstore.CreateCredentialSecretVersion(ctx, q, struct {
		ID           string
		OrgID        string
		CredentialID string
		SecretValue  string
		CreatedBy    string
	}{OrgID: org, CredentialID: githubCredentialID, SecretValue: githubSecret})
	if err != nil {
		t.Fatalf("github secret: %v", err)
	}
	if err := q.UpdateCredentialSecretRef(ctx, store.UpdateCredentialSecretRefParams{
		OrgID: org, ID: githubCredentialID, SecretRef: githubSecretRef,
	}); err != nil {
		t.Fatalf("github ref: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO org_configs
		(id, org_id, key, value_json, category, description, value_type, updated_at)
		VALUES ($1, $2, 'github.rateLimitPerMin', '17'::jsonb, 'integrations', 'test', 'number', now())`,
		"cfg-github-"+org, org); err != nil {
		t.Fatalf("github rate config: %v", err)
	}
	if got := deps.RateLimitPerMin("github", 60); got != 17 {
		t.Fatalf("github tenant rate limit: %d", got)
	}
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL", receiver.URL)
	githubResult := tools.ExecuteIntegrationTool(ctx, "github.create_issue", map[string]any{
		"credential": "bot-github", "owner": "acme", "repo": "incidents", "title": "Incident",
	}, deps)
	if githubResult["ok"] != true || githubResult["issueNumber"] != float64(42) {
		t.Fatalf("github create issue: %+v", githubResult)
	}
	mu.Lock()
	if githubAuth != "Bearer "+githubSecret || githubPath != "/github/repos/acme/incidents/issues" || githubTitle != "Incident" {
		mu.Unlock()
		t.Fatalf("github request: auth=%q path=%q title=%q", githubAuth, githubPath, githubTitle)
	}
	mu.Unlock()

	// Gate failures: unknown credential and unresolvable secret — generic
	// messages, and the envelope never carries the secret.
	missing := tools.ExecuteIntegrationTool(ctx, "webhook.send", map[string]any{
		"credential": "ghost", "url": receiver.URL, "payload": map[string]any{},
	}, deps)
	if missing["ok"] != false || missing["error"] != "credential not found: ghost" {
		t.Fatalf("missing credential: %+v", missing)
	}
	raw, _ := json.Marshal(result)
	rawMissing, _ := json.Marshal(missing)
	if strings.Contains(string(raw)+string(rawMissing), secretValue) {
		t.Fatal("secret leaked into an envelope")
	}

	// The org+credential rate limit bites (tiny env bound).
	t.Setenv("JANUSLY_WEBHOOK_RATE_LIMIT_PER_MIN", "2")
	limited := false
	for i := 0; i < 4; i++ {
		result := tools.ExecuteIntegrationTool(ctx, "webhook.send", input, deps)
		if result["ok"] == false {
			if message, _ := result["error"].(string); strings.Contains(strings.ToLower(message), "rate") {
				limited = true
				break
			}
		}
	}
	if !limited {
		t.Fatal("rate limit never bit")
	}

	// Expiry is checked again at the final effect chokepoint. A workflow saved
	// while the credential was valid cannot keep using its secret afterward.
	mu.Lock()
	receivedBeforeExpiry := received
	mu.Unlock()
	if _, err := pool.Exec(ctx, `UPDATE credentials SET expires_at=$1 WHERE org_id=$2 AND id=$3`,
		eng.now().UTC().Add(-time.Second), org, credID); err != nil {
		t.Fatalf("expire credential: %v", err)
	}
	expired := tools.ExecuteIntegrationTool(ctx, "webhook.send", input, deps)
	if expired["ok"] != false || expired["error"] != "credential expired: partner-hook" {
		t.Fatalf("expired credential: %+v", expired)
	}
	mu.Lock()
	if received != receivedBeforeExpiry {
		mu.Unlock()
		t.Fatalf("expired credential reached provider: before=%d after=%d", receivedBeforeExpiry, received)
	}
	mu.Unlock()

	// Usage rows: one per call (success + failures + limited).
	var usageRows int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM usage_events
		WHERE org_id = $1 AND metric = 'tool.webhook.send'`, org).Scan(&usageRows)
	if usageRows < 3 {
		t.Fatalf("usage rows: %d", usageRows)
	}
	var githubUsageRows int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM usage_events
		WHERE org_id = $1 AND metric = 'tool.github.create_issue'`, org).Scan(&githubUsageRows)
	if githubUsageRows != 1 {
		t.Fatalf("github usage rows: %d", githubUsageRows)
	}
}
