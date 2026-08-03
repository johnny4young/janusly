package cron

import (
	"testing"
	"time"
)

func TestBuildHeatmapAndAnomaly(t *testing.T) {
	monday9 := time.Date(2026, 8, 3, 9, 15, 0, 0, time.UTC)
	tuesday3 := time.Date(2026, 8, 4, 3, 0, 0, 0, time.UTC)
	fires := []Fire{
		{At: monday9, Status: "succeeded"},
		{At: monday9.Add(7 * 24 * time.Hour), Status: "succeeded"},
		{At: monday9.Add(14 * 24 * time.Hour), Status: "succeeded"},
		// The Tuesday-03:00 slot fails 3/3 against a healthy baseline.
		{At: tuesday3, Status: "failed"},
		{At: tuesday3.Add(7 * 24 * time.Hour), Status: "failed"},
		{At: tuesday3.Add(14 * 24 * time.Hour), Status: "failed"},
	}
	cells := BuildHeatmap(fires)
	if len(cells) != 2 {
		t.Fatalf("cells: %+v", cells)
	}
	for _, cell := range cells {
		switch {
		case cell.DayOfWeek == 1 && cell.Hour == 9:
			if cell.Total != 3 || cell.Failed != 0 || cell.Anomaly {
				t.Fatalf("healthy slot: %+v", cell)
			}
		case cell.DayOfWeek == 2 && cell.Hour == 3:
			if cell.Total != 3 || cell.Failed != 3 || !cell.Anomaly {
				t.Fatalf("anomalous slot: %+v", cell)
			}
		default:
			t.Fatalf("unexpected cell: %+v", cell)
		}
	}
	// Uniform failure flags nothing (no slot stands out).
	uniform := []Fire{
		{At: monday9, Status: "failed"}, {At: monday9.Add(time.Hour), Status: "failed"},
		{At: monday9, Status: "failed"}, {At: monday9.Add(time.Hour), Status: "failed"},
		{At: monday9, Status: "failed"}, {At: monday9.Add(time.Hour), Status: "failed"},
	}
	for _, cell := range BuildHeatmap(uniform) {
		if cell.Anomaly {
			t.Fatalf("uniform failure must not flag: %+v", cell)
		}
	}
}

func TestNextFiresPreview(t *testing.T) {
	fires := NextFires("0 3 * * *", time.Date(2026, 8, 1, 10, 0, 0, 0, time.UTC), 3)
	if len(fires) != 3 || fires[0].Hour() != 3 || !fires[1].After(fires[0]) {
		t.Fatalf("preview: %v", fires)
	}
	if NextFires("not a cron", time.Now(), 3) != nil {
		t.Fatal("bad expression previews nothing")
	}
}
