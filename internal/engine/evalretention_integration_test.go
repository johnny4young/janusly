//go:build integration

package engine

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestEvalDatasetRetentionIsBoundedAndAtomic(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()

	now := time.Date(2026, time.September, 3, 12, 0, 0, 0, time.UTC)
	eng := New(pool)
	eng.now = func() time.Time { return now }
	suffix := fmt.Sprint(time.Now().UnixNano())
	org := "org-eval-retention-" + suffix

	seedDataset := func(label string, createdAt time.Time, retention any) string {
		id := "dataset-" + label + "-" + suffix
		if _, err := pool.Exec(ctx, `INSERT INTO eval_datasets
			(id, org_id, name, description, example_count, retention_days, created_at)
			VALUES ($1, $2, $3, '', 1, $4, $5)`, id, org, label, retention, createdAt); err != nil {
			t.Fatalf("seed dataset %s: %v", label, err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO eval_examples
			(id, org_id, dataset_id, source_feedback_id, expected_approach_label, suggestion_mode)
			VALUES ($1, $2, $3, $4, 'retry', 'fallback')`,
			"example-"+label+"-"+suffix, org, id, "feedback-"+label+"-"+suffix); err != nil {
			t.Fatalf("seed example %s: %v", label, err)
		}
		return id
	}

	expiredA := seedDataset("expired-a", now.Add(-48*time.Hour), 1)
	expiredB := seedDataset("expired-b", now.Add(-24*time.Hour), 1) // exact boundary
	expiredC := seedDataset("expired-c", now.Add(-72*time.Hour), 2)
	fresh := seedDataset("fresh", now.Add(-23*time.Hour), 1)
	indefinite := seedDataset("indefinite", now.Add(-365*24*time.Hour), nil)
	legacyInvalid := seedDataset("legacy-invalid", now.Add(-365*24*time.Hour), 0)
	legacyOversized := seedDataset("legacy-oversized", now.Add(-365*24*time.Hour), 3651)

	// Completed experiment evidence survives expiry even though its source
	// dataset and consented examples are purged.
	experimentID := "experiment-retention-" + suffix
	if _, err := pool.Exec(ctx, `INSERT INTO experiments
		(id, org_id, name, kind, control_ref, candidate_ref, eval_dataset_id,
		 scorer_kind, status, summary_json, completed_at)
		VALUES ($1, $2, 'retention evidence', 'model', 'a', 'b', $3,
		 'string_equality', 'completed', '{"recommendation":"inconclusive"}', $4)`,
		experimentID, org, expiredA, now.Add(-47*time.Hour)); err != nil {
		t.Fatalf("seed experiment: %v", err)
	}

	first, err := eng.ProcessEvalDatasetRetentionSweep(ctx, 1, 2)
	if err != nil {
		t.Fatalf("capped sweep: %v", err)
	}
	if first.DatasetsDeleted != 2 || !first.CappedByMaxBatches {
		t.Fatalf("capped sweep result: %+v", first)
	}
	second, err := eng.ProcessEvalDatasetRetentionSweep(ctx, 10, 2)
	if err != nil {
		t.Fatalf("drain sweep: %v", err)
	}
	if second.DatasetsDeleted != 1 || second.CappedByMaxBatches {
		t.Fatalf("drain sweep result: %+v", second)
	}

	for _, id := range []string{expiredA, expiredB, expiredC} {
		var datasets, examples int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM eval_datasets WHERE org_id = $1 AND id = $2`, org, id).Scan(&datasets); err != nil {
			t.Fatalf("count expired dataset: %v", err)
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM eval_examples WHERE org_id = $1 AND dataset_id = $2`, org, id).Scan(&examples); err != nil {
			t.Fatalf("count expired examples: %v", err)
		}
		if datasets != 0 || examples != 0 {
			t.Fatalf("expired %s survived: datasets=%d examples=%d", id, datasets, examples)
		}
	}
	for _, id := range []string{fresh, indefinite, legacyInvalid, legacyOversized} {
		var datasets, examples int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM eval_datasets WHERE org_id = $1 AND id = $2`, org, id).Scan(&datasets); err != nil {
			t.Fatalf("count retained dataset: %v", err)
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM eval_examples WHERE org_id = $1 AND dataset_id = $2`, org, id).Scan(&examples); err != nil {
			t.Fatalf("count retained examples: %v", err)
		}
		if datasets != 1 || examples != 1 {
			t.Fatalf("retained %s changed: datasets=%d examples=%d", id, datasets, examples)
		}
	}
	var experiments int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM experiments WHERE org_id = $1 AND id = $2`, org, experimentID).Scan(&experiments); err != nil {
		t.Fatalf("count experiment evidence: %v", err)
	}
	if experiments != 1 {
		t.Fatalf("experiment evidence must survive dataset expiry: %d", experiments)
	}
}
