//go:build integration

package engine

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/secretstore"
	"github.com/johnny4young/janusly/internal/store"
)

type templateCredential struct {
	name, kind, value string
	expired           bool
}

// The binaries build their dispatcher with empty RenderOptions, so this is the
// production resolution path for {{secret.X}}.
func TestTemplateSecretsResolveOptedInCredentials(t *testing.T) {
	ctx, pool, eng, org := newTemplateSecretHarness(t)
	const secret = "tmpl-secret-value-5821947"
	insertTemplateCredentials(t, ctx, pool, org, templateCredential{name: "billing_token", kind: "template_secret", value: secret})

	var seen atomic.Value
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.Store(r.Header.Get("Authorization"))
		_ = json.NewEncoder(w).Encode(map[string]any{"echo": r.Header.Get("Authorization")})
	}))
	defer target.Close()

	runID := startTemplateSecretRun(t, ctx, eng, org, target.URL)
	status, failure := waitTemplateSecretRun(t, pool, runID)
	if status != "succeeded" {
		t.Fatalf("run %s: %s", status, failure)
	}
	if got, _ := seen.Load().(string); got != "Bearer "+secret {
		t.Fatalf("target did not receive the credential: %q", got)
	}

	var persisted string
	if err := pool.QueryRow(ctx, `
		SELECT concat_ws(E'\n',
			(SELECT string_agg(payload::text, E'\n') FROM run_events WHERE run_id = $1),
			(SELECT string_agg(concat_ws(' ', state_json::text, error_json::text), E'\n') FROM run_nodes WHERE run_id = $1),
			(SELECT output_json::text FROM runs WHERE id = $1))`, runID).Scan(&persisted); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(persisted, secret) {
		t.Fatalf("resolved secret reached durable run state: %s", persisted)
	}
	if !strings.Contains(persisted, grammar.RedactedPlaceholder) {
		t.Fatalf("expected the echoed credential to be redacted: %s", persisted)
	}
}

func TestTemplateSecretsFailClosed(t *testing.T) {
	for _, tc := range []struct {
		name        string
		credentials []templateCredential
	}{
		{name: "absent"},
		{name: "generic kind", credentials: []templateCredential{{name: "billing_token", kind: "generic", value: "generic-value-1234"}}},
		{name: "provider-bound kind", credentials: []templateCredential{{name: "billing_token", kind: "github_token", value: "ghp-provider-token-1234"}}},
		{name: "expired", credentials: []templateCredential{{name: "billing_token", kind: "template_secret", value: "expired-value-1234", expired: true}}},
		{name: "ambiguous case", credentials: []templateCredential{
			{name: "billing_token", kind: "template_secret", value: "lower-value-1234"},
			{name: "BILLING_TOKEN", kind: "template_secret", value: "upper-value-1234"},
		}},
		{name: "shorter than the redaction floor", credentials: []templateCredential{{name: "billing_token", kind: "template_secret", value: "abc"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, pool, eng, org := newTemplateSecretHarness(t)
			insertTemplateCredentials(t, ctx, pool, org, tc.credentials...)
			var calls atomic.Int32
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
			}))
			defer target.Close()

			runID := startTemplateSecretRun(t, ctx, eng, org, target.URL)
			status, failure := waitTemplateSecretRun(t, pool, runID)
			if status != "failed" || !strings.Contains(failure, "Missing secret: BILLING_TOKEN") {
				t.Fatalf("want missing-secret failure, got %s: %s", status, failure)
			}
			if calls.Load() != 0 {
				t.Fatalf("request left the runtime %d time(s) without a resolvable secret", calls.Load())
			}
		})
	}
}

// An unreadable store is an outage, not a missing secret.
func TestTemplateSecretsReportStoreOutage(t *testing.T) {
	ctx, pool, eng, org := newTemplateSecretHarness(t)
	insertTemplateCredentials(t, ctx, pool, org, templateCredential{name: "billing_token", kind: "template_secret", value: "outage-value-1234"})
	secretstore.ResetForTests()
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY", "")
	var calls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
	}))
	defer target.Close()

	runID := startTemplateSecretRun(t, ctx, eng, org, target.URL)
	status, failure := waitTemplateSecretRun(t, pool, runID)
	if status != "failed" || !strings.Contains(failure, "secret store unavailable") || strings.Contains(failure, "Missing secret") {
		t.Fatalf("want store outage, got %s: %s", status, failure)
	}
	if calls.Load() != 0 {
		t.Fatal("request left the runtime without its secret")
	}
}

func TestTemplateSecretsKeepPlatformNamesUnresolved(t *testing.T) {
	ctx, pool, eng, org := newTemplateSecretHarness(t)
	insertTemplateCredentials(t, ctx, pool, org, templateCredential{
		name: runtimeDrillSecretName, kind: "template_secret", value: "must-stay-missing-1234",
	})
	wf := &domain.Workflow{
		ID: "wf-template-secret-reserved", Name: "Reserved secret", DSLVersion: "1.0",
		Nodes: []domain.Node{{ID: "probe", Type: "noop", Config: map[string]any{
			"probe": "{{secret." + runtimeDrillSecretName + "}}",
		}}},
		Edges: []domain.Edge{},
	}
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
	if err != nil {
		t.Fatal(err)
	}
	status, failure := waitTemplateSecretRun(t, pool, runID)
	if status != "failed" || !strings.Contains(failure, "Missing secret") {
		t.Fatalf("reserved name resolved: %s %s", status, failure)
	}
}

func newTemplateSecretHarness(t *testing.T) (context.Context, *pgxpool.Pool, *Engine, string) {
	t.Helper()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	secretstore.ResetForTests()
	t.Cleanup(secretstore.ResetForTests)
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY",
		base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
	ctx, pool, eng, org := newHarness(t)
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stop := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = eng.RunWorkers(workerCtx, 1, 20*time.Millisecond, dispatcher.Execute, quietLogger())
	}()
	t.Cleanup(func() { stop(); <-done })
	return ctx, pool, eng, org
}

func insertTemplateCredentials(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org string, credentials ...templateCredential) {
	t.Helper()
	q := store.New(pool)
	for i, credential := range credentials {
		id := org + "-cred-" + string(rune('a'+i))
		if err := q.InsertCredential(ctx, store.InsertCredentialParams{
			ID: id, OrgID: org, Name: credential.name, Kind: credential.kind, SecretRef: "PLACEHOLDER",
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
		}{OrgID: org, CredentialID: id, SecretValue: credential.value})
		if err != nil {
			t.Fatalf("secret: %v", err)
		}
		if err := q.UpdateCredentialSecretRef(ctx, store.UpdateCredentialSecretRefParams{
			OrgID: org, ID: id, SecretRef: secretRef,
		}); err != nil {
			t.Fatalf("ref: %v", err)
		}
		if credential.expired {
			if _, err := pool.Exec(ctx, `UPDATE credentials SET expires_at = now() - interval '1 minute' WHERE id = $1`, id); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func startTemplateSecretRun(t *testing.T, ctx context.Context, eng *Engine, org, url string) string {
	t.Helper()
	wf := &domain.Workflow{
		ID: "wf-template-secret", Name: "Template secret", DSLVersion: "1.0",
		Nodes: []domain.Node{{ID: "call", Type: "http", Config: map[string]any{
			"url": url, "method": "GET",
			"headers": map[string]any{"Authorization": "Bearer {{secret.billing_token}}"},
		}}},
		Edges: []domain.Edge{},
	}
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	return runID
}

func waitTemplateSecretRun(t *testing.T, pool *pgxpool.Pool, runID string) (string, string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var status, failure string
		if err := pool.QueryRow(context.Background(), `
			SELECT r.status, coalesce((SELECT string_agg(error_json::text, E'\n') FROM run_nodes WHERE run_id = r.id), '')
			FROM runs r WHERE r.id = $1`, runID).Scan(&status, &failure); err != nil {
			t.Fatal(err)
		}
		if status == "succeeded" || status == "failed" || status == "cancelled" {
			return status, failure
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("run %s never finished", runID)
	return "", ""
}
