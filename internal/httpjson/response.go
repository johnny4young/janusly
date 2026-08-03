// Package httpjson bounds JSON decoded from remote HTTP responses.
package httpjson

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

var ErrResponseTooLarge = errors.New("HTTP response body too large")

// Decode reads at most maxBytes of one JSON response before unmarshalling it.
// The extra byte distinguishes an exact-cap body from a truncated prefix.
func Decode(body io.Reader, maxBytes int64, into any) error {
	if maxBytes <= 0 {
		return fmt.Errorf("invalid HTTP response body cap %d", maxBytes)
	}
	raw, err := io.ReadAll(io.LimitReader(body, maxBytes+1))
	if err != nil {
		return err
	}
	if int64(len(raw)) > maxBytes {
		return fmt.Errorf("%w: cap %d", ErrResponseTooLarge, maxBytes)
	}
	return json.Unmarshal(raw, into)
}
