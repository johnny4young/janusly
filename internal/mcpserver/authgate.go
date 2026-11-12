package mcpserver

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	sdkauth "github.com/modelcontextprotocol/go-sdk/auth"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/httpkit"
	"github.com/johnny4young/janusly/internal/ratelimit"
)

const tokenRejectedAction = "mcp.auth.rejected"

func init() {
	audit.RegisterRuntimeAction(tokenRejectedAction)
}

// failedAuthLimit bounds credential failures per client address, which also
// bounds the audit rows an anonymous caller can write.
var failedAuthLimit = ratelimit.Options{Name: "mcp.auth.failed", Max: 20, Window: time.Minute}

type verifiedPrincipalKey struct{}

// authGate resolves the bearer token before the SDK sees the request, so a
// failure can be counted per address, audited and answered with 401 or 429.
func authGate(deps Deps, resolver agentclient.Resolver, logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, presented := bearerToken(r)
		var principal *agentclient.Principal
		err := sdkauth.ErrInvalidToken
		if presented {
			principal, err = resolver.Resolve(r.Context(), token)
		}
		switch {
		case err == nil:
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), verifiedPrincipalKey{}, principal)))
		case errors.Is(err, agentclient.ErrInvalidToken) || errors.Is(err, sdkauth.ErrInvalidToken):
			deps.refuseCredential(w, r, err, presented)
		default:
			if logger != nil {
				logger.Error("mcp token verification failed", "error", err)
			}
			http.Error(w, errVerificationUnavailable.Error(), http.StatusInternalServerError)
		}
	})
}

// bearerToken parses the header the way the SDK's bearer middleware does.
func bearerToken(r *http.Request) (string, bool) {
	fields := strings.Fields(r.Header.Get("Authorization"))
	if len(fields) != 2 || !strings.EqualFold(fields[0], "bearer") {
		return "", false
	}
	return fields[1], true
}

// refuseCredential counts and audits only presented tokens: a probe without
// one keeps the plain 401 challenge and costs no database write.
func (d Deps) refuseCredential(w http.ResponseWriter, r *http.Request, err error, presented bool) {
	if !presented {
		http.Error(w, "no bearer token", http.StatusUnauthorized)
		return
	}
	address := httpkit.ClientAddress(r)
	if limited := d.limitFailedAuth(r.Context(), "ip:"+address); limited != nil {
		result := httpkit.Error(http.StatusTooManyRequests, "rate_limited", limited.Error(), nil)
		result.RetryAfterSec = limited.RetryAfterSec
		httpkit.WriteUnversioned(w, result)
		return
	}
	d.auditTokenRejection(r.Context(), err, address)
	http.Error(w, sdkauth.ErrInvalidToken.Error(), http.StatusUnauthorized)
}

// limitFailedAuth counts one failure; past the limit the caller writes no
// audit row, so the limiter also caps audit volume.
func (d Deps) limitFailedAuth(ctx context.Context, key string) *ratelimit.LimitError {
	if d.Limiter == nil {
		return nil
	}
	// A caller that hangs up must still be counted before it is audited.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	var limited *ratelimit.LimitError
	if errors.As(d.Limiter.Enforce(ctx, key, failedAuthLimit), &limited) {
		return limited
	}
	return nil
}

// auditTokenRejection writes the attempt to the client's organization when
// the digest matched one, else to the system organization. It never records
// the token, its digest or its last characters.
func (d Deps) auditTokenRejection(ctx context.Context, err error, address string) {
	if d.Pool == nil {
		return
	}
	orgID, clientID, reason := ratelimit.SystemOrgID, "", "invalid"
	var rejection *agentclient.RejectedError
	if errors.As(err, &rejection) {
		reason, clientID = rejection.Reason, rejection.ClientID
		if rejection.OrgID != "" {
			orgID = rejection.OrgID
		}
	}
	metadata := map[string]any{"reason": reason, "transport": d.Transport}
	if address != "" {
		metadata["clientAddress"] = address
	}
	d.Audit.SystemWrite(context.WithoutCancel(ctx), d.Pool, orgID, "anonymous", tokenRejectedAction, audit.Options{
		TargetType: "agent_client", TargetID: clientID, Metadata: metadata,
	})
}
