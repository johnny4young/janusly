//go:build integration

package audit

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/grammar"
)

func TestWriterPolicyCoversEveryAuditMode(t *testing.T) {
	pool := testPool(t)
	ctx := t.Context()
	for _, cap := range []int{2, 128, 400} {
		policy, err := grammar.NewPersister(cap)
		if err != nil {
			t.Fatal(err)
		}
		writer := NewWriter(policy)
		t.Setenv("JANUSLY_PERSIST_MAX_BYTES", "900000")
		org := fmt.Sprintf("audit-policy-%d-%s", cap, uuid.NewString())
		actor := &auth.Context{OrgID: org, UserID: "audit-user", Mode: auth.ModeDevHeaders, Source: auth.SourceDev}
		opts := Options{Metadata: map[string]any{"authorization": "secret-marker", "blob": strings.Repeat("x", 2000)}}
		action := Action("org.role.created")
		writer.Write(ctx, pool, actor, action, opts)
		writer.WriteAs(ctx, pool, org, actor.UserID, action, opts)
		writer.SystemWrite(ctx, pool, org, "system", action, opts)
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err = writer.WriteInTx(ctx, tx, actor, action, opts); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
		if err = writer.SystemWriteInTx(ctx, tx, org, "system", action, opts); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if err = writer.WithAuditTx(ctx, pool, actor, func(_ pgx.Tx, write TxAudit) error { return write(action, opts) }); err != nil {
			t.Fatal(err)
		}
		if err = writer.WithIdentityAuditTx(ctx, pool, &auth.Identity{UserID: actor.UserID}, func(_ pgx.Tx, write IdentityTxAudit) error { return write(org, action, opts) }); err != nil {
			t.Fatal(err)
		}
		rows, err := pool.Query(ctx, `SELECT metadata FROM audit_logs WHERE org_id=$1`, org)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		count := 0
		for rows.Next() {
			var raw []byte
			if err := rows.Scan(&raw); err != nil {
				t.Fatal(err)
			}
			var data any
			if err := json.Unmarshal(raw, &data); err != nil {
				t.Fatal(err)
			}
			compact, err := json.Marshal(data)
			if err != nil {
				t.Fatal(err)
			}
			if len(compact) > cap || strings.Contains(string(raw), "secret-marker") {
				t.Fatalf("cap%d violated: %s", cap, raw)
			}
			if cap >= 128 && (!strings.Contains(string(raw), `"__truncated": true`) || data.(map[string]any)["maxBytes"] != float64(cap)) {
				t.Fatalf("policy not applied: %s", raw)
			}
			count++
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			t.Fatal(err)
		}
		if count != 7 {
			t.Fatalf("expected seven durable audit modes, got %d", count)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM audit_logs WHERE org_id=$1`, org); err != nil {
			t.Fatal(err)
		}
	}
}
