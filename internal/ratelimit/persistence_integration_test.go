//go:build integration

package ratelimit

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/grammar"
)

func TestDegradationAuditsUseInjectedPolicy(t *testing.T) {
	pool := testPool(t)
	policy, err := grammar.NewPersister(2)
	if err != nil {
		t.Fatal(err)
	}
	tracker := NewTracker(pool, audit.NewWriter(policy))
	t.Setenv("JANUSLY_PERSIST_MAX_BYTES", "900000")
	bucket := fmt.Sprintf("bounded-degradation-%d", time.Now().UnixNano())
	tracker.RecordError(bucket, "org", errors.New("database unavailable"))
	tracker.RecordRecovery(bucket, "org")
	for _, action := range []string{"rate_limit.degraded", "rate_limit.recovered"} {
		var raw string
		if err := pool.QueryRow(t.Context(), `SELECT metadata::text FROM audit_logs WHERE org_id=$1 AND target_id=$2 AND action=$3`, SystemOrgID, bucket, action).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		if raw != "{}" {
			t.Fatalf("%s bypassed writer: %s", action, raw)
		}
	}
}
