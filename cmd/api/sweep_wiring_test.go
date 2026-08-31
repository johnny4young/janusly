package main

import (
	"os"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/observability"
)

// Liveness is only useful when the closed catalog, the supervised runner name,
// and the pass observation use the same label. Keep this source-level ratchet
// next to the boot wiring: adding a loop to only two of those three surfaces
// would otherwise leave a dashboard that looks complete while work silently
// stops.
func TestEverySweepCatalogEntryIsSupervisedAndObserved(t *testing.T) {
	mainSource, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read boot wiring: %v", err)
	}
	owners := map[string]string{
		"SweepRetention":             "../../internal/engine/retention.go",
		"SweepSchedule":              "../../internal/engine/schedule.go",
		"SweepStalledNodeReaper":     "../../internal/engine/reaper.go",
		"SweepSubworkflowReconciler": "../../internal/engine/subworkflow.go",
		"SweepAutoHealing":           "../../internal/engine/autohealing.go",
		"SweepMemoryConsentPurge":    "../../internal/engine/memorypurge.go",
		"SweepRunSummaryMemory":      "../../internal/engine/runsummarymemory.go",
		"SweepUpstreamHealth":        "../../internal/upstream/poller.go",
		"SweepReplayCampaignPump":    "../../internal/engine/campaign.go",
	}
	if len(owners) != len(observability.SweepNames()) {
		t.Fatalf("wiring owners = %d, catalog sweeps = %d", len(owners), len(observability.SweepNames()))
	}
	for constant, ownerPath := range owners {
		token := "observability." + constant
		if got := strings.Count(string(mainSource), "runner.Go("+token); got != 1 {
			t.Errorf("%s boot registrations = %d, want 1", token, got)
		}
		ownerSource, err := os.ReadFile(ownerPath)
		if err != nil {
			t.Fatalf("read %s: %v", ownerPath, err)
		}
		if got := strings.Count(string(ownerSource), "ObserveSweepPass("+token); got == 0 {
			t.Errorf("%s has no pass observation in %s", token, ownerPath)
		}
	}
}
