//go:build integration

package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/browsersession"
	"github.com/johnny4young/janusly/internal/store"
)

func sessionRequest(t *testing.T, sessionID string) *http.Request {
	t.Helper()
	token, err := browsersession.CreateToken(sessionID, 600)
	if err != nil {
		t.Fatalf("create browser token: %v", err)
	}
	req := httptest.NewRequest("GET", "/auth/context", nil)
	req.Header.Set("Cookie", browsersession.CookieName+"="+token.Value)
	return req
}

func TestJanuslySessionLifecycleAndMembershipBoundary(t *testing.T) {
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set")
	}
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "session-integration-secret")
	pool, err := pgxpool.New(t.Context(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)

	q := store.New(pool)
	userID := "sso-user-" + uuid.NewString()
	orgA := "sso-org-a-" + uuid.NewString()
	orgB := "sso-org-b-" + uuid.NewString()
	seedMember(t, pool, orgA, userID, "alice@example.com", "editor")
	seedMember(t, pool, orgB, userID, "alice@example.com", "viewer")
	sessionID := uuid.NewString()
	created, err := q.CreateAuthSession(t.Context(), store.CreateAuthSessionParams{
		ID: sessionID, UserID: userID, Email: "  Alice@Example.COM  ",
		OrgID: orgA, ExpiresAt: time.Now().Add(10 * time.Minute),
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if created.Email != "alice@example.com" || created.RevokedAt != nil {
		t.Fatalf("normalized active session: %+v", created)
	}

	rv := NewResolver(pool, Config{})
	req := sessionRequest(t, sessionID)
	identity, err := rv.ResolveIdentity(t.Context(), req)
	if err != nil || identity == nil || identity.UserID != userID ||
		identity.OrgHint != orgA || identity.Mode != ModeJanuslySession ||
		identity.Source != SourceSSO || identity.BrowserSessionID != sessionID {
		t.Fatalf("active identity: %+v %v", identity, err)
	}
	resolved, err := rv.Resolve(t.Context(), req)
	if err != nil || resolved == nil || resolved.OrgID != orgA ||
		resolved.MembershipRole != "editor" || resolved.Mode != ModeJanuslySession ||
		resolved.BrowserSessionID != sessionID {
		t.Fatalf("membership grant: %+v %v", resolved, err)
	}

	if _, err := q.UpdateAuthSessionOrganization(t.Context(), store.UpdateAuthSessionOrganizationParams{
		ID: sessionID, UserID: "foreign-user", OrgID: orgB,
	}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("foreign user must not move session: %v", err)
	}
	updated, err := q.UpdateAuthSessionOrganization(t.Context(), store.UpdateAuthSessionOrganizationParams{
		ID: sessionID, UserID: userID, OrgID: orgB,
	})
	if err != nil || updated.OrgID != orgB || updated.ExpiresAt.Unix() != created.ExpiresAt.Unix() {
		t.Fatalf("organization switch must preserve expiry: %+v %v", updated, err)
	}
	resolved, err = rv.Resolve(t.Context(), req)
	if err != nil || resolved == nil || resolved.OrgID != orgB || resolved.MembershipRole != "viewer" {
		t.Fatalf("switched membership: %+v %v", resolved, err)
	}

	rows, err := q.RevokeAuthSession(t.Context(), sessionID)
	if err != nil || rows != 1 {
		t.Fatalf("first revoke: rows=%d err=%v", rows, err)
	}
	rows, err = q.RevokeAuthSession(t.Context(), sessionID)
	if err != nil || rows != 0 {
		t.Fatalf("idempotent revoke: rows=%d err=%v", rows, err)
	}
	if _, err := q.GetActiveAuthSession(t.Context(), sessionID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("revoked session must disappear: %v", err)
	}
	if identity, err := rv.ResolveIdentity(t.Context(), req); err != nil || identity != nil {
		t.Fatalf("revoked cookie must be anonymous: %+v %v", identity, err)
	}
}

func TestSessionIdentityCanExistWithoutMembership(t *testing.T) {
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set")
	}
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "session-integration-secret")
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)

	sessionID := uuid.NewString()
	_, err = store.New(pool).CreateAuthSession(t.Context(), store.CreateAuthSessionParams{
		ID: sessionID, UserID: "new-user-" + uuid.NewString(), Email: "new@example.com",
		OrgID: "ungranted-org-" + uuid.NewString(), ExpiresAt: time.Now().Add(10 * time.Minute),
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	rv := NewResolver(pool, Config{})
	req := sessionRequest(t, sessionID)
	if identity, err := rv.ResolveIdentity(t.Context(), req); err != nil || identity == nil {
		t.Fatalf("provider identity must survive zero memberships: %+v %v", identity, err)
	}
	if resolved, err := rv.Resolve(t.Context(), req); err != nil || resolved != nil {
		t.Fatalf("tenant context must still require a grant: %+v %v", resolved, err)
	}
}
