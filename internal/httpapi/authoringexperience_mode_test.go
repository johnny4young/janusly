package httpapi

import (
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/config"
)

func TestAuthoringExperienceModeRejectedBeforeAPIStarts(t *testing.T) {
	_, shutdown, err := NewV1HandlerWithOptions(nil, nil, V1ServerOptions{
		AuthoringExperienceMode: config.AuthoringExperienceMode("PRIVATE_INVALID_MODE"),
	})
	if err == nil || shutdown != nil || !strings.Contains(err.Error(), "JANUSLY_AUTHORING_EXPERIENCE_MODE") || strings.Contains(err.Error(), "PRIVATE_INVALID_MODE") {
		t.Fatalf("invalid mode crossed the API construction boundary: shutdown=%t error=%v", shutdown != nil, err)
	}
}
