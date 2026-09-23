//go:build integration

package engine

import (
	"context"
	"testing"
	"time"
)

// A bounded selector must still visit every tenant during a completed pass.
// The former unpaged LIMIT 500 could report a successful sweep while never
// fitting at least one of 501 otherwise eligible organizations.
func TestCalibrationSweepVisitsMoreThanOneOrgPage(t *testing.T) {
	_, pool, eng, suffix := newHarness(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	prefix := "cal-page-" + suffix

	_, err := pool.Exec(ctx, `INSERT INTO recovery_feedback
		(id, org_id, dead_letter_id, workflow_id, suggestion_mode,
		 approach_label, accepted, raw_confidence)
		SELECT $1 || '-fb-' || org::text || '-' || sample::text,
		       $1 || '-org-' || lpad(org::text, 4, '0'),
		       'dl-cal-page', 'wf-cal-page', 'ai', 'add_retry',
		       CASE WHEN sample < 12 THEN sample % 4 = 0 ELSE sample % 6 <> 0 END,
		       CASE WHEN sample < 12 THEN 25 ELSE 90 END
		FROM generate_series(1, 501) AS org
		CROSS JOIN generate_series(0, 23) AS sample`, prefix)
	if err != nil {
		t.Fatalf("seed 501 organizations: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		for _, table := range []string{"confidence_calibrations", "recovery_feedback"} {
			if _, err := pool.Exec(cleanupCtx, "DELETE FROM "+table+" WHERE org_id LIKE $1", prefix+"%"); err != nil {
				t.Errorf("clean %s: %v", table, err)
			}
		}
	})

	if _, err := eng.RunCalibrationSweep(ctx); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	var covered int
	if err := pool.QueryRow(ctx, `SELECT count(DISTINCT org_id)
		FROM confidence_calibrations WHERE org_id LIKE $1`, prefix+"%").Scan(&covered); err != nil {
		t.Fatalf("count covered organizations: %v", err)
	}
	if covered != 501 {
		t.Fatalf("completed sweep covered %d of 501 organizations", covered)
	}
}
