package tools

import (
	"context"
	"time"
)

// providerCall is the seam every credentialed provider operation shares:
// a tenant credential gated by kind and rate limit, one guarded egress
// through the FetchHTTPTarget chokepoint, and a receipt verified before the
// tool reports success. A provider supplies only the request it needs and
// the receipt check that proves the provider did what was asked; the
// skeleton owns rate-limit resolution (a per-node override may lower the
// tenant ceiling, never raise it), the credential gate, usage recording and
// the failure envelope, so every integration reports the same
// ok/statusCode/latencyMs shape and the next provider adds no new plumbing.
type providerCall struct {
	tool             string
	credentialKind   string
	credential       string
	rateLimitFamily  string
	rateLimitDefault int
	// rateLimitOverride is the raw per-node value when hasRateLimitOverride;
	// anything but a whole number in 1..10000 fails before any egress.
	rateLimitOverride    any
	hasRateLimitOverride bool
	responseMaxBytes     int
	// request shapes the egress from the gated secret. A non-empty message
	// fails the call before it leaves the process.
	request func(secret string) (method, url string, headers map[string]string, body []byte, message string)
	// receipt turns a 2xx body into the provider-specific result fields, or
	// explains why the provider's answer does not prove the operation.
	receipt func(statusCode int, body string, startedAt time.Time) (result map[string]any, message string)
	// failure names a transport error or non-2xx status for the operator.
	failure func(statusCode int, transportError string) string
}

func (c providerCall) execute(ctx context.Context, deps *IntegrationDeps) map[string]any {
	start := time.Now()
	latency := func() int { return int(time.Since(start).Milliseconds()) }
	if deps == nil || deps.Gate == nil || deps.Fetch == nil {
		return envelopeError("integration tools require run context", 0)
	}
	record := func(ok bool, statusCode int, message string) {
		if deps.Record != nil {
			deps.Record(c.tool, c.credential, ok, statusCode, message, latency())
		}
	}
	fail := func(statusCode int, message string) map[string]any {
		record(false, statusCode, message)
		result := envelopeError(message, latency())
		if statusCode > 0 {
			result["statusCode"] = statusCode
		}
		return result
	}

	rateLimit := c.rateLimitDefault
	if deps.RateLimitPerMin != nil {
		rateLimit = deps.RateLimitPerMin(c.rateLimitFamily, c.rateLimitDefault)
	}
	if c.hasRateLimitOverride {
		override, ok := boundedWholeNumber(c.rateLimitOverride, 1, 10_000)
		if !ok {
			return envelopeError(c.tool+" requires an integer rateLimitPerMin in 1..10000", latency())
		}
		// Workflow configuration may reduce provider pressure for one flow, but
		// it can never raise the tenant ceiling resolved from org configuration.
		rateLimit = min(rateLimit, int(override))
	}
	secret, gateError := deps.Gate(ctx, c.tool, c.credentialKind, c.credential, rateLimit)
	if gateError != "" {
		return fail(0, gateError)
	}
	method, target, headers, body, message := c.request(secret)
	if message != "" {
		return fail(0, message)
	}
	statusCode, responseBody, transportError := deps.Fetch(ctx, method, target, headers, body, c.responseMaxBytes)
	if transportError != "" || statusCode < 200 || statusCode >= 300 {
		return fail(statusCode, c.failure(statusCode, transportError))
	}
	result, message := c.receipt(statusCode, responseBody, start)
	if message != "" {
		return fail(statusCode, message)
	}
	record(true, statusCode, "")
	if result == nil {
		result = map[string]any{}
	}
	result["ok"] = true
	result["statusCode"] = statusCode
	result["latencyMs"] = latency()
	return result
}
