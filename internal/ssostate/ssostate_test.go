package ssostate

import (
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/signedtoken"
)

func TestStateBindsPurposePayloadAndSingleExpiry(t *testing.T) {
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "sso-state-test-secret")
	before := time.Now().Unix()
	token, err := Create("org-a", "001122", "https://api.example.com/auth/sso/callback")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	after := time.Now().Unix()
	if expires := token.ExpiresAt.Unix(); expires < before+TTLSeconds || expires > after+TTLSeconds {
		t.Fatalf("expiry must come from the signed envelope: %v", token.ExpiresAt)
	}
	envelope, err := Verify(token.Value)
	if err != nil || envelope.Payload.OrgID != "org-a" || envelope.Payload.Nonce != "001122" ||
		envelope.Payload.CallbackURL != "https://api.example.com/auth/sso/callback" {
		t.Fatalf("verify: envelope=%+v err=%v", envelope, err)
	}
	if _, err := signedtoken.Verify[Payload](token.Value, "sso_session"); err == nil {
		t.Fatal("state must not replay across token purposes")
	}
}

func TestStateRejectsMissingBindings(t *testing.T) {
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "sso-state-test-secret")
	for _, payload := range []Payload{
		{Nonce: "n", CallbackURL: "https://callback"},
		{OrgID: "org", CallbackURL: "https://callback"},
		{OrgID: "org", Nonce: "n"},
	} {
		value, _, err := signedtoken.Sign(Purpose, payload, TTLSeconds)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := Verify(value); !IsInvalid(err) {
			t.Fatalf("missing binding must reject: payload=%+v err=%v", payload, err)
		}
	}
	if _, err := Create("", "n", "https://callback"); !IsInvalid(err) {
		t.Fatalf("creation must reject empty binding: %v", err)
	}
}
