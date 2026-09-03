package authpolicy

import (
	"testing"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/store"
)

func activeConnection(enforced bool) *store.SsoConnection {
	return &store.SsoConnection{Status: "active", EnforcedSso: enforced}
}

func TestDecidePolicyOrderingAndModeMatrix(t *testing.T) {
	config := Config{
		AllowedEmailDomains: []string{"acme.com"}, MFARequired: true, SessionTTLSeconds: 900,
	}
	tests := []struct {
		name       string
		input      Input
		connection *store.SsoConnection
		bypass     bool
		allowed    bool
		policyKey  string
	}{
		{"service bypasses all", Input{Mode: auth.ModeServiceToken}, activeConnection(true), false, true, ""},
		{"supabase enforced first", Input{Mode: auth.ModeSupabase, Email: "bad@partner.com"}, activeConnection(true), false, false, PolicyEnforcedSSO},
		{"dev enforced", Input{Mode: auth.ModeDevHeaders}, activeConnection(true), false, false, PolicyEnforcedSSO},
		{"explicit dev bypass", Input{Mode: auth.ModeSupabase, Email: "ada@acme.com"}, activeConnection(true), true, true, ""},
		{"session skips enforced", Input{Mode: auth.ModeJanuslySession, Email: "ada@acme.com"}, activeConnection(true), false, true, ""},
		{"supabase domain rejected", Input{Mode: auth.ModeSupabase, Email: "ada@partner.com"}, activeConnection(false), false, false, PolicyAllowedDomain},
		{"session missing email rejected", Input{Mode: auth.ModeJanuslySession}, activeConnection(false), false, false, PolicyAllowedDomain},
		{"dev skips domain", Input{Mode: auth.ModeDevHeaders}, activeConnection(false), false, true, ""},
		{"revoked enforcement ignored", Input{Mode: auth.ModeSupabase, Email: "ada@acme.com"}, &store.SsoConnection{Status: "revoked", EnforcedSso: true}, false, true, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			decision := Decide(tt.input, config, tt.connection, tt.bypass)
			if decision.Allowed != tt.allowed || decision.PolicyKey != tt.policyKey || decision.SessionTTLSeconds != 900 {
				t.Fatalf("decision = %+v", decision)
			}
		})
	}
}

func TestParseDomainsMatchesReferenceNormalization(t *testing.T) {
	domains := parseDomains(" Acme.COM, partner.example ,,ACME.com ")
	want := []string{"acme.com", "partner.example", "acme.com"}
	if len(domains) != len(want) {
		t.Fatalf("domains = %v", domains)
	}
	for i := range want {
		if domains[i] != want[i] {
			t.Fatalf("domains = %v", domains)
		}
	}
}
