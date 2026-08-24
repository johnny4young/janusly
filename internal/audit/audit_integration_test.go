//go:build integration

package audit

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/auth"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func lastRow(t *testing.T, pool *pgxpool.Pool, orgID string) (action string, metadata map[string]any) {
	t.Helper()
	var raw []byte
	err := pool.QueryRow(context.Background(),
		`SELECT action, metadata FROM audit_logs WHERE org_id = $1
		 ORDER BY created_at DESC, id DESC LIMIT 1`, orgID).Scan(&action, &raw)
	if err != nil {
		t.Fatalf("read audit: %v", err)
	}
	_ = json.Unmarshal(raw, &metadata)
	return action, metadata
}

func TestAuditCatalogPinned(t *testing.T) {
	if CatalogActionCount() != 148 {
		t.Fatalf("contract catalog must pin at 148, got %d", CatalogActionCount())
	}
	if !IsKnown("workflow.created") && !IsKnown("org.role.created") {
		t.Fatal("expected reference actions missing")
	}
	if IsKnown("made.up.action") {
		t.Fatal("unknown actions must not validate")
	}
}

func TestWriteEnrichesAndRedacts(t *testing.T) {
	pool := testPool(t)
	org := fmt.Sprintf("org-audit-%d", time.Now().UnixNano())
	authCtx := &auth.Context{
		OrgID: org, UserID: "u1", Mode: auth.ModeServiceToken,
		Source: auth.SourceMcp, ServiceTokenSuffix: "beef",
	}
	Write(context.Background(), pool, authCtx, "org.role.created", Options{
		TargetType: "org_role", TargetID: "r1",
		Metadata: map[string]any{
			"name": "auditor",
			// Caller tries to forge the forensic block AND smuggle a secret.
			"actor":  "spoofed",
			"apiKey": "sk-live-123",
			"source": "web",
		},
	})
	action, metadata := lastRow(t, pool, org)
	if action != "org.role.created" {
		t.Fatalf("action: %s", action)
	}
	actor, _ := metadata["actor"].(map[string]any)
	if actor == nil || actor["userId"] != "u1" || actor["serviceTokenSuffix"] != "beef" {
		t.Fatalf("auth-derived actor must win the collision: %+v", metadata)
	}
	if metadata["source"] != "mcp" {
		t.Fatalf("source must be auth-derived: %+v", metadata)
	}
	if metadata["apiKey"] != "[redacted]" {
		t.Fatalf("sensitive keys must redact: %+v", metadata)
	}

	// A typo'd action never lands (and never panics — best effort logs).
	Write(context.Background(), pool, authCtx, "org.role.craeted", Options{})
	action, _ = lastRow(t, pool, org)
	if action != "org.role.created" {
		t.Fatalf("typo action must not insert: %s", action)
	}
}

func TestWithAuditTxAtomicity(t *testing.T) {
	pool := testPool(t)
	org := fmt.Sprintf("org-audittx-%d", time.Now().UnixNano())
	authCtx := &auth.Context{OrgID: org, UserID: "u1", Mode: auth.ModeDevHeaders, Source: auth.SourceDev}

	// Handler failure AFTER the audit call rolls BOTH writes back.
	err := WithAuditTx(context.Background(), pool, authCtx, func(tx pgx.Tx, audit TxAudit) error {
		if _, err := tx.Exec(context.Background(),
			`INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, 'x', 'viewer')`,
			org+"-m1", org); err != nil {
			return err
		}
		if err := audit("member.role.updated", Options{TargetID: "x"}); err != nil {
			return err
		}
		return errors.New("boom after audit")
	})
	if err == nil {
		t.Fatal("handler error must propagate")
	}
	var members, audits int
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM org_members WHERE org_id = $1`, org).Scan(&members)
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_logs WHERE org_id = $1`, org).Scan(&audits)
	if members != 0 || audits != 0 {
		t.Fatalf("rollback must cover both: members=%d audits=%d", members, audits)
	}

	// Success commits both, and the tx-bound audit REJECTS a typo loudly
	// (unlike the best-effort writer): the pairing exists to fail.
	err = WithAuditTx(context.Background(), pool, authCtx, func(tx pgx.Tx, audit TxAudit) error {
		if _, err := tx.Exec(context.Background(),
			`INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, 'y', 'viewer')`,
			org+"-m2", org); err != nil {
			return err
		}
		return audit("member.role.updated", Options{TargetID: "y"})
	})
	if err != nil {
		t.Fatalf("commit path: %v", err)
	}
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM org_members WHERE org_id = $1`, org).Scan(&members)
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_logs WHERE org_id = $1`, org).Scan(&audits)
	if members != 1 || audits != 1 {
		t.Fatalf("commit must cover both: members=%d audits=%d", members, audits)
	}

	err = WithAuditTx(context.Background(), pool, authCtx, func(tx pgx.Tx, audit TxAudit) error {
		return audit("member.role.updatted", Options{})
	})
	if err == nil {
		t.Fatal("tx-bound audit must reject a typo'd action")
	}
}

func TestWithIdentityAuditTxBindsActorAndDynamicOrganization(t *testing.T) {
	pool := testPool(t)
	org := fmt.Sprintf("org-identity-audittx-%d", time.Now().UnixNano())
	identity := &auth.Identity{
		UserID: "bootstrap-user", Email: "user@example.com",
		Mode: auth.ModeSupabase, Source: auth.SourceWeb,
	}

	err := WithIdentityAuditTx(context.Background(), pool, identity, func(tx pgx.Tx, audit IdentityTxAudit) error {
		if _, err := tx.Exec(context.Background(),
			`INSERT INTO organizations (id, owner_user_id, name) VALUES ($1, $2, 'Bootstrap Org')`, org, identity.UserID); err != nil {
			return err
		}
		return audit(org, "org.created", Options{
			TargetType: "organization", TargetID: org,
			Metadata: map[string]any{"actor": "spoofed"},
		})
	})
	if err != nil {
		t.Fatalf("identity audit tx: %v", err)
	}
	action, metadata := lastRow(t, pool, org)
	if action != "org.created" || metadata["source"] != "web" {
		t.Fatalf("dynamic audit identity: action=%q metadata=%+v", action, metadata)
	}
	actor, _ := metadata["actor"].(map[string]any)
	if actor == nil || actor["userId"] != identity.UserID || actor["mode"] != "supabase" {
		t.Fatalf("provider identity must own actor metadata: %+v", metadata)
	}

	if err := WithIdentityAuditTx(context.Background(), pool, nil,
		func(pgx.Tx, IdentityTxAudit) error { return nil }); err == nil {
		t.Fatal("nil identity must fail before beginning a transaction")
	}
}
