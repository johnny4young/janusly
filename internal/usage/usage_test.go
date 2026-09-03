package usage

import (
	"context"
	"math"
	"strings"
	"testing"
)

func TestDBRecorderRejectsInvalidBillingNumbersBeforePersistence(t *testing.T) {
	negative := -1
	if err := NewDBRecorder(nil)(context.Background(), Record{TotalTokens: &negative}); err == nil ||
		!strings.Contains(err.Error(), "totalTokens") {
		t.Fatalf("negative tokens were not rejected before DB access: %v", err)
	}
	infinite := math.Inf(1)
	if err := NewDBRecorder(nil)(context.Background(), Record{CostUsd: &infinite}); err == nil ||
		!strings.Contains(err.Error(), "costUsd") {
		t.Fatalf("non-finite cost was not rejected before DB access: %v", err)
	}
}
