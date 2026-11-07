package httpapi

import (
	"bytes"
	"compress/gzip"
	"net/http"
	"sync"
	"time"

	contractdoc "github.com/johnny4young/janusly/contract"
	"github.com/johnny4young/janusly/internal/httpkit"
)

// The contract is public, static and reflects no request input, so it is the
// one API body worth compressing; it is gzipped once per process.
var openAPIGzip = sync.OnceValues(func() ([]byte, string) {
	var buffer bytes.Buffer
	writer, _ := gzip.NewWriterLevel(&buffer, gzip.BestCompression)
	_, _ = writer.Write(contractdoc.OpenAPI)
	_ = writer.Close()
	return buffer.Bytes(), httpkit.StrongETag(buffer.Bytes())
})

var openAPIETag = sync.OnceValue(func() string { return httpkit.StrongETag(contractdoc.OpenAPI) })

func serveOpenAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Add("Vary", "Accept-Encoding")
	if r.Header.Get("Range") == "" && httpkit.NegotiateEncoding(r.Header.Get("Accept-Encoding"), "gzip") == "gzip" {
		body, etag := openAPIGzip()
		w.Header().Set("ETag", etag)
		httpkit.ServeEncoded(w, r, "gzip", bytes.NewReader(body))
		return
	}
	w.Header().Set("ETag", openAPIETag())
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(contractdoc.OpenAPI))
}
