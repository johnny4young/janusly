package httpkit

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

// DefaultBodyLimit bounds ordinary JSON request bodies.
const DefaultBodyLimit int64 = 2 << 20

// DecodeBody decodes a strict JSON body under the default limit.
func DecodeBody(r *http.Request, into any) error {
	return DecodeBodyBounded(r, into, DefaultBodyLimit)
}

// DecodeBodyBounded decodes exactly one strict JSON value under maxBytes.
func DecodeBodyBounded(r *http.Request, into any, maxBytes int64) error {
	decoder := json.NewDecoder(http.MaxBytesReader(nil, r.Body, maxBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		return err
	}
	// A strict body is exactly one JSON value. Decoder.Decode alone accepts a
	// valid prefix followed by a second document, which lets clients sign,
	// audit, or reason about different bytes than the handler actually uses.
	// Whitespace after the first value still resolves to io.EOF.
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("request body must contain exactly one JSON value")
		}
		return err
	}
	return nil
}

// ReadRawBody preserves the exact signed bytes while enforcing the same hard
// cap as the public API contract, writing the rejection itself. LimitReader
// alone is insufficient: it silently turns an oversized signed payload into
// a valid truncated prefix.
func ReadRawBody(w http.ResponseWriter, r *http.Request, maxBytes int64) ([]byte, bool) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBytes))
	if err == nil {
		return raw, true
	}
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		WriteUnversioned(w, Error(http.StatusRequestEntityTooLarge, "server_request_failed",
			fmt.Sprintf("Request body too large. Limit is %d bytes", maxBytes), nil))
		return nil, false
	}
	WriteUnversioned(w, Error(http.StatusInternalServerError, "internal_error", "Internal error", nil))
	return nil, false
}
