# API Contract and Versioning

Janusly keeps its original unversioned HTTP routes for compatibility and adds a
stable `/v1` alias only when a route declares an `ApiRouteContract`. An
uncontracted route under `/v1` returns 404; versioning never exposes a handler
by prefix alone.

## Sources of truth

- `apps/api/src/api-contracts.ts` — Zod request/response schemas and the pure
  `V1_CONTRACT_ROUTES` manifest.
- `packages/shared/src/api-contract.ts` — zero-dependency exact-path catalogs
  for stable reads and writes, shared by API contracts and first-party clients.
- `apps/api/src/routes.ts` — optional `contract` field on a route entry.
- `apps/api/src/server.ts` — exact-route-first dispatch, `/v1` alias resolution,
  query/body validation, request ID assignment, and unchanged auth/RBAC ordering.
- `apps/api/src/http.ts` — versioned success/error envelopes and runtime output
  validation at the JSON wire boundary; its memoized `readJson` lets the
  dispatcher and handler share one single-consumption request stream.
- `apps/api/src/openapi.ts` — deterministic OpenAPI 3.1 generation through Zod
  4 `toJSONSchema`.
- `apps/api/openapi.v1.json` — reviewed generated artifact; `pnpm
  contract:check` rejects drift.

The generator imports only the pure manifest. Do not import
`routes-registry.ts` from build-time tooling: route modules can instantiate
Redis or database clients as an import side effect.

## Wire envelopes

Every v1 success is:

```json
{
  "apiVersion": "v1",
  "requestId": "7d2d5ea5-8d9b-4d64-8f70-60a9ea9ae300",
  "data": {}
}
```

Every v1 error is:

```json
{
  "apiVersion": "v1",
  "requestId": "7d2d5ea5-8d9b-4d64-8f70-60a9ea9ae300",
  "error": {
    "code": "invalid_input",
    "message": "Invalid request query",
    "params": { "field": "limit" }
  }
}
```

The server accepts a caller `X-Request-Id` only when it is 1–128 safe ASCII
identifier characters; otherwise it generates a UUID. The ID is returned in
the response header and v1 envelope. CORS exposes `X-Request-Id` and
`Content-Disposition` globally.

## Runtime guarantees

1. Exact routes resolve before aliasing, so `/v1/openapi.json` is a public raw
   OpenAPI document rather than an enveloped data route.
2. The dispatcher runs auth, role, and permission gates in the same order for
   legacy and v1 requests. It validates v1 queries and declared JSON bodies
   only after authorization. Strict body schemas reject unknown top-level keys.
3. A v1 handler receives the legacy URL (`/v1/run?...` becomes `/run?...`), so
   tenant-scoped handler logic is shared rather than forked.
4. A contracted mutation handler reuses the memoized raw JSON parse after the
   dispatcher validates it; Zod transformations are not substituted into the
   legacy handler path, so versioning does not silently change handler semantics.
5. `sendJson` validates the serialized JSON payload against the declared
   response schema. A mismatch logs operation ID plus safe issue paths/messages
   and returns a generic `server_internal_error`; it never ships an invalid
   contract or raw internal value. OpenAPI uses the same Zod input semantics:
   required/type drift fails closed, while additive keys on ordinary
   `z.object` response schemas remain backward-compatible unless that object is
   explicitly strict.
6. Route-specific error codes must be declared. Dispatcher-level errors are
   automatically available to every contract.
7. Legacy response bodies remain unchanged. The web client opts contracted GET
   paths into `/v1` and unwraps them inside `apps/web/src/api.ts`, so components
   keep their existing payload types.

## Adding a contracted route

1. Define precise Zod wire schemas and an `ApiRouteContract` in
   `api-contracts.ts`. Dates are ISO strings because validation occurs after
   JSON serialization.
2. Attach the contract to the real route entry without changing its role,
   permission, or tenant-scoped handler.
3. Add the matching method/gates/contract to `V1_CONTRACT_ROUTES`.
4. Add a stable read or mutation to the matching exact-path catalog in
   `packages/shared/src/api-contract.ts`. If the browser should migrate a GET
   immediately, its transport reads `V1_READ_PATHS` directly.
5. Run `pnpm contract:generate`, review `apps/api/openapi.v1.json`, then run
   `pnpm contract:check` and the legacy/v1 parity tests.

Do not add a schema with opaque top-level payloads merely to increase route
count. SDK methods may consume only explicitly contracted `/v1` operations;
the checked-in OpenAPI document remains the compatibility boundary.
