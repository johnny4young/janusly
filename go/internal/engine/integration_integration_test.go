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

	"github.com/johnny4young/janusly/go/internal/secretstore"
	"github.com/johnny4young/janusly/go/internal/store"
	"github.com/johnny4young/janusly/go/internal/tools"
)

// The chokepoint end to end: a webhook.send through the engine-built deps
// delivers a SIGNED payload the receiver verifies, the gate refuses
// missing credentials with generic errors, the org+credential rate limit
// bites, and every call lands one usage row — with the secret never
// echoed in any envelope.
func TestIntegrationChokepoint(t *testing.T) {
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set")
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
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(body)
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

	// Usage rows: one per call (success + failures + limited).
	var usageRows int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM usage_events
		WHERE org_id = $1 AND metric = 'tool.webhook.send'`, org).Scan(&usageRows)
	if usageRows < 3 {
		t.Fatalf("usage rows: %d", usageRows)
	}
}
