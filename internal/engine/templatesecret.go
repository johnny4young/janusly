package engine

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/secretstore"
	"github.com/johnny4young/janusly/internal/store"
)

// templateSecretKind is the only credential kind {{secret.X}} resolves, so an
// admin opts each credential in. Other kinds stay reachable only through their
// integration tools, which pin where the secret may be sent.
const templateSecretKind = "template_secret"

// errTemplateSecretUnavailable keeps a store or key outage distinct from a
// missing secret without echoing any reference.
var errTemplateSecretUnavailable = errors.New("secret store unavailable")

// templateSecretLookup resolves {{secret.X}} for one node render against the
// claim's organization. A name resolves only when exactly one unexpired
// credential of templateSecretKind matches it case-insensitively.
type templateSecretLookup struct {
	ctx      context.Context
	queries  *store.Queries
	orgID    string
	now      time.Time
	resolved map[string]string
	err      error
}

func (e *Engine) newTemplateSecretLookup(ctx context.Context, orgID string) *templateSecretLookup {
	return &templateSecretLookup{
		ctx: ctx, queries: store.New(e.pool), orgID: orgID,
		now: e.now().UTC(), resolved: map[string]string{},
	}
}

// find receives the UPPERCASED name the renderer passes; false is the
// renderer's hard "Missing secret" failure.
func (l *templateSecretLookup) find(name string) (string, bool) {
	if value, ok := l.resolved[name]; ok {
		return value, true
	}
	// Reserved platform names read as unset, as they do for env refs.
	if l.err != nil || strings.HasPrefix(name, "JANUSLY_") {
		return "", false
	}
	rows, err := l.queries.ListTemplateSecretCredentials(l.ctx, store.ListTemplateSecretCredentialsParams{
		OrgID: l.orgID, Kind: templateSecretKind, UpperName: name,
	})
	if err != nil {
		l.err = errTemplateSecretUnavailable
		return "", false
	}
	if len(rows) != 1 || (rows[0].ExpiresAt != nil && !rows[0].ExpiresAt.After(l.now)) {
		return "", false
	}
	value, err := secretstore.ResolveCredentialSecretRefWithError(l.ctx, l.queries, l.orgID, rows[0].SecretRef)
	if err != nil {
		l.err = errTemplateSecretUnavailable
		return "", false
	}
	// A value below the redaction floor could not be scrubbed from outputs.
	if len(value) < grammar.MinRedactedLength {
		return "", false
	}
	l.resolved[name] = value
	return value, true
}
