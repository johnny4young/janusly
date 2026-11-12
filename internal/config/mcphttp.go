package config

import (
	"net/url"
	"strings"
	"unicode"
)

func loadMCPHTTP(getenv func(string) string, production bool, problems []string) (MCPHTTP, []string) {
	cfg := MCPHTTP{}
	switch raw := strings.TrimSpace(getenv("JANUSLY_MCP_HTTP_ENABLED")); raw {
	case "", "false":
		return cfg, problems
	case "true":
		cfg.Enabled = true
	default:
		return cfg, append(problems, "JANUSLY_MCP_HTTP_ENABLED must be true or false")
	}
	base := strings.TrimSpace(getenv("JANUSLY_WEB_BASE_URL"))
	if base != "" {
		parsed, err := url.Parse(base)
		if err != nil || parsed.Hostname() == "" {
			problems = append(problems, "JANUSLY_WEB_BASE_URL must be an absolute URL when remote MCP is enabled")
		} else {
			if production && parsed.Scheme != "https" {
				problems = append(problems, "remote MCP in production requires an https JANUSLY_WEB_BASE_URL")
			}
			cfg.AllowedHosts = append(cfg.AllowedHosts, strings.ToLower(parsed.Hostname()))
			if (parsed.Scheme == "https" || parsed.Scheme == "http") && parsed.User == nil {
				cfg.BaseURL = parsed.Scheme + "://" + parsed.Host
			}
		}
	} else if production {
		problems = append(problems, "remote MCP in production requires an https JANUSLY_WEB_BASE_URL")
	}
	for _, host := range splitList(getenv("JANUSLY_MCP_ALLOWED_HOSTS")) {
		if strings.ContainsAny(host, "/:@ ") {
			problems = append(problems, "JANUSLY_MCP_ALLOWED_HOSTS lists bare host names, without scheme or port")
			continue
		}
		cfg.AllowedHosts = append(cfg.AllowedHosts, strings.ToLower(host))
	}
	cfg.RefuseForwardedHTTP = production && getenv("JANUSLY_TRUSTED_PROXY") == "true"
	return cfg, problems
}

func splitList(raw string) []string {
	return strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || unicode.IsSpace(r) })
}
