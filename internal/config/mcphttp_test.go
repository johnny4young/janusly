package config

import (
	"slices"
	"strings"
	"testing"
)

func TestRemoteMCPIsOffUntilEnabled(t *testing.T) {
	cfg, err := Load(env(map[string]string{"JANUSLY_WEB_BASE_URL": "https://janusly.example.com"}))
	if err != nil || cfg.MCPHTTP.Enabled {
		t.Fatalf("remote MCP enabled by default: %+v %v", cfg.MCPHTTP, err)
	}
}

func TestRemoteMCPAllowsTheWebHostAndListedOrigins(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"JANUSLY_ENV": "production", "JANUSLY_MCP_HTTP_ENABLED": "true",
		"JANUSLY_WEB_BASE_URL":        "https://Janusly.Example.com/app",
		"JANUSLY_MCP_ALLOWED_HOSTS":   "mcp.example.com, internal.example.com",
		"JANUSLY_MCP_ALLOWED_ORIGINS": "https://studio.example.com/",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.MCPHTTP.Enabled || !slices.Equal(cfg.MCPHTTP.AllowedHosts, []string{"janusly.example.com", "mcp.example.com", "internal.example.com"}) ||
		!slices.Equal(cfg.MCPHTTP.AllowedOrigins, []string{"https://studio.example.com"}) {
		t.Fatalf("remote MCP config: %+v", cfg.MCPHTTP)
	}
}

func TestRemoteMCPRefusesUnsafeConfiguration(t *testing.T) {
	for name, values := range map[string]map[string]string{
		"production without a web URL": {"JANUSLY_ENV": "production"},
		"production over http":         {"JANUSLY_ENV": "production", "JANUSLY_WEB_BASE_URL": "http://janusly.example.com"},
		"host with a scheme":           {"JANUSLY_MCP_ALLOWED_HOSTS": "https://mcp.example.com"},
		"origin with a path":           {"JANUSLY_MCP_ALLOWED_ORIGINS": "https://studio.example.com/app"},
		"not a boolean":                {"JANUSLY_MCP_HTTP_ENABLED": "yes"},
	} {
		if _, ok := values["JANUSLY_MCP_HTTP_ENABLED"]; !ok {
			values["JANUSLY_MCP_HTTP_ENABLED"] = "true"
		}
		if _, err := Load(env(values)); err == nil || !strings.Contains(err.Error(), "MCP") {
			t.Fatalf("%s accepted: %v", name, err)
		}
	}
}
