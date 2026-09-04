//go:build integration

package engine

import (
	"context"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

// janusly_dead_letters{status} reports the production queue across tenants;
// sandbox replays (replay_mode set) are never counted.
func TestDeadLetterCollectorCountsProductionRowsByStatus(t *testing.T) {
	ctx, pool, _, org := newHarness(t)
	runID := "run-" + org
	if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, status, input_json, workflow_version_id) VALUES ($1, $2, 'failed', '{}', 'wv-dlq')`, runID, org); err != nil {
		t.Fatal(err)
	}
	seed := func(id, status string, replayMode *string) {
		if _, err := pool.Exec(ctx, `INSERT INTO dead_letters (id, org_id, run_id, node_id, workflow_json, node_json, error_json, status, replay_mode)
			VALUES ($1, $2, $3, 'step', '{}', '{}', '{}', $4, $5)`, org+"-"+id, org, runID, status, replayMode); err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
	}
	validation := "validation"
	seed("a", "open", nil)
	seed("b", "open", nil)
	seed("c", "resolved", nil)
	seed("d", "open", &validation)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM dead_letters WHERE org_id = $1`, org)
		_, _ = pool.Exec(context.Background(), `DELETE FROM runs WHERE org_id = $1`, org)
	})

	// Other suites leave rows behind: compare the gauge with the same
	// production-only count the collector promises.
	expected := map[string]float64{}
	rows, err := pool.Query(ctx, `SELECT status, count(*)::float8 FROM dead_letters WHERE replay_mode IS NULL GROUP BY status`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var status string
		var count float64
		_ = rows.Scan(&status, &count)
		expected[status] = count
	}
	rows.Close()
	if expected["open"] < 2 || expected["resolved"] < 1 {
		t.Fatalf("seed did not land: %v", expected)
	}

	registry := prometheus.NewPedanticRegistry()
	if err := registry.Register(NewDeadLetterCollector(pool)); err != nil {
		t.Fatal(err)
	}
	families, err := registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]float64{}
	for _, family := range families {
		if family.GetName() != "janusly_dead_letters" {
			continue
		}
		for _, metric := range family.GetMetric() {
			for _, label := range metric.GetLabel() {
				if label.GetName() == "status" {
					got[label.GetValue()] = metric.GetGauge().GetValue()
				}
			}
		}
	}
	for _, status := range []string{"open", "replayed", "resolved"} {
		if got[status] != expected[status] {
			t.Fatalf("%s: gauge %v, want %v (got %v)", status, got[status], expected[status], got)
		}
	}
}
