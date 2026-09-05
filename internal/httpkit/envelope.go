// Package httpkit is the wire-agnostic HTTP toolkit shared by the API root
// package and its feature packages under internal/httpapi/*: the operation
// result envelope with its unversioned and /v1 encoders, bounded body
// decoding, null projections, and the request context handed to gated
// handlers. It imports no API package, so feature packages depend on it
// without cycles and the root package delegates to it.
package httpkit

import (
	"encoding/json"
	"maps"
	"net/http"
	"strconv"
)

// Result is one operation outcome, wire-agnostic: the same value encodes as
// a raw unversioned body or as the {apiVersion, requestId, data|error}
// envelope of /v1.
type Result struct {
	Status  int
	Code    string
	Message string
	Params  map[string]any
	Data    any
	// UnversionedExtras merge top-level fields into the unversioned error body
	// while /v1 keeps the same values inside params.
	UnversionedExtras map[string]any
	// RetryAfterSec, when set, is emitted as the Retry-After header so a
	// rate-limited client can back off without parsing the body.
	RetryAfterSec int
}

// OK is a 200 carrying data.
func OK(data any) Result { return Result{Status: http.StatusOK, Data: data} }

// Error is a failure with the public code/message contract applied.
func Error(status int, code, message string, params map[string]any) Result {
	status = PublicErrorStatus(code, status)
	message, params = PublicErrorFields(code, message, params)
	return Result{Status: status, Code: code, Message: message, Params: params}
}

// PublicErrorFields is the final defense against reflecting database,
// provider, or evidence details through a generic 500. Callers should still
// pass the stable literal, but both encoders normalize it so a direct Result
// cannot bypass the invariant.
func PublicErrorFields(code, message string, params map[string]any) (string, map[string]any) {
	if code == "internal_error" {
		return "Internal error", nil
	}
	return message, params
}

// PublicErrorStatus pins internal_error to 500 whatever the caller passed.
func PublicErrorStatus(code string, status int) int {
	if code == "internal_error" {
		return http.StatusInternalServerError
	}
	return status
}

func (result Result) normalized(w http.ResponseWriter) Result {
	result.Status = PublicErrorStatus(result.Code, result.Status)
	if result.RetryAfterSec > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(result.RetryAfterSec))
	}
	result.Message, result.Params = PublicErrorFields(result.Code, result.Message, result.Params)
	if result.Code == "internal_error" {
		result.Data = nil
		result.UnversionedExtras = nil
	}
	return result
}

func (result Result) succeeded() bool {
	return result.Data != nil || (result.Status >= 200 && result.Status < 300 && result.Code == "")
}

// WriteUnversioned encodes the raw wire the web uses directly: the data
// itself on success, {error, code, params|extras} on failure.
func WriteUnversioned(w http.ResponseWriter, result Result) {
	result = result.normalized(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(result.Status)
	if result.succeeded() {
		_ = json.NewEncoder(w).Encode(result.Data)
		return
	}
	body := map[string]any{"error": result.Message, "code": result.Code}
	if result.UnversionedExtras != nil {
		maps.Copy(body, result.UnversionedExtras)
	} else if result.Params != nil {
		body["params"] = result.Params
	}
	_ = json.NewEncoder(w).Encode(body)
}

// WriteVersioned encodes the /v1 envelope. Non-200 successes keep their
// status (202 = accepted, run deferred).
func WriteVersioned(w http.ResponseWriter, requestID string, result Result) {
	result = result.normalized(w)
	if result.succeeded() {
		WriteV1(w, requestID, result.Status, map[string]any{"data": result.Data})
		return
	}
	WriteV1Error(w, requestID, result.Status, result.Code, result.Message, result.Params)
}

// WriteV1 stamps the envelope fields and request id onto payload.
func WriteV1(w http.ResponseWriter, requestID string, status int, payload map[string]any) {
	payload["apiVersion"] = "v1"
	payload["requestId"] = requestID
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Request-Id", requestID)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

// WriteV1Data is a 200 envelope around data.
func WriteV1Data(w http.ResponseWriter, requestID string, data any) {
	WriteV1(w, requestID, http.StatusOK, map[string]any{"data": data})
}

// WriteV1Error is the envelope's error shape with the public contract applied.
func WriteV1Error(w http.ResponseWriter, requestID string, status int, code, message string, params map[string]any) {
	status = PublicErrorStatus(code, status)
	message, params = PublicErrorFields(code, message, params)
	errBody := map[string]any{"code": code, "message": message}
	if params != nil {
		errBody["params"] = params
	}
	WriteV1(w, requestID, status, map[string]any{"error": errBody})
}
