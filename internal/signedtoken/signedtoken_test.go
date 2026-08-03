package signedtoken

import (
	"errors"
	"strings"
	"testing"
	"time"
)

type sessionPayload struct {
	SessionID string `json:"sessionId"`
}

func TestSignedTokenMatchesReferenceBytesAndPurposeBoundary(t *testing.T) {
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "compat-secret")
	now := time.Unix(1_700_000_000, 0)
	token, envelope, err := signAt("sso_session", sessionPayload{SessionID: "session-1"}, 600, now)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	const referenceToken = "v1.eyJwdXJwb3NlIjoic3NvX3Nlc3Npb24iLCJwYXlsb2FkIjp7InNlc3Npb25JZCI6InNlc3Npb24tMSJ9LCJpc3N1ZWRBdCI6MTcwMDAwMDAwMCwiZXhwaXJlc0F0IjoxNzAwMDAwNjAwfQ.fo8L-UDHhWiyEBTlIXyxocghNehZ8uZavVTBha2zxTc"
	if token != referenceToken {
		t.Fatalf("reference token drift:\nwant %s\n got %s", referenceToken, token)
	}
	if envelope.ExpiresAt-envelope.IssuedAt != 600 {
		t.Fatalf("signed lifetime: %+v", envelope)
	}

	verified, err := verifyAt[sessionPayload](token, "sso_session", now.Add(599*time.Second))
	if err != nil || verified.Payload.SessionID != "session-1" {
		t.Fatalf("verify: %+v %v", verified, err)
	}
	if _, err := verifyAt[sessionPayload](token, "sso_state", now); !errors.Is(err, ErrInvalid) {
		t.Fatalf("cross-purpose replay must fail uniformly: %v", err)
	}
	if _, err := verifyAt[sessionPayload](token, "sso_session", now.Add(600*time.Second)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("token must expire at the signed boundary: %v", err)
	}
	if _, err := verifyAt[sessionPayload](token[:len(token)-2]+"xx", "sso_session", now); !errors.Is(err, ErrInvalid) {
		t.Fatalf("tampered token must fail uniformly: %v", err)
	}
	if _, err := verifyAt[sessionPayload](strings.Join(strings.Split(token, ".")[:2], "."), "sso_session", now); !errors.Is(err, ErrInvalid) {
		t.Fatalf("truncated token must fail uniformly: %v", err)
	}
}

func TestSignedTokenRejectsInvalidLifetimeAndRequiresProductionSecret(t *testing.T) {
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "compat-secret")
	now := time.Unix(1_700_000_000, 0)
	if _, _, err := signAt("sso_session", sessionPayload{}, 0, now); !errors.Is(err, ErrInvalid) {
		t.Fatalf("zero TTL must fail: %v", err)
	}
	if _, _, err := signAt("", sessionPayload{}, 600, now); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty purpose must fail: %v", err)
	}

	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "")
	t.Setenv("JANUSLY_GO_ENV", "production")
	if _, _, err := Sign("sso_session", sessionPayload{}, 600); err == nil || errors.Is(err, ErrInvalid) {
		t.Fatalf("production must require the dedicated secret: %v", err)
	}
}
