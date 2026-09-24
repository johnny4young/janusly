package httpapi

import (
	"strings"
	"testing"
	"time"
)

// The executable uses this explicit-error constructor. A malformed process
// policy must stop construction, not be hidden behind a nominal HTTP handler.
func TestV1HandlerWithOptionsRejectsInvalidMemoryPolicy(t *testing.T) {
	handler, shutdown, err := NewV1HandlerWithOptions(nil, nil, V1ServerOptions{
		FeedbackMemoryWorkers:       0,
		FeedbackMemoryQueueCapacity: 256,
		FeedbackMemoryTaskTimeout:   15 * time.Second,
	})
	if err == nil || !strings.Contains(err.Error(), "workers") {
		t.Fatalf("want explicit invalid worker error, got %v", err)
	}
	if handler != nil || shutdown != nil {
		t.Fatal("invalid policy must not return a usable handler or shutdown callback")
	}
}
