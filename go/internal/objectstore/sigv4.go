// AWS Signature V4 signing + the real S3-compatible driver.
// Hand-rolled over net/http — no SDK, mirroring the reference's
// S3Provider posture (which deliberately bypasses the SSRF chokepoint:
// the endpoint is OPERATOR configuration, not workflow-author input).
//
// Env contract (reference S3ObjectStoreOptions):
//
//	JANUSLY_OBJECT_STORE_BUCKET            — required for the s3 provider
//	JANUSLY_OBJECT_STORE_ENDPOINT          — MinIO/R2 custom endpoint;
//	  when set, path-style URLs are forced (certificate-of-name reality)
//	JANUSLY_OBJECT_STORE_REGION            — default us-east-1
//	JANUSLY_OBJECT_STORE_PUBLIC_BASE_URL   — CDN-fronted public URLs
//	JANUSLY_OBJECT_STORE_PRESIGN_TTL_SECONDS — presigned GET TTL (3600)
//	AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY — standard credentials
package objectstore

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"os"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

var sigv4Now = time.Now // test seam

const sigv4Service = "s3"

func hmacSHA256(key, message []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(message)
	return mac.Sum(nil)
}

func sha256Hex(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// signingKey derives the AWS4 HMAC chain: secret → date → region →
// service → aws4_request.
func signingKey(secret, date, region string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secret), []byte(date))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(sigv4Service))
	return hmacSHA256(kService, []byte("aws4_request"))
}

// uriEncode is the AWS canonical URI encoding (RFC 3986, "/" preserved
// for paths, everything else strict).
func uriEncode(value string, encodeSlash bool) string {
	var out strings.Builder
	for _, b := range []byte(value) {
		switch {
		case (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9') ||
			b == '-' || b == '_' || b == '.' || b == '~':
			out.WriteByte(b)
		case b == '/' && !encodeSlash:
			out.WriteByte(b)
		default:
			fmt.Fprintf(&out, "%%%02X", b)
		}
	}
	return out.String()
}

// canonicalQuery sorts and encodes query parameters per SigV4.
func canonicalQuery(values url.Values) string {
	keys := slices.Sorted(maps.Keys(values))
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		sorted := append([]string(nil), values[key]...)
		sort.Strings(sorted)
		for _, value := range sorted {
			parts = append(parts, uriEncode(key, true)+"="+uriEncode(value, true))
		}
	}
	return strings.Join(parts, "&")
}

// signV4 computes the SigV4 signature for one request. headers must
// already carry every header named in signedHeaders (lowercase keys).
func signV4(method, path string, query url.Values, headers map[string]string,
	signedHeaders []string, payloadHash, secret, region string, at time.Time) (signature, credentialScope string) {
	amzDate := at.UTC().Format("20060102T150405Z")
	date := at.UTC().Format("20060102")
	sort.Strings(signedHeaders)
	var canonicalHeaders strings.Builder
	for _, name := range signedHeaders {
		canonicalHeaders.WriteString(name + ":" + strings.TrimSpace(headers[name]) + "\n")
	}
	canonicalRequest := strings.Join([]string{
		method, uriEncode(path, false), canonicalQuery(query),
		canonicalHeaders.String(), strings.Join(signedHeaders, ";"), payloadHash,
	}, "\n")
	credentialScope = date + "/" + region + "/" + sigv4Service + "/aws4_request"
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex([]byte(canonicalRequest)),
	}, "\n")
	signature = hex.EncodeToString(hmacSHA256(signingKey(secret, date, region), []byte(stringToSign)))
	return signature, credentialScope
}

type s3Config struct {
	bucket, region, endpoint, publicBaseURL string
	accessKey, secret                       string
	presignTTL                              int
}

func loadS3Config() (s3Config, string) {
	cfg := s3Config{
		bucket:        os.Getenv("JANUSLY_OBJECT_STORE_BUCKET"),
		region:        os.Getenv("JANUSLY_OBJECT_STORE_REGION"),
		endpoint:      strings.TrimRight(os.Getenv("JANUSLY_OBJECT_STORE_ENDPOINT"), "/"),
		publicBaseURL: strings.TrimRight(os.Getenv("JANUSLY_OBJECT_STORE_PUBLIC_BASE_URL"), "/"),
		accessKey:     os.Getenv("AWS_ACCESS_KEY_ID"),
		secret:        os.Getenv("AWS_SECRET_ACCESS_KEY"),
		presignTTL:    3600,
	}
	if cfg.region == "" {
		cfg.region = "us-east-1"
	}
	if raw := os.Getenv("JANUSLY_OBJECT_STORE_PRESIGN_TTL_SECONDS"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n >= 1 && n <= 604800 {
			cfg.presignTTL = n
		}
	}
	if cfg.accessKey == "" || cfg.secret == "" {
		return cfg, "S3 credentials missing: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY"
	}
	return cfg, ""
}

// objectURL builds the request URL: path-style against a custom endpoint
// (MinIO/R2), virtual-host style against AWS proper.
func (cfg s3Config) objectURL(key string) (base *url.URL, path string, err error) {
	if cfg.endpoint != "" {
		parsed, parseErr := url.Parse(cfg.endpoint)
		if parseErr != nil || parsed.Host == "" {
			return nil, "", fmt.Errorf("invalid object store endpoint")
		}
		return parsed, "/" + cfg.bucket + "/" + key, nil
	}
	parsed, _ := url.Parse("https://" + cfg.bucket + ".s3." + cfg.region + ".amazonaws.com")
	return parsed, "/" + key, nil
}

var s3HTTPClient = &http.Client{Timeout: 30 * time.Second}

// s3Put uploads via SigV4-signed PUT and returns the object URL. The
// context is honored: without it a stalled endpoint pinned the calling
// worker for the full client timeout and survived both run cancellation
// and graceful shutdown.
func s3Put(ctx context.Context, key string, body []byte, contentType string) PutResult {
	cfg, configErr := loadS3Config()
	if configErr != "" {
		return PutResult{Ok: false, Provider: "s3", Error: configErr}
	}
	base, path, err := cfg.objectURL(key)
	if err != nil {
		return PutResult{Ok: false, Provider: "s3", Error: err.Error()}
	}
	now := sigv4Now()
	payloadHash := sha256Hex(body)
	headers := map[string]string{
		"host":                 base.Host,
		"x-amz-date":           now.UTC().Format("20060102T150405Z"),
		"x-amz-content-sha256": payloadHash,
		"content-type":         contentType,
	}
	signed := []string{"content-type", "host", "x-amz-content-sha256", "x-amz-date"}
	signature, scope := signV4(http.MethodPut, path, url.Values{}, headers, signed, payloadHash, cfg.secret, cfg.region, now)

	// bytes.NewReader over the slice: the previous strings.NewReader(string(body))
	// copied the whole payload (multi-MB PDFs) for no reason.
	request, err := http.NewRequestWithContext(ctx, http.MethodPut,
		base.Scheme+"://"+base.Host+path, bytes.NewReader(body))
	if err != nil {
		return PutResult{Ok: false, Provider: "s3", Error: "s3 request build failed"}
	}
	request.Header.Set("X-Amz-Date", headers["x-amz-date"])
	request.Header.Set("X-Amz-Content-Sha256", payloadHash)
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Authorization", fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		cfg.accessKey, scope, strings.Join(signed, ";"), signature))
	response, err := s3HTTPClient.Do(request)
	if err != nil {
		return PutResult{Ok: false, Provider: "s3", Error: "s3 put failed: " + err.Error()}
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return PutResult{Ok: false, Provider: "s3",
			Error: fmt.Sprintf("s3 put status %d: %s", response.StatusCode, strings.TrimSpace(string(raw)))}
	}
	return PutResult{Ok: true, Provider: "s3", URL: s3ObjectAccessURL(cfg, key), Key: key}
}

// s3ObjectAccessURL: the CDN URL when configured, a presigned GET otherwise.
func s3ObjectAccessURL(cfg s3Config, key string) string {
	if cfg.publicBaseURL != "" {
		segments := strings.Split(key, "/")
		for i, segment := range segments {
			segments[i] = url.PathEscape(segment)
		}
		return cfg.publicBaseURL + "/" + strings.Join(segments, "/")
	}
	return s3PresignGet(cfg, key, sigv4Now())
}

// s3PresignGet builds a query-signed GET URL (UNSIGNED-PAYLOAD).
func s3PresignGet(cfg s3Config, key string, at time.Time) string {
	base, path, err := cfg.objectURL(key)
	if err != nil {
		return ""
	}
	amzDate := at.UTC().Format("20060102T150405Z")
	date := at.UTC().Format("20060102")
	scope := date + "/" + cfg.region + "/" + sigv4Service + "/aws4_request"
	query := url.Values{
		"X-Amz-Algorithm":     {"AWS4-HMAC-SHA256"},
		"X-Amz-Credential":    {cfg.accessKey + "/" + scope},
		"X-Amz-Date":          {amzDate},
		"X-Amz-Expires":       {strconv.Itoa(cfg.presignTTL)},
		"X-Amz-SignedHeaders": {"host"},
	}
	headers := map[string]string{"host": base.Host}
	signature, _ := signV4(http.MethodGet, path, query, headers, []string{"host"}, "UNSIGNED-PAYLOAD", cfg.secret, cfg.region, at)
	query.Set("X-Amz-Signature", signature)
	return base.Scheme + "://" + base.Host + path + "?" + query.Encode()
}
