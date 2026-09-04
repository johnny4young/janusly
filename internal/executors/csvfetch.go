// csv.fetch — the streaming CSV tool. Lives in the executors package
// because it rides the SAME SSRF-gated, DNS-pinned, redirect-revalidated
// HTTP machinery as the http node; the tools package cannot import
// executors (the executor registry wraps the tool registry), so this file
// contributes the definition through tools.Registry.Register.
//
// Contract implements the contract (the source contract +
// csv-stream.ts): one summary shape on EVERY path —
//   - pre-stream rejection (SSRF / DNS / scheme / Content-Length):
//     {ok:false, statusCode:0, streamTruncated:false, error}
//   - mid-stream abort (byte cap, decoder failure):
//     {ok:false, streamTruncated:true, ...partial counts, error}
//   - non-2xx: the body still streams (an error payload can be CSV) and
//     statusCode rides the envelope; ok = stream ok && response ok.
//
// Malformed rows (column-count mismatch) count toward totalRows but never
// matchedRows; the sample only ever contains rows that PASSED the filter.
// Memory stays O(sampleRows × avgRowSize).
package executors

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/httpcontract"
	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/tools"
)

const (
	csvFetchDefaultSample = 50
	csvFetchMaxSample     = 500
	csvFetchDefaultBytes  = 10 * 1024 * 1024
	csvFetchMaxBytes      = 52_428_800
)

// NewToolRegistry is the full tool set: the pure tools plus the
// executor-contributed streaming fetch. Both the dispatcher and the API
// catalog must use THIS constructor so the surfaces agree.
func NewToolRegistry() *tools.Registry {
	registry := tools.NewRegistry()
	registry.Register(csvFetchDefinition())
	registry.Register(httpRequestDefinition())
	return registry
}

func csvFetchDefinition() tools.Definition {
	return tools.Definition{
		Name:        "csv.fetch",
		Description: "Stream a CSV URL row-by-row and return a bounded summary (counts + sample). Use this for multi-MB CSV payloads instead of `http.request` + `csv.parse` — memory stays O(sampleRows).",
		Required:    []string{"url"},
		Optional:    []string{"headers", "sampleRows", "filter", "maxBytes", "timeoutMs", "maxRedirects"},
		Fields: []tools.Field{
			{Name: "url", Type: "string", Required: true},
			{Name: "headers", Type: "object"},
			{Name: "sampleRows", Type: "number"},
			{Name: "filter", Type: "object"},
			{Name: "maxBytes", Type: "number"},
			{Name: "timeoutMs", Type: "number"},
			{Name: "maxRedirects", Type: "number"},
		},
		InputExample: map[string]any{"url": "https://example.com/data.csv", "sampleRows": 10},
		Validate:     validateCSVFetchInput,
		Execute:      executeCsvFetch,
	}
}

func validateCSVFetchInput(input map[string]any, options tools.InputValidationOptions) error {
	if raw, present := input["url"]; present {
		value, _ := raw.(string)
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("url must be a non-empty string")
		}
	}
	httpConfig := map[string]any{"url": "https://example.invalid"}
	if raw, present := input["url"]; present {
		httpConfig["url"] = raw
	}
	if raw, present := input["headers"]; present {
		httpConfig["headers"] = raw
	}
	if raw, present := input["timeoutMs"]; present {
		httpConfig["timeoutMs"] = raw
	}
	if raw, present := input["maxRedirects"]; present {
		httpConfig["maxRedirects"] = raw
	}
	if raw, present := input["maxBytes"]; present {
		httpConfig["maxResponseBytes"] = raw
	}
	if _, err := httpcontract.ResolveNodeConfig(httpConfig, options.AllowWholeTemplates); err != nil {
		return err
	}
	for _, spec := range []struct {
		field   string
		minimum int
		maximum int
	}{
		{field: "sampleRows", minimum: 1, maximum: csvFetchMaxSample},
		{field: "maxBytes", minimum: 1_024, maximum: csvFetchMaxBytes},
		{field: "timeoutMs", minimum: 1_000, maximum: 120_000},
		{field: "maxRedirects", minimum: 0, maximum: 5},
	} {
		raw, present := input[spec.field]
		if !present {
			continue
		}
		if text, ok := raw.(string); ok && options.AllowWholeTemplates {
			if _, whole := grammar.WholeTemplateReference(text); whole {
				continue
			}
		}
		if _, ok := httpcontract.WholeNumber(raw, spec.minimum, spec.maximum); !ok {
			return fmt.Errorf("%s must be an integer between %d and %d", spec.field, spec.minimum, spec.maximum)
		}
	}
	if raw, present := input["filter"]; present {
		if text, ok := raw.(string); ok && options.AllowWholeTemplates {
			if _, whole := grammar.WholeTemplateReference(text); whole {
				return nil
			}
		}
		filter, _ := raw.(map[string]any)
		if len(filter) > 100 {
			return fmt.Errorf("filter supports at most 100 entries")
		}
		serialized, err := json.Marshal(filter)
		if err != nil || len(serialized) > 64<<10 {
			return fmt.Errorf("filter exceeds 65536 bytes")
		}
		for key, rawValue := range filter {
			value, ok := rawValue.(string)
			if !ok || key == "" || utf8.RuneCountInString(key) > 120 || strings.ContainsAny(key, "\r\n") || len(value) > 64<<10 {
				return fmt.Errorf("filter must use bounded column names and string values")
			}
		}
	}
	return nil
}

func csvFetchBound(input map[string]any, field string, minValue, maxValue, def int) (int, error) {
	raw, present := input[field]
	if !present {
		return def, nil
	}
	value, ok := httpcontract.WholeNumber(raw, minValue, maxValue)
	if !ok {
		return 0, fmt.Errorf("Invalid tool input for csv.fetch: %s: expected integer in %d..%d", field, minValue, maxValue) //nolint:staticcheck // tool error shape
	}
	return value, nil
}

func executeCsvFetch(ctx context.Context, input map[string]any) (map[string]any, error) {
	rawURL, _ := input["url"].(string)
	sampleCap, err := csvFetchBound(input, "sampleRows", 1, csvFetchMaxSample, csvFetchDefaultSample)
	if err != nil {
		return nil, err
	}
	maxBytes, err := csvFetchBound(input, "maxBytes", 1_024, csvFetchMaxBytes, csvFetchDefaultBytes)
	if err != nil {
		return nil, err
	}
	timeoutMs, err := csvFetchBound(input, "timeoutMs", 1_000, 120_000, 30_000)
	if err != nil {
		return nil, err
	}
	maxRedirects, err := csvFetchBound(input, "maxRedirects", 0, 5, 5)
	if err != nil {
		return nil, err
	}
	var filter map[string]any
	if raw, present := input["filter"]; present {
		filter, _ = raw.(map[string]any)
	}

	config := map[string]any{
		"url": rawURL, "timeoutMs": timeoutMs,
		"maxResponseBytes": maxBytes, "maxRedirects": maxRedirects,
	}
	if headers, ok := input["headers"].(map[string]any); ok {
		config["headers"] = headers
	}
	executor := &httpExecutor{opts: normalizeHTTPOptions(HTTPOptions{})}
	res, cleanup, err := executor.openStream(ctx, Input{Config: config, Context: map[string]any{}}) //nolint:bodyclose // res.Body is closed by cleanup(), deferred below
	if err != nil {
		// Pre-stream rejection: uniform envelope, statusCode 0, scrubbed.
		return map[string]any{
			"ok": false, "statusCode": 0, "totalRows": 0, "matchedRows": 0,
			"sampleRows": []any{}, "headers": []any{}, "streamedBytes": 0,
			"streamTruncated": false, "malformedRows": 0,
			"error": truncateError(signature.ScrubSecretShapes(err.Error())),
		}, nil
	}
	defer cleanup()

	summary := streamCsvSummary(res.Body, sampleCap, maxBytes, filter)
	responseOK := res.StatusCode >= 200 && res.StatusCode < 300
	ok := summary.ok && responseOK
	out := map[string]any{
		"ok": ok, "statusCode": res.StatusCode,
		"totalRows": summary.totalRows, "matchedRows": summary.matchedRows,
		"sampleRows": summary.sampleRows, "headers": summary.headers,
		"streamedBytes": summary.streamedBytes, "streamTruncated": summary.truncated,
		"malformedRows": summary.malformedRows,
	}
	if summary.err != "" {
		out["error"] = summary.err
	} else if !ok {
		out["error"] = fmt.Sprintf("HTTP %d", res.StatusCode)
	}
	return out, nil
}

func truncateError(message string) string {
	if len(message) > 200 {
		return message[:200]
	}
	return message
}

type csvSummary struct {
	ok            bool
	err           string
	totalRows     int
	matchedRows   int
	malformedRows int
	streamedBytes int
	truncated     bool
	headers       []any
	sampleRows    []any
}

// streamCsvSummary consumes the body row-by-row through the shared RFC 4180
// state machine. Never returns an error — stream failures land in the
// summary with partial counts.
func streamCsvSummary(body io.Reader, sampleCap, maxBytes int, filter map[string]any) csvSummary {
	state := tools.NewCsvParseState()
	summary := csvSummary{ok: true, headers: []any{}, sampleRows: []any{}}
	var headers []string

	process := func(rows [][]string) {
		for _, row := range rows {
			if !summary.ok {
				return
			}
			if headers == nil {
				if err := tools.ValidateCSVHeader(row); err != nil {
					summary.ok = false
					summary.truncated = true
					summary.err = truncateError(err.Error())
					return
				}
				headers = row
				view := make([]any, len(row))
				for i, h := range row {
					view[i] = h
				}
				summary.headers = view
				continue
			}
			summary.totalRows++
			if len(row) != len(headers) {
				summary.malformedRows++
				continue
			}
			if filter == nil && len(summary.sampleRows) >= sampleCap {
				summary.matchedRows++
				continue
			}
			obj := map[string]any{}
			for i, key := range headers {
				obj[key] = row[i]
			}
			if filter != nil {
				matched := true
				for key, value := range filter {
					if obj[key] != value {
						matched = false
						break
					}
				}
				if !matched {
					continue
				}
			}
			summary.matchedRows++
			if len(summary.sampleRows) < sampleCap {
				summary.sampleRows = append(summary.sampleRows, obj)
			}
		}
	}

	chunk := make([]byte, 4*1024)
	for {
		n, err := body.Read(chunk)
		if n > 0 {
			summary.streamedBytes += n
			if summary.streamedBytes > maxBytes {
				summary.ok = false
				summary.truncated = true
				summary.err = truncateError(fmt.Sprintf("HTTP response exceeds maxResponseBytes after %d bytes (cap %d)", summary.streamedBytes, maxBytes))
				return summary
			}
			process(state.FeedCsvChunk(string(chunk[:n])))
			if !summary.ok {
				return summary
			}
			if state.Error() != "" {
				summary.ok = false
				summary.truncated = true
				summary.err = truncateError(state.Error())
				return summary
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			summary.ok = false
			summary.truncated = true
			summary.err = truncateError(signature.ScrubSecretShapes(err.Error()))
			return summary
		}
	}
	process(state.FinalizeCsvParse())
	if state.Error() != "" {
		summary.ok = false
		summary.truncated = true
		summary.err = truncateError(state.Error())
	}
	return summary
}

// openStream performs the validated, pinned request and hands back the live
// response for streaming consumption. The cleanup closes body + transport.
func (e *httpExecutor) openStream(ctx context.Context, in Input) (*http.Response, func(), error) {
	resolved, err := httpcontract.ResolveNodeConfig(in.Config, false)
	if err != nil {
		return nil, nil, err
	}
	rawURL := resolved.URL
	timeoutMs := float64(httpDefaultTimeoutMs)
	if resolved.TimeoutMS != nil {
		timeoutMs = float64(*resolved.TimeoutMS)
	}
	maxRedirects := httpDefaultMaxRedirect
	if resolved.MaxRedirects != nil {
		maxRedirects = *resolved.MaxRedirects
	}
	pins := &pinnedDialer{byHost: map[string]net.IP{}}
	target, err := e.validate(ctx, rawURL, pins)
	if err != nil {
		return nil, nil, err
	}
	transport := e.newTransport(pins)
	client := &http.Client{
		Transport:     transport,
		Timeout:       time.Duration(timeoutMs) * time.Millisecond,
		CheckRedirect: e.redirectPolicy(pins, maxRedirects, false),
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, nil, err
	}
	for name, value := range resolved.Headers {
		req.Header.Set(name, value)
	}
	res, err := client.Do(req)
	if err != nil {
		transport.CloseIdleConnections()
		if strings.Contains(err.Error(), "Client.Timeout") {
			return nil, nil, fmt.Errorf("HTTP request timed out after %dms", int(timeoutMs))
		}
		return nil, nil, err
	}
	maxBytes := httpDefaultMaxBytes
	if resolved.MaxResponseBytes != nil {
		maxBytes = *resolved.MaxResponseBytes
	}
	if res.ContentLength > int64(maxBytes) {
		_ = res.Body.Close()
		transport.CloseIdleConnections()
		return nil, nil, fmt.Errorf("HTTP response exceeds maxResponseBytes (Content-Length %d > cap %d)", res.ContentLength, maxBytes) //nolint:staticcheck // contract message is the wire contract
	}
	cleanup := func() {
		_ = res.Body.Close()
		transport.CloseIdleConnections()
	}
	return res, cleanup, nil
}
