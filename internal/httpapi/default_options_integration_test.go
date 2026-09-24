//go:build integration

package httpapi

import (
	"log/slog"
	"time"
)

// These are test fixture bounds, not a second production configuration path.
// The executable passes its validated process config to NewV1HandlerWithOptions.
func defaultV1ServerOptionsForTest() V1ServerOptions {
	return V1ServerOptions{
		FeedbackMemoryWorkers:       4,
		FeedbackMemoryQueueCapacity: 256,
		FeedbackMemoryTaskTimeout:   15 * time.Second,
		Logger:                      slog.Default(),
		StartRateLimitPerMinute:     startRateLimitFromEnv(),
	}
}
