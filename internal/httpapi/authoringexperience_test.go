package httpapi

import (
	"encoding/json"
	"github.com/johnny4young/janusly/internal/auth"
	"net/http"
	"strings"
	"testing"
)

func TestExperienceWireRequiresExactSingleObjectKeys(t *testing.T) {
	for _, raw := range []string{
		`{"id":"a","id":"b"}`, `{"ID":"a"}`, `{"id":null}`, `{"id":"a","extra":true}`, `[]`, `null`, `{"id":"a"} {}`, `{"id":"a"} trailing`,
		`{"id":"` + strings.Repeat("a", 9000) + `"}`, string([]byte{'{', '"', 'i', 'd', '"', ':', '"', 255, '"', '}'}),
	} {
		var wire authoringExperienceRevokeWire
		if err := decodeExperienceObject(json.RawMessage(raw), &wire, []string{"id"}); err == nil {
			t.Fatalf("invalid exact object accepted: %q", raw)
		}
	}
	var wire authoringExperienceRevokeWire
	if err := decodeExperienceObject(json.RawMessage(` {"id":"a"} `), &wire, []string{"id"}); err != nil {
		t.Fatal(err)
	}
}

func TestAuthoringExperienceReadRegistryDeclaresAIPermission(t *testing.T) {
	server := &V1Server{}
	server.mountAuthoringExperienceRoutes(http.NewServeMux())
	gate := server.routeAuthz["GET /v1/authoring/experiences"]
	if gate.permission != "ai.write" || gate.role != auth.RoleViewer {
		t.Fatalf("registry hides the mandatory AI permission: %+v", gate)
	}
}
