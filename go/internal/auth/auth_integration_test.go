//go:build integration

package auth

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/go/internal/store"
)

// fakeSupabase mimics GET /auth/v1/user: one valid token maps to a fixed
// user; everything else is 401. One special token simulates an outage.
func fakeSupabase(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth/v1/user" || r.Header.Get("apikey") == "" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		switch r.Header.Get("Authorization") {
		case "Bearer live-token":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"uuid-ada","email":"Ada@Example.com"}`))
		case "Bearer broken-json":
			_, _ = w.Write([]byte(`{"id":`))
		case "Bearer outage":
			w.WriteHeader(http.StatusInternalServerError)
		default:
			w.WriteHeader(http.StatusUnauthorized) // expired / forged / revoked
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func seedMember(t *testing.T, pool *pgxpool.Pool, org, userID, email, role string) {
	t.Helper()
	_, err := pool.Exec(context.Background(),
		`INSERT INTO org_members (id, org_id, user_id, email, role)
		 VALUES ($1, $2, $3, $4, $5)`,
		fmt.Sprintf("%s-%s", org, userID), org, userID, email, role)
	if err != nil {
		t.Fatalf("seed member: %v", err)
	}
}

func TestSupabaseMembershipResolution(t *testing.T) {
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	sb := fakeSupabase(t)
	rv := NewResolver(pool, Config{SupabaseURL: sb.URL, SupabaseKey: "anon-key"})

	orgA := fmt.Sprintf("org-sbA-%d", time.Now().UnixNano())
	orgB := orgA + "-b"
	orgLegacy := orgA + "-legacy"
	seedMember(t, pool, orgA, "uuid-ada", "ada@example.com", "editor")
	seedMember(t, pool, orgB, "uuid-ada", "ada@example.com", "viewer")
	// Legacy placeholder: userId column carries the EMAIL.
	seedMember(t, pool, orgLegacy, "ada@example.com", "ada@example.com", "admin")

	resolve := func(headers map[string]string) *Context {
		req := httptest.NewRequest("GET", "/v1/runs", nil)
		for name, value := range headers {
			req.Header.Set(name, value)
		}
		resolved, err := rv.Resolve(context.Background(), req)
		if err != nil {
			t.Fatalf("resolve: %v", err)
		}
		return resolved
	}

	// Direct grant: hint + membership row.
	got := resolve(map[string]string{"Authorization": "Bearer live-token", "x-org-id": orgA})
	if got == nil || got.OrgID != orgA || got.MembershipRole != "editor" || got.Mode != ModeSupabase {
		t.Fatalf("direct grant: %+v", got)
	}

	// Hint without a grant fails closed — even though the user EXISTS in
	// other orgs (the hint is scope, membership is authority).
	if got := resolve(map[string]string{"Authorization": "Bearer live-token", "x-org-id": orgA + "-ghost"}); got != nil {
		t.Fatalf("hintless grant must fail closed: %+v", got)
	}

	// Hint-less with MULTIPLE memberships is ambiguous → nil (the client
	// must send x-org-id; the web always does).
	if got := resolve(map[string]string{"Authorization": "Bearer live-token"}); got != nil {
		t.Fatalf("ambiguous membership must force the hint: %+v", got)
	}

	// Legacy-orphan lazy backfill: email-placeholder row migrates to the
	// provider UUID on first sign-in and the grant is accepted.
	got = resolve(map[string]string{"Authorization": "Bearer live-token", "x-org-id": orgLegacy})
	if got == nil || got.MembershipRole != "admin" || got.UserID != "uuid-ada" {
		t.Fatalf("legacy backfill: %+v", got)
	}
	var migrated string
	_ = pool.QueryRow(context.Background(),
		`SELECT user_id FROM org_members WHERE org_id = $1`, orgLegacy).Scan(&migrated)
	if migrated != "uuid-ada" {
		t.Fatalf("row must be rewritten to the UUID: %q", migrated)
	}

	// Verification failures fail closed, never cascading to dev headers.
	for _, token := range []string{"expired-or-forged", "broken-json", "outage"} {
		if got := resolve(map[string]string{
			"Authorization": "Bearer " + token, "x-org-id": orgA, "x-user-id": "uuid-ada",
		}); got != nil {
			t.Fatalf("token %q must fail closed: %+v", token, got)
		}
	}
}

// Single-membership convenience: no hint needed when unambiguous.
func TestSupabaseSingleMembershipDefaults(t *testing.T) {
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	sb := fakeSupabase(t)
	rv := NewResolver(pool, Config{SupabaseURL: sb.URL, SupabaseKey: "anon-key"})

	org := fmt.Sprintf("org-sbsingle-%d", time.Now().UnixNano())
	userID := fmt.Sprintf("uuid-solo-%d", time.Now().UnixNano())
	// A dedicated fake user so this test owns exactly one membership.
	sbSolo := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer live-token" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprintf(w, `{"id":%q,"email":"solo@example.com"}`, userID)
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(sbSolo.Close)
	rv = NewResolver(pool, Config{SupabaseURL: sbSolo.URL, SupabaseKey: "anon-key"})
	_ = store.New(pool)
	seedMember(t, pool, org, userID, "solo@example.com", "editor")

	req := httptest.NewRequest("GET", "/v1/runs", nil)
	req.Header.Set("Authorization", "Bearer live-token")
	got, err := rv.Resolve(context.Background(), req)
	if err != nil || got == nil || got.OrgID != org {
		t.Fatalf("single membership default: %+v %v", got, err)
	}
}

// The role ladder: literal built-in wins; the admin auto-grant exists ONLY
// for dev-headers and ONLY when no row exists; custom literals without a
// defining row fail closed.
func TestResolveMemberRoleLadder(t *testing.T) {
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	q := store.New(pool)
	ctx := context.Background()
	org := fmt.Sprintf("org-roles-%d", time.Now().UnixNano())
	seedMember(t, pool, org, "viewer-user", "v@example.com", "viewer")
	seedMember(t, pool, org, "custom-user", "c@example.com", "billing-admin")

	// A row's literal role wins in EVERY mode — including dev-headers
	// (the auto-grant is for missing rows only, the reference's subtlety).
	for _, mode := range []Mode{ModeSupabase, ModeServiceToken, ModeDevHeaders} {
		got, err := ResolveMemberRole(ctx, q, org, "viewer-user", mode)
		if err != nil || got == nil || got.InheritsFrom != RoleViewer {
			t.Fatalf("mode %s: %+v %v", mode, got, err)
		}
	}

	// No row: dev-headers auto-grants admin; the other modes fail closed.
	got, _ := ResolveMemberRole(ctx, q, org, "ghost", ModeDevHeaders)
	if got == nil || got.InheritsFrom != RoleAdmin {
		t.Fatalf("dev auto-grant: %+v", got)
	}
	for _, mode := range []Mode{ModeSupabase, ModeServiceToken} {
		if got, _ := ResolveMemberRole(ctx, q, org, "ghost", mode); got != nil {
			t.Fatalf("mode %s must not auto-grant: %+v", mode, got)
		}
	}

	// Custom literal without its org_roles row: fail closed even in dev.
	if got, _ := ResolveMemberRole(ctx, q, org, "custom-user", ModeDevHeaders); got != nil {
		t.Fatalf("undefined custom role must fail closed: %+v", got)
	}
}
