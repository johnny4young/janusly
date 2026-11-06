package engine

import (
	"testing"

	"github.com/johnny4young/janusly/internal/auth"
)

// A service token's user id is a free-form header, so it never stands in for a person.
func TestApprovalActorIDTreatsServiceTokensAsTheToken(t *testing.T) {
	if got := ApprovalActorID(&auth.Context{UserID: "alice", Mode: auth.ModeServiceToken, ServiceTokenSuffix: "abcd"}); got != "service-token:abcd" {
		t.Fatalf("service token actor %q", got)
	}
	if got := ApprovalActorID(&auth.Context{UserID: "alice", Mode: auth.ModeSupabase}); got != "alice" {
		t.Fatalf("person actor %q", got)
	}
	if ApprovalActorID(nil) != "" {
		t.Fatal("no actor must record nobody")
	}
}
