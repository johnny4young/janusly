# Janusly

Janusly is the AI operator for business workflows. It combines workflow design,
execution, recovery, integrations, and operations in one deployable runtime.

## Architecture

Janusly ships as one `janusly` executable:

- the public HTTP API and React application listen on port `3001`;
- workflow execution and maintenance loops run in the same process;
- the internal metrics listener binds to `127.0.0.1:9464` by default;
- PostgreSQL 18 stores workflow, run, recovery, identity, audit, and rate-limit
  state;
- Ollama is optional and used only when self-hosted embeddings are enabled.

The React production bundle is embedded in the Go executable. Browser requests
use the same origin as the page. During development, Vite proxies API requests
to `127.0.0.1:3001`.

```text
/
├── cmd/                 executable entry points and generators
├── internal/            Go runtime
├── contract/            checked-in OpenAPI 3.1 document
├── web/                 standalone React application
├── e2e/                 executable-level Go tests
├── docs/                operator and architecture documentation
├── deploy/              observability configuration
├── scripts/             Bash development and E2E harnesses
├── go.mod
├── go.sum
├── Makefile
├── Dockerfile
└── docker-compose.yml
```

## Requirements

- Go 1.26.6
- PostgreSQL 18
- pnpm 11 for frontend development
- Docker with Compose v2 for the supported local database and image build

## Start locally

```bash
make frontend-install
make db-up
make migrate
make dev
```

Open <http://127.0.0.1:5173>. The Go API remains available at
<http://127.0.0.1:3001>.

The database schema is a fresh-install baseline. Existing databases from any
other schema generation are not upgradeable. `make db-reset` refuses to remove
the Compose volume unless `CONFIRM=reset` is supplied.

## Run the container

A new database must be migrated before the service starts:

```bash
docker compose up -d --wait postgres
docker compose run --rm janusly migrate
docker compose up -d janusly
```

Open <http://127.0.0.1:3001>. Production should set `JANUSLY_ENV=production`,
inject exact Git commit/tree build arguments, and provide the required secrets.
See [local deployment](docs/local-deployment.md),
[Railway deployment and cost qualification](docs/railway.md), and
[configuration](docs/configuration.md).

## Common commands

| Command | Purpose |
| --- | --- |
| `make dev` | Run the Go runtime and Vite development server. |
| `make build` | Build the single production image. |
| `make artifact` | Produce `artifacts/janusly` and `manifest.json`. |
| `make supply-chain` | Build the image plus checksummed provenance metadata and an SPDX SBOM. |
| `make db-up` / `make db-down` | Start or stop the project PostgreSQL service. |
| `make db-reset CONFIRM=reset` | Remove only this Compose project's volumes. |
| `make migrate` | Apply the embedded PostgreSQL 18 baseline. |
| `make generate` | Regenerate SQLC and OpenAPI outputs. |
| `make lint` | Check Go formatting/lint and frontend lint/types. |
| `make test` | Run Go race tests and frontend unit/browser tests. |
| `make test-integration` | Run integration tests against PostgreSQL 18. |
| `make test-e2e` | Exercise the embedded React application and real API image. |
| `make test-e2e-full` | Opt-in full Playwright suite against a running `make dev` stack. |
| `make verify` | Run the complete local acceptance ladder. |
| `make qualify-real-provider` | Explicit-cost Anthropic product check; requires consent, a local key, and is capped at two calls / USD 1. |

## Configuration

The core process settings are:

```dotenv
JANUSLY_DATABASE_URL=postgres://janusly:janusly-local@127.0.0.1:5432/janusly?sslmode=disable
JANUSLY_ENV=development
JANUSLY_PORT=3001
JANUSLY_INTERNAL_HOST=127.0.0.1
JANUSLY_INTERNAL_PORT=9464
JANUSLY_WORKER_CONCURRENCY=8
JANUSLY_API_POOL_SIZE=10
JANUSLY_WORKER_POOL_SIZE=0
JANUSLY_POLL_MS=250
JANUSLY_HTTP_TIMEOUT_MS=30000
JANUSLY_FEEDBACK_MEMORY_WORKERS=4
JANUSLY_FEEDBACK_MEMORY_QUEUE_CAPACITY=256
JANUSLY_FEEDBACK_MEMORY_TIMEOUT_MS=15000
```

Copy `.env.example` for optional identity, AI, storage, mail, and observability
integrations. There is no frontend API URL setting: production is same-origin.

## Database

`internal/migrate/sql/00001_baseline.sql` is the only schema baseline.
Migrations are embedded in the executable and recorded in
`janusly_schema_version`. `schema.sql` is generated from an empty PostgreSQL 18
database and is the input to SQLC.

```bash
make migrate
make generate
git diff -- schema.sql internal/store contract
```

## API and frontend

`contract/openapi.json` is the checked-in OpenAPI 3.1 contract for the
versioned `/v1` manifest. The full API additionally exposes health, identity,
workflows, runs, streaming events, recovery, MCP, integrations, and
administrative operations outside that document. The React client lives entirely in `/web` and
uses the shared HTTP origin in production.

Read [API](docs/api.md), [workflows](docs/workflows.md),
[nodes](docs/nodes.md), and [MCP](docs/mcp.md).

## Security posture

- Every tenant query is scoped by the resolved organization.
- Production rejects development authentication unless explicitly allowed.
- Outbound HTTP validates and pins DNS resolution to prevent rebinding.
- Tenant credentials are encrypted with an external root key or resolved from
  an operator-controlled allowlist.
- Human resume and browser session tokens use a dedicated HMAC secret.
- The internal listener stays loopback-only unless an operator deliberately
  exposes it to a protected collector network.

Report vulnerabilities according to [SECURITY.md](SECURITY.md).

## License

See [LICENSE](LICENSE).
