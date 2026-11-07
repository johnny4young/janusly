package httpkit

import (
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

var noModTime time.Time

// NegotiateEncoding picks the first of offered (in server preference order)
// that the Accept-Encoding header allows, or "" for the identity coding.
func NegotiateEncoding(acceptEncoding string, offered ...string) string {
	if acceptEncoding == "" {
		return ""
	}
	weights := map[string]float64{}
	for part := range strings.SplitSeq(acceptEncoding, ",") {
		coding, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		coding = strings.ToLower(strings.TrimSpace(coding))
		if coding == "" {
			continue
		}
		weight := 1.0
		if name, value, ok := strings.Cut(strings.TrimSpace(params), "="); ok && strings.EqualFold(strings.TrimSpace(name), "q") {
			parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
			if err != nil || parsed < 0 || parsed > 1 {
				continue
			}
			weight = parsed
		}
		weights[coding] = weight
	}
	best, bestWeight := "", 0.0
	for _, coding := range offered {
		weight, ok := weights[coding]
		if !ok {
			weight = weights["*"]
		}
		if weight > bestWeight {
			best, bestWeight = coding, weight
		}
	}
	return best
}

// StrongETag is a quoted content digest; each stored representation gets its own.
func StrongETag(body []byte) string {
	sum := sha256.Sum256(body)
	return `"` + base64.RawURLEncoding.EncodeToString(sum[:12]) + `"`
}

// ServeEncoded serves stored bytes already in the given content coding with
// http.ServeContent's conditional and HEAD handling. Callers set ETag,
// Content-Type and Vary first. Range is ignored here; callers that honor
// ranges serve them from the identity representation.
func ServeEncoded(w http.ResponseWriter, r *http.Request, coding string, content io.ReadSeeker) {
	if r.Header.Get("Range") != "" || r.Header.Get("If-Range") != "" {
		r = r.Clone(r.Context())
		r.Header.Del("Range")
		r.Header.Del("If-Range")
	}
	// ServeContent omits Content-Length once Content-Encoding is present, so
	// the coding is added only as the status is written.
	http.ServeContent(&encodedWriter{ResponseWriter: w, coding: coding}, r, "", noModTime, content)
}

type encodedWriter struct {
	http.ResponseWriter
	coding      string
	wroteHeader bool
}

func (w *encodedWriter) WriteHeader(status int) {
	if !w.wroteHeader {
		w.wroteHeader = true
		if status == http.StatusOK {
			w.Header().Set("Content-Encoding", w.coding)
		}
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *encodedWriter) Write(body []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(body)
}

func (w *encodedWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
