package main

import (
	"strings"
	"testing"
)

// The signer falls back to a constant that ships in the source tree when
// no dedicated secret is configured. Production must refuse to START in
// that state instead of discovering it at the first token operation.
func TestRequireSigningSecret(t *testing.T) {
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "")
	if err := requireSigningSecret(false); err != nil {
		t.Fatalf("development must keep its local fallback: %v", err)
	}
	err := requireSigningSecret(true)
	if err == nil {
		t.Fatal("production without a signing secret must refuse to start")
	}
	if !strings.Contains(err.Error(), "JANUSLY_RESUME_TOKEN_SECRET") {
		t.Fatalf("the error must name the variable to set: %v", err)
	}
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "a-real-deployment-secret")
	if err := requireSigningSecret(true); err != nil {
		t.Fatalf("a configured production deployment must start: %v", err)
	}
	// Whitespace is not a secret.
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "   ")
	if requireSigningSecret(true) == nil {
		t.Fatal("blank secret must be rejected")
	}
}

// The SSO development bypass also disables enforced SSO for real
// Supabase identities, so production must refuse to start with it set
// rather than run with an organization's SSO requirement silently void.
func TestRefuseDevBypassInProduction(t *testing.T) {
	t.Setenv("ALLOW_DEV_SSO_BYPASS", "true")
	if err := refuseDevBypassInProduction(false); err != nil {
		t.Fatalf("development may keep the bypass: %v", err)
	}
	err := refuseDevBypassInProduction(true)
	if err == nil {
		t.Fatal("production with the bypass set must refuse to start")
	}
	if !strings.Contains(err.Error(), "ALLOW_DEV_SSO_BYPASS") {
		t.Fatalf("the error must name the variable: %v", err)
	}
	t.Setenv("ALLOW_DEV_SSO_BYPASS", "")
	if err := refuseDevBypassInProduction(true); err != nil {
		t.Fatalf("production without the bypass must start: %v", err)
	}
}
