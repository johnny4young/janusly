package httpapi

import "testing"

func TestInvitationLifecycleLockKeyNormalizesAndSeparatesFields(t *testing.T) {
	if invitationLifecycleLockKey("org", " ADA@EXAMPLE.COM ") !=
		invitationLifecycleLockKey("org", "ada@example.com") {
		t.Fatal("email normalization must map one invitation lifecycle to one lock")
	}
	if invitationLifecycleLockKey("a:b", "c@example.com") ==
		invitationLifecycleLockKey("a", "b:c@example.com") {
		t.Fatal("length-prefixed organization ids must prevent delimiter collisions")
	}
}
