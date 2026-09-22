package engine

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/config"
)

func TestReaperSettingsAreOwnedByEngineNotAmbientEnvironment(t *testing.T) {
	settings := config.DefaultReaper()
	settings.Threshold = 48 * time.Hour
	engine := New(nil, WithReaper(settings))
	settings.Threshold = time.Second
	t.Setenv("JANUSLY_REAPER_THRESHOLD_MS", "bad-value")
	t.Setenv("JANUSLY_REAPER_THRESHOLD_FLOOR_MS", "1")
	if engine.reaper.EffectiveThreshold() != 48*time.Hour {
		t.Fatal("engine settings changed after construction")
	}
	if New(nil).reaper != config.DefaultReaper() {
		t.Fatal("default constructor reread ambient environment")
	}
}

func TestReaperCancelsAndReportsExplicitFloor(t *testing.T) {
	settings := config.DefaultReaper()
	settings.Threshold = time.Second
	settings.Floor = 2 * time.Second
	settings.FloorOverridden = true
	engine := New(nil, WithReaper(settings))
	var output bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&output, nil))
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	engine.StartReaper(ctx, logger)
	if !strings.Contains(output.String(), "floor=2s") || !strings.Contains(output.String(), "threshold=2s") {
		t.Fatalf("missing effective floor warning: %s", output.String())
	}
}
