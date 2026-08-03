// Pluggable object store for pdf.generate (and any future tool that
// persists binary artifacts and hands back a URL) — the reference's
// object-store.ts shape: providers resolved from env AT CALL TIME,
// put() NEVER throws (every failure degrades to {ok:false, error,
// provider}), and the per-org key prefix the CALLER assembles is the
// only tenant isolation — this module trusts its key.
//
//   - local: writes under JANUSLY_OBJECT_STORE_LOCAL_DIR, returns a
//     file:// URL. Keys are sanitized against path traversal.
//   - s3:    the S3-compatible SEAM — selected by env like the
//     reference; the pilot ships the interface + selection, the SigV4
//     driver plugs here without touching any caller (deliberate
//     follow-up; the envelope says so honestly).
//   - noop:  the default — "Object store not configured", never a throw.
package objectstore

import (
	"context"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// PutResult is the never-throw envelope.
type PutResult struct {
	Ok       bool   `json:"ok"`
	Provider string `json:"provider"`
	URL      string `json:"url,omitempty"`
	Key      string `json:"key,omitempty"`
	Error    string `json:"error,omitempty"`
}

// resolveProvider ports getObjectStore's ladder.
func resolveProvider(override string) string {
	requested := strings.ToLower(override)
	if requested == "" {
		requested = strings.ToLower(os.Getenv("JANUSLY_OBJECT_STORE_PROVIDER"))
	}
	switch {
	case requested == "s3" && os.Getenv("JANUSLY_OBJECT_STORE_BUCKET") != "":
		return "s3"
	case requested == "local" && os.Getenv("JANUSLY_OBJECT_STORE_LOCAL_DIR") != "":
		return "local"
	default:
		return "noop"
	}
}

// sanitizeKey refuses traversal and normalizes separators; empty result
// means the key was hostile.
func sanitizeKey(key string) string {
	cleaned := filepath.ToSlash(filepath.Clean("/" + key))
	if strings.Contains(cleaned, "..") {
		return ""
	}
	return strings.TrimPrefix(cleaned, "/")
}

// Put stores one object. NEVER panics or errors out-of-band.
func Put(ctx context.Context, providerOverride, key string, body []byte, contentType string) PutResult {
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	safeKey := sanitizeKey(key)
	if safeKey == "" || len(body) == 0 {
		return PutResult{Ok: false, Provider: "noop", Error: "object store key or body invalid"}
	}
	switch resolveProvider(providerOverride) {
	case "local":
		root := os.Getenv("JANUSLY_OBJECT_STORE_LOCAL_DIR")
		destination := filepath.Join(root, filepath.FromSlash(safeKey))
		// Defense in depth: the joined path must stay under the root.
		absRoot, err := filepath.Abs(root)
		if err != nil {
			return PutResult{Ok: false, Provider: "local", Error: "object store root unavailable"}
		}
		absDestination, err := filepath.Abs(destination)
		if err != nil || !strings.HasPrefix(absDestination, absRoot+string(os.PathSeparator)) {
			return PutResult{Ok: false, Provider: "local", Error: "object store key escapes the root"}
		}
		if err := os.MkdirAll(filepath.Dir(absDestination), 0o755); err != nil {
			return PutResult{Ok: false, Provider: "local", Error: "object store mkdir failed"}
		}
		if err := os.WriteFile(absDestination, body, 0o644); err != nil {
			return PutResult{Ok: false, Provider: "local", Error: "object store write failed"}
		}
		fileURL := url.URL{Scheme: "file", Path: filepath.ToSlash(absDestination)}
		return PutResult{Ok: true, Provider: "local", URL: fileURL.String(), Key: safeKey}
	case "s3":
		// The real SigV4 driver: hand-rolled signing, path-style
		// against custom endpoints (MinIO/R2), presigned GET or CDN URLs.
		return s3Put(ctx, safeKey, body, contentType)
	default:
		return PutResult{Ok: false, Provider: "noop",
			Error: "Object store not configured. Set JANUSLY_OBJECT_STORE_PROVIDER=local|s3 and its settings."}
	}
}
