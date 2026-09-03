package authoring

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/johnny4young/janusly/internal/mcpclient"
)

type unavailableMcpCatalog struct{}

func (unavailableMcpCatalog) ListExposedToolsForCatalog(context.Context, string) ([]mcpclient.ExposedMcpTool, error) {
	return nil, errors.New("catalog unavailable")
}

type truncatedMcpCatalog struct{}

func (truncatedMcpCatalog) ListExposedToolsForCatalog(context.Context, string) ([]mcpclient.ExposedMcpTool, error) {
	return []mcpclient.ExposedMcpTool{
		{ConnectionAlias: "crm", ToolName: "contacts.read"},
		{ConnectionAlias: "_truncated", ToolName: "_truncated", Description: "1 more truncated"},
	}, nil
}

func TestCapabilityBuilderUsesCompleteRuntimeRegistry(t *testing.T) {
	t.Parallel()
	catalog := NewBuilder(nil, nil).Build(context.Background(), "catalog-test")
	if len(catalog.BuiltinTools) != 29 {
		t.Fatalf("builtin tools=%d want complete 29-tool runtime catalog", len(catalog.BuiltinTools))
	}
	byName := make(map[string]bool, len(catalog.BuiltinTools))
	for _, tool := range catalog.BuiltinTools {
		byName[tool.Name] = true
	}
	for _, name := range []string{"http.request", "csv.fetch", "time.now", "pagerduty.incident.get"} {
		if !byName[name] {
			t.Fatalf("runtime capability %q missing from authoring catalog", name)
		}
	}
	wire, err := json.Marshal(catalog)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range [][]byte{[]byte(`"required":null`), []byte(`"inputFields":null`)} {
		if bytes.Contains(wire, forbidden) {
			t.Fatalf("built-in capability catalog violated its array contract with %s: %s", forbidden, wire)
		}
	}
}

func TestBoundedCatalogRowsMakesTruncationVisible(t *testing.T) {
	t.Parallel()
	rows := make([]int, maxDynamicCatalogEntries+1)
	warnings := []string{}
	bounded := boundedCatalogRows(rows, "credentials_truncated", &warnings)
	if len(bounded) != maxDynamicCatalogEntries {
		t.Fatalf("bounded rows=%d want=%d", len(bounded), maxDynamicCatalogEntries)
	}
	if len(warnings) != 1 || warnings[0] != "credentials_truncated" {
		t.Fatalf("truncation must be explicit: %+v", warnings)
	}
}

func TestCapabilityBuilderMakesMcpDiscoveryFailureVisible(t *testing.T) {
	t.Parallel()
	catalog := NewBuilder(nil, unavailableMcpCatalog{}).Build(t.Context(), "catalog-test")
	if len(catalog.McpTools) != 0 {
		t.Fatalf("failed MCP discovery returned callable tools: %+v", catalog.McpTools)
	}
	if len(catalog.Warnings) != 1 || catalog.Warnings[0] != "mcp_tools_unavailable" {
		t.Fatalf("MCP discovery failure was indistinguishable from an empty catalog: %+v", catalog.Warnings)
	}
}

func TestCapabilityBuilderMakesMcpTruncationVisible(t *testing.T) {
	t.Parallel()
	catalog := NewBuilder(nil, truncatedMcpCatalog{}).Build(t.Context(), "catalog-test")
	if len(catalog.McpTools) != 2 {
		t.Fatalf("MCP truncation sentinel must remain available to bounded prompt projection: %+v", catalog.McpTools)
	}
	if len(catalog.Warnings) != 1 || catalog.Warnings[0] != "mcp_tools_truncated" {
		t.Fatalf("MCP truncation was not operator-visible: %+v", catalog.Warnings)
	}
	for _, tool := range catalog.McpTools {
		if tool.InputFields == nil {
			t.Fatalf("MCP inputFields must remain an iterable array for %s/%s", tool.ConnectionAlias, tool.ToolName)
		}
	}
	wire, err := json.Marshal(catalog)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(wire, []byte(`"inputFields":null`)) {
		t.Fatalf("capability catalog violated its array contract: %s", wire)
	}
}
