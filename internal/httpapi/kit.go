// The root package keeps its unexported opResult/v1Request façade so its
// handlers read as before; the wire logic itself lives in internal/httpkit,
// shared with the feature packages under internal/httpapi/*.
package httpapi

import (
	"net/http"

	"github.com/johnny4young/janusly/internal/httpkit"
)

func toKit(result opResult) httpkit.Result {
	return httpkit.Result{
		Status: result.status, Code: result.code, Message: result.message, Params: result.params,
		Data: result.data, UnversionedExtras: result.unversionedExtras, RetryAfterSec: result.retryAfterSec,
	}
}

func fromKit(result httpkit.Result) opResult {
	return opResult{
		status: result.Status, code: result.Code, message: result.Message, params: result.Params,
		data: result.Data, unversionedExtras: result.UnversionedExtras, retryAfterSec: result.RetryAfterSec,
	}
}

func (rc v1Request) kit() httpkit.Request {
	return httpkit.Request{OrgID: rc.orgID, UserID: rc.userID, ID: rc.id, Auth: rc.authContext}
}

// Route lets feature packages register gated routes through the same
// fail-closed registry as the root package.
func (s *V1Server) Route(mux *http.ServeMux, pattern string, gate httpkit.Gate, handler httpkit.HandlerFunc) {
	s.route(mux, pattern, routeGate{role: gate.Role, permission: gate.Permission},
		func(w http.ResponseWriter, r *http.Request, rc v1Request) { handler(w, r, rc.kit()) })
}

var _ httpkit.Registrar = (*V1Server)(nil)
