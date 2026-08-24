// Pluggable object store for pdf.generate (and any future tool that
// persists binary artifacts and hands back a URL) — the contract's
// object-store.ts shape: providers resolved from env AT CALL TIME,
// put() NEVER throws (every failure degrades to {ok:false, error,
// provider}), and the per-org key prefix the CALLER assembles is the
// only tenant isolation — this module trusts its key.
//
//   - local: writes under JANUSLY_OBJECT_STORE_LOCAL_DIR, returns a
//     file:// URL. Keys are sanitized against path traversal.
//   - s3:    the S3-compatible SEAM — selected by env like the
//     reference; the runtime ships the interface + selection, the SigV4
//     driver plugs here without touching any caller (deliberate
//     follow-up; the envelope says so honestly).
//   - noop:  the default — "Object store not configured", never a throw.
package objectstore

import (
	"context"
	"io"
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
		// Resolve the parent after creating it: a pre-existing symlink inside
		// the configured root must not redirect writes outside the store.
		resolvedRoot, err := filepath.EvalSymlinks(absRoot)
		if err != nil {
			return PutResult{Ok: false, Provider: "local", Error: "object store root unavailable"}
		}
		resolvedParent, err := filepath.EvalSymlinks(filepath.Dir(absDestination))
		if err != nil || !pathWithinRoot(resolvedRoot, resolvedParent) {
			return PutResult{Ok: false, Provider: "local", Error: "object store key escapes the root"}
		}
		resolvedDestination := filepath.Join(resolvedParent, filepath.Base(absDestination))
		if err := atomicWriteFile(resolvedDestination, body, 0o644); err != nil {
			return PutResult{Ok: false, Provider: "local", Error: "object store write failed"}
		}
		fileURL := url.URL{Scheme: "file", Path: filepath.ToSlash(resolvedDestination)}
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

// GetResult is the read-side mirror of PutResult. NotFound is a distinct,
// non-error outcome: an append flow's first write legitimately reads
// nothing.
type GetResult struct {
	Ok       bool   `json:"ok"`
	NotFound bool   `json:"notFound,omitempty"`
	Provider string `json:"provider"`
	Body     []byte `json:"-"`
	Error    string `json:"error,omitempty"`
}

// Get reads one object. Same posture as Put: never panics, never errors
// out-of-band, and the noop provider reports itself unconfigured. maxBytes
// bounds how much a caller can pull back into memory (<=0 uses 8 MiB).
func Get(ctx context.Context, providerOverride, key string, maxBytes int64) GetResult {
	if maxBytes <= 0 {
		maxBytes = 8 << 20
	}
	safeKey := sanitizeKey(key)
	if safeKey == "" {
		return GetResult{Ok: false, Provider: "noop", Error: "object store key invalid"}
	}
	switch resolveProvider(providerOverride) {
	case "local":
		root := os.Getenv("JANUSLY_OBJECT_STORE_LOCAL_DIR")
		source := filepath.Join(root, filepath.FromSlash(safeKey))
		absRoot, err := filepath.Abs(root)
		if err != nil {
			return GetResult{Ok: false, Provider: "local", Error: "object store root unavailable"}
		}
		absSource, err := filepath.Abs(source)
		if err != nil || !strings.HasPrefix(absSource, absRoot+string(os.PathSeparator)) {
			return GetResult{Ok: false, Provider: "local", Error: "object store key escapes the root"}
		}
		resolvedRoot, err := filepath.EvalSymlinks(absRoot)
		if err != nil {
			return GetResult{Ok: false, Provider: "local", Error: "object store root unavailable"}
		}
		resolvedSource, err := filepath.EvalSymlinks(absSource)
		if err != nil {
			if os.IsNotExist(err) {
				return GetResult{Ok: false, NotFound: true, Provider: "local"}
			}
			return GetResult{Ok: false, Provider: "local", Error: "object store read failed"}
		}
		if !pathWithinRoot(resolvedRoot, resolvedSource) {
			return GetResult{Ok: false, Provider: "local", Error: "object store key escapes the root"}
		}
		file, err := os.Open(resolvedSource)
		if err != nil {
			if os.IsNotExist(err) {
				return GetResult{Ok: false, NotFound: true, Provider: "local"}
			}
			return GetResult{Ok: false, Provider: "local", Error: "object store read failed"}
		}
		defer file.Close()
		body, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
		if err != nil {
			return GetResult{Ok: false, Provider: "local", Error: "object store read failed"}
		}
		if int64(len(body)) > maxBytes {
			return GetResult{Ok: false, Provider: "local", Error: "object exceeds the read limit"}
		}
		return GetResult{Ok: true, Provider: "local", Body: body}
	case "s3":
		return s3Get(ctx, safeKey, maxBytes)
	default:
		return GetResult{Ok: false, Provider: "noop",
			Error: "Object store not configured. Set JANUSLY_OBJECT_STORE_PROVIDER=local|s3 and its settings."}
	}
}

func pathWithinRoot(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator))
}

// atomicWriteFile prevents readers and process crashes from observing a
// truncated local object. The temporary file lives in the destination
// directory so rename is atomic on the same filesystem.
func atomicWriteFile(destination string, body []byte, mode os.FileMode) (returnErr error) {
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".janusly-object-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer func() {
		_ = temporary.Close()
		if returnErr != nil {
			_ = os.Remove(temporaryName)
		}
	}()
	if err := temporary.Chmod(mode); err != nil {
		return err
	}
	if _, err := temporary.Write(body); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryName, destination); err != nil {
		return err
	}
	if directory, err := os.Open(filepath.Dir(destination)); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}
