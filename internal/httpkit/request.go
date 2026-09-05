package httpkit

import (
	"net/http"

	"github.com/johnny4young/janusly/internal/auth"
)

// Request is the authenticated context a gated handler receives: the
// tenant and actor the auth middleware resolved, the request id, and the
// full auth context for audit and permission checks.
type Request struct {
	OrgID  string
	UserID string
	ID     string
	Auth   *auth.Context
}

// HandlerFunc is a gated handler.
type HandlerFunc func(w http.ResponseWriter, r *http.Request, rc Request)

// Gate is one route's authorization annotation: when both are set, BOTH
// must pass, role first.
type Gate struct {
	Role       auth.Role
	Permission string
}

// Registrar mounts gated routes into the API's central authorization
// registry. The root package implements it; feature packages receive it.
type Registrar interface {
	Route(mux *http.ServeMux, pattern string, gate Gate, handler HandlerFunc)
}
