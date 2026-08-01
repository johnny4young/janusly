//go:build integration

package secretstore

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/go/internal/store"
)

func testKey() string {
	return base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef"))
}

func poolAndQueries(t *testing.T) (*pgxpool.Pool, *store.Queries) {
	t.Helper()
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool, store.New(pool)
}

func seedCredential(t *testing.T, q *store.Queries, org, id, kind, name, secretRef string) {
	t.Helper()
	if err := q.InsertCredential(context.Background(), store.InsertCredentialParams{
		ID: id, OrgID: org, Name: name, Kind: kind, SecretRef: secretRef,
		CreatedBy: pgtype.Text{String: "test", Valid: true},
	}); err != nil {
		t.Fatalf("seed credential: %v", err)
	}
}

// The envelope loop: encrypt → resolve round-trip, org scoping, revoke,
// AAD tamper detection, the forged-ref env firewall, and the no-plaintext
// database property the compliance buyer actually cares about.
func TestSecretStoreEnvelope(t *testing.T) {
	pool, q := poolAndQueries(t)
	ctx := context.Background()
	ResetForTests()
	t.Cleanup(ResetForTests)
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY", testKey())
	org := fmt.Sprintf("org-secret-%d", time.Now().UnixNano())
	credID := "cred-" + org
	secretValue := "sk-live-EXTREMELY-SECRET-token-123"

	seedCredential(t, q, org, credID, "http", "api-token", "PLACEHOLDER")
	id, version, secretRef, err := CreateCredentialSecretVersion(ctx, q, struct {
		ID           string
		OrgID        string
		CredentialID string
		SecretValue  string
		CreatedBy    string
	}{OrgID: org, CredentialID: credID, SecretValue: secretValue, CreatedBy: "test"})
	if err != nil || version != 1 || !IsManagedCredentialSecretRef(secretRef) {
		t.Fatalf("create: %v %d %s", err, version, secretRef)
	}

	// Round-trip; a second version increments monotonically.
	if got := ResolveCredentialSecretRef(ctx, q, org, secretRef); got != secretValue {
		t.Fatalf("resolve: %q", got)
	}
	_, version2, _, err := CreateCredentialSecretVersion(ctx, q, struct {
		ID           string
		OrgID        string
		CredentialID string
		SecretValue  string
		CreatedBy    string
	}{OrgID: org, CredentialID: credID, SecretValue: "rotated", CreatedBy: "test"})
	if err != nil || version2 != 2 {
		t.Fatalf("second version: %v %d", err, version2)
	}

	// The database NEVER holds plaintext (dump property).
	var row string
	_ = pool.QueryRow(ctx, `SELECT ciphertext || data_nonce || data_tag || wrapped_key || wrap_nonce || wrap_tag
		FROM credential_secret_versions WHERE id = $1`, id).Scan(&row)
	if strings.Contains(row, secretValue) || strings.Contains(row, "EXTREMELY") {
		t.Fatal("plaintext leaked into the database")
	}

	// Cross-org resolution fails closed.
	if got := ResolveCredentialSecretRef(ctx, q, org+"-other", secretRef); got != "" {
		t.Fatalf("cross-org must fail closed: %q", got)
	}

	// AAD binds to org: re-homing the ciphertext row breaks the seal.
	_, _ = pool.Exec(ctx, `UPDATE credential_secret_versions SET org_id = $2 WHERE id = $1`, id, org+"-other")
	if got := ResolveCredentialSecretRef(ctx, q, org+"-other", secretRef); got != "" {
		t.Fatalf("AAD tamper must fail closed: %q", got)
	}
	_, _ = pool.Exec(ctx, `UPDATE credential_secret_versions SET org_id = $2 WHERE id = $1`, id, org)

	// Resolve by (kind, name) — the org-aware resolver.
	if err := q.UpdateCredentialSecretRef(ctx, store.UpdateCredentialSecretRefParams{
		OrgID: org, ID: credID, SecretRef: secretRef,
	}); err != nil {
		t.Fatalf("update ref: %v", err)
	}
	if got := ResolveCredentialSecret(ctx, q, org, "http", "api-token"); got != secretValue {
		t.Fatalf("resolve by name: %q", got)
	}

	// Revoke fails closed and is idempotent for legacy refs.
	if err := RevokeCredentialSecretRef(ctx, q, org, secretRef); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if got := ResolveCredentialSecretRef(ctx, q, org, secretRef); got != "" {
		t.Fatalf("revoked must fail closed: %q", got)
	}
	if err := RevokeCredentialSecretRef(ctx, q, org, "SOME_ENV_NAME"); err != nil {
		t.Fatalf("legacy revoke must no-op: %v", err)
	}

	// Legacy env reference keeps working; a FORGED managed ref never
	// falls through to the environment provider.
	t.Setenv("LEGACY_TOKEN_FOR_TEST", "legacy-value")
	if got := ResolveCredentialSecretRef(ctx, q, org, "LEGACY_TOKEN_FOR_TEST"); got != "legacy-value" {
		t.Fatalf("legacy ref: %q", got)
	}
	forged := "janusly-secret://not-a-uuid"
	t.Setenv(forged, "must-never-resolve")
	if got := ResolveCredentialSecretRef(ctx, q, org, forged); got != "" {
		t.Fatalf("forged managed ref must never reach env: %q", got)
	}

	// Oversized and empty values are refused before touching the DB.
	for _, bad := range []string{"", strings.Repeat("x", 64*1024+1)} {
		if _, _, _, err := CreateCredentialSecretVersion(ctx, q, struct {
			ID           string
			OrgID        string
			CredentialID string
			SecretValue  string
			CreatedBy    string
		}{OrgID: org, CredentialID: credID, SecretValue: bad}); err != ErrValueInvalid {
			t.Fatalf("bad value must refuse: %v", err)
		}
	}
}

// Root-key posture: unset = legal legacy-only, malformed fails fast at
// boot, the file variant works, and a missing key at RESOLVE time fails
// closed (never throws into the caller).
func TestSecretStoreRootKeyPosture(t *testing.T) {
	_, q := poolAndQueries(t)
	ctx := context.Background()
	ResetForTests()
	t.Cleanup(ResetForTests)

	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY", "")
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY_FILE", "")
	if configured, err := AssertCredentialRootKeyUsable(); configured || err != nil {
		t.Fatalf("unset key must be legal: %v %v", configured, err)
	}
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY", "not-a-key")
	if _, err := AssertCredentialRootKeyUsable(); err != ErrRootKeyInvalid {
		t.Fatalf("malformed key must fail fast: %v", err)
	}
	ResetForTests()

	// File variant round-trips.
	keyFile := t.TempDir() + "/root.key"
	if err := os.WriteFile(keyFile, []byte(testKey()+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY", "")
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY_FILE", keyFile)
	if configured, err := AssertCredentialRootKeyUsable(); !configured || err != nil {
		t.Fatalf("file key: %v %v", configured, err)
	}
	org := fmt.Sprintf("org-keyfile-%d", time.Now().UnixNano())
	credID := "cred-" + org
	seedCredential(t, q, org, credID, "http", "file-key", "PLACEHOLDER")
	_, _, secretRef, err := CreateCredentialSecretVersion(ctx, q, struct {
		ID           string
		OrgID        string
		CredentialID string
		SecretValue  string
		CreatedBy    string
	}{OrgID: org, CredentialID: credID, SecretValue: "file-backed"})
	if err != nil {
		t.Fatalf("create with file key: %v", err)
	}
	if got := ResolveCredentialSecretRef(ctx, q, org, secretRef); got != "file-backed" {
		t.Fatalf("file-key resolve: %q", got)
	}

	// Key vanishes (replica misconfiguration): resolve fails CLOSED.
	ResetForTests()
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY_FILE", "")
	if got := ResolveCredentialSecretRef(ctx, q, org, secretRef); got != "" {
		t.Fatalf("missing key must fail closed: %q", got)
	}
	// And a write without a key surfaces the sentinel.
	if _, _, _, err := CreateCredentialSecretVersion(ctx, q, struct {
		ID           string
		OrgID        string
		CredentialID string
		SecretValue  string
		CreatedBy    string
	}{OrgID: org, CredentialID: credID, SecretValue: "nope"}); err != ErrRootKeyMissing {
		t.Fatalf("keyless write must refuse: %v", err)
	}
}
