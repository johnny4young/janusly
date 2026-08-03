//go:build integration

package engine

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/domain"
)

// The durable-case substrate: idempotent creation, atomic state+receipt
// (a transition without a receipt is impossible — the CAS loser gets no
// receipt, an illegal jump writes nothing), single-visit re-entry, and a
// concurrent operator race with exactly one winner.
func TestRecoveryCaseTransitions(t *testing.T) {
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()
	eng := New(pool)
	org := fmt.Sprintf("org-reccase-%d", time.Now().UnixNano())

	input := RecoveryCaseInput{
		OrgID: org, RunID: "run-1", WorkflowID: "wf-1", WorkflowVersionID: "wfv-1",
		Source: "semantic_violation", DetectorID: "det-refund-total",
		SourceNodeID: "calc", DetectorKind: "expression", Action: "quarantine",
		Message: "refund exceeds order total",
	}
	caseID, err := eng.CreateRecoveryCase(ctx, input)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// Idempotent creation: the same (org, run, detector) yields the same
	// deterministic id and no duplicate row.
	again, err := eng.CreateRecoveryCase(ctx, input)
	if err != nil || again != caseID {
		t.Fatalf("idempotent create: %s vs %s (%v)", caseID, again, err)
	}
	var caseCount int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM recovery_cases WHERE org_id = $1`, org).Scan(&caseCount)
	if caseCount != 1 {
		t.Fatalf("one case expected: %d", caseCount)
	}

	evidence := []domain.RecoveryCaseEvidenceRef{{Kind: "run_node", ID: "run-1:calc"}}
	receipt := func(from, to string) domain.RecoveryCaseTransitionReceipt {
		return domain.RecoveryCaseTransitionReceipt{
			CaseID: caseID, From: from, To: to,
			ActorKind: "system", Evidence: evidence,
		}
	}

	// 1. An illegal jump writes NOTHING (validated before any write).
	if err := eng.TransitionRecoveryCase(ctx, org, receipt("detected", "publishing")); err == nil {
		t.Fatal("illegal jump must refuse")
	}
	assertCase(t, pool, org, caseID, "detected", 0)

	// 2. Legal transition: state + receipt land together.
	if err := eng.TransitionRecoveryCase(ctx, org, receipt("detected", "contained")); err != nil {
		t.Fatalf("contain: %v", err)
	}
	assertCase(t, pool, org, caseID, "contained", 1)

	// 3. A stale CAS (wrong from) fails and writes NO receipt.
	if err := eng.TransitionRecoveryCase(ctx, org, receipt("detected", "accepted_loss")); !errors.Is(err, ErrRecoveryCaseConflict) {
		t.Fatalf("stale from must conflict: %v", err)
	}
	assertCase(t, pool, org, caseID, "contained", 1)

	// 4. Concurrent operators racing the same transition: exactly one
	// winner, exactly one receipt, the loser sees the conflict.
	var wg sync.WaitGroup
	results := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = eng.TransitionRecoveryCase(ctx, org, receipt("contained", "diagnosed"))
		}()
	}
	wg.Wait()
	winners := 0
	for _, result := range results {
		if result == nil {
			winners++
		} else if !errors.Is(result, ErrRecoveryCaseConflict) && !errors.Is(result, ErrRecoveryCaseReceiptGone) {
			t.Fatalf("loser must see the CAS conflict: %v", result)
		}
	}
	if winners != 1 {
		t.Fatalf("exactly one winner expected: %d", winners)
	}
	assertCase(t, pool, org, caseID, "diagnosed", 2)

	// 5. Walk to terminal: resolved_at set once; terminal has no exits.
	for _, step := range [][2]string{
		{"diagnosed", "candidates_ready"}, {"candidates_ready", "validating"},
		{"validating", "awaiting_approval"}, {"awaiting_approval", "publishing"},
		{"publishing", "monitoring"}, {"monitoring", "verified_recovered"},
	} {
		if err := eng.TransitionRecoveryCase(ctx, org, receipt(step[0], step[1])); err != nil {
			t.Fatalf("%s -> %s: %v", step[0], step[1], err)
		}
	}
	var resolvedAt *time.Time
	_ = pool.QueryRow(ctx, `SELECT resolved_at FROM recovery_cases WHERE org_id = $1 AND id = $2`, org, caseID).Scan(&resolvedAt)
	if resolvedAt == nil {
		t.Fatal("terminal must stamp resolved_at")
	}
	if err := eng.TransitionRecoveryCase(ctx, org, receipt("verified_recovered", "abandoned")); err == nil {
		t.Fatal("terminal must have no exits")
	}

	// 6. Receipts read back append-only in occurrence order.
	rows, err := pool.Query(ctx, `SELECT from_state, to_state FROM recovery_case_transitions
		WHERE org_id = $1 AND case_id = $2 ORDER BY occurred_at, id`, org, caseID)
	if err != nil {
		t.Fatalf("read receipts: %v", err)
	}
	defer rows.Close()
	var ladder []string
	for rows.Next() {
		var from, to string
		_ = rows.Scan(&from, &to)
		ladder = append(ladder, from+">"+to)
	}
	if len(ladder) != 8 || ladder[0] != "detected>contained" || ladder[7] != "monitoring>verified_recovered" {
		t.Fatalf("receipt ladder: %v", ladder)
	}
}

func assertCase(t *testing.T, pool *pgxpool.Pool, org, caseID, wantState string, wantReceipts int) {
	t.Helper()
	ctx := context.Background()
	var state string
	var receipts int
	_ = pool.QueryRow(ctx, `SELECT state FROM recovery_cases WHERE org_id = $1 AND id = $2`, org, caseID).Scan(&state)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM recovery_case_transitions WHERE org_id = $1 AND case_id = $2`, org, caseID).Scan(&receipts)
	if state != wantState || receipts != wantReceipts {
		t.Fatalf("case state=%s receipts=%d, want %s/%d", state, receipts, wantState, wantReceipts)
	}
}
