package httpkit

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNegotiateEncoding(t *testing.T) {
	cases := []struct {
		accept string
		want   string
	}{
		{"", ""},
		{"gzip, deflate, br, zstd", "br"},
		{"gzip", "gzip"},
		{"GZIP;q=0.5", "gzip"},
		{"br;q=0.2, gzip;q=0.8", "gzip"},
		{"br;q=0, gzip", "gzip"},
		{"gzip;q=0, br;q=0", ""},
		{"identity", ""},
		{"*", "br"},
		{"*;q=0.5, br;q=0", "gzip"},
		{"deflate, compress", ""},
		{"br;q=bogus, gzip", "gzip"},
		{"br;q=2, gzip", "gzip"},
	}
	for _, tc := range cases {
		if got := NegotiateEncoding(tc.accept, "br", "gzip"); got != tc.want {
			t.Errorf("NegotiateEncoding(%q) = %q, want %q", tc.accept, got, tc.want)
		}
	}
}

func TestServeEncodedKeepsLengthAndConditionals(t *testing.T) {
	body := []byte("compressed-bytes")
	etag := StrongETag(body)
	serve := func(method string, headers map[string]string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, "/doc", nil)
		for name, value := range headers {
			request.Header.Set(name, value)
		}
		recorder := httptest.NewRecorder()
		recorder.Header().Set("ETag", etag)
		ServeEncoded(recorder, request, "gzip", bytes.NewReader(body))
		return recorder
	}

	full := serve(http.MethodGet, nil)
	if full.Code != 200 || full.Header().Get("Content-Encoding") != "gzip" || full.Header().Get("Content-Length") != "16" || full.Body.String() != string(body) {
		t.Fatalf("full: %d %v %q", full.Code, full.Header(), full.Body.String())
	}
	head := serve(http.MethodHead, nil)
	if head.Code != 200 || head.Header().Get("Content-Length") != "16" || head.Body.Len() != 0 {
		t.Fatalf("head: %d %v %d", head.Code, head.Header(), head.Body.Len())
	}
	notModified := serve(http.MethodGet, map[string]string{"If-None-Match": etag})
	if notModified.Code != 304 || notModified.Header().Get("Content-Encoding") != "" || notModified.Body.Len() != 0 {
		t.Fatalf("revalidation: %d %v", notModified.Code, notModified.Header())
	}
	ranged := serve(http.MethodGet, map[string]string{"Range": "bytes=0-3"})
	if ranged.Code != 200 || ranged.Body.String() != string(body) {
		t.Fatalf("an encoded body is never sliced: %d %q", ranged.Code, ranged.Body.String())
	}
}
