# Local and self-hosted deployment

## Development

Install frontend dependencies once, start PostgreSQL 18, apply the baseline,
and run both development processes:

```bash
make frontend-install
make db-up
make migrate
make dev
```

- React development URL: <http://127.0.0.1:5173>
- Go public URL: <http://127.0.0.1:3001>
- internal metrics: <http://127.0.0.1:9464/metrics>

Vite proxies API traffic to the Go listener. The production build does not use
that proxy because the same Go process serves both surfaces.

## Container deployment

The root `Dockerfile` has three responsibilities:

1. install and compile `/web`;
2. copy the generated bundle into `internal/webdist/dist` inside the build
   container and compile a CGO-disabled Go executable;
3. copy only `janusly` into a non-root minimal image.

Build provenance is injected with exact 40-character Git commit and tree IDs.

```bash
make build
```

For the root Compose project:

```bash
docker compose up -d --wait postgres
docker compose run --rm janusly migrate
docker compose up -d janusly
```

The migration command is intentionally explicit. A serving process refuses to
start on an empty or incomplete schema.

## Fresh databases only

Janusly supports PostgreSQL 18 and one baseline migration. Do not point the
runtime at a database created by a different schema generation. For disposable
local data:

```bash
make db-reset CONFIRM=reset
make db-up
make migrate
```

The reset target scopes deletion to the configured Compose project. It must not
be adapted to delete unrelated volumes or containers.

## Production checklist

1. Set `JANUSLY_ENV=production`.
2. Provide a PostgreSQL 18 database and apply `janusly migrate` once.
3. Set `JANUSLY_RESUME_TOKEN_SECRET`.
4. Configure the credential master key when managed credentials are used.
5. Configure Supabase or explicitly decide whether development auth headers
   are acceptable in the environment.
6. Inject real Git commit/tree build arguments.
7. Keep port `9464` private; expose port `3001` through TLS termination.
8. Configure backups for PostgreSQL and the credential root key.
9. Run the image as its built-in non-root user.
10. Verify `/healthz`, `/health`, the React shell, and a controlled workflow.

## Optional embeddings

Ollama is available through the `embeddings` Compose profile:

```bash
docker compose --profile embeddings up -d ollama
```

Enabling the service alone does not enable tenant memory. Both the process gate
and the tenant memory configuration must allow it.

## Artifact build

```bash
make frontend-build
make artifact
./artifacts/janusly provenance
```

The artifact builder requires a clean Git tree. It stages committed source and
the generated web bundle in a temporary directory, writes `janusly` plus
`manifest.json`, and leaves the worktree unchanged.
