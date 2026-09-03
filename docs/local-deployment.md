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
- PostgreSQL from the host: `127.0.0.1:15473` (loopback only)

Vite proxies API traffic to the Go listener. The production build does not use
that proxy because the same Go process serves both surfaces.

### Database port isolation

The nonstandard host port avoids sharing PostgreSQL's default `5432` with
other local projects. The container still listens on `5432`; the Janusly
container connects to `postgres:5432`, not the host's published port.

To override the host port, export `JANUSLY_POSTGRES_HOST_PORT` in your shell or
pass it to Make consistently:

```bash
make dev JANUSLY_POSTGRES_HOST_PORT=15474
```

Make exports that value to Compose and derives `DB_URL` from it for the API,
migrations and integration tests. An explicit `DB_URL` still takes precedence.
For direct binary execution with a custom port, set `JANUSLY_DATABASE_URL`.
Make's exported host port takes precedence over Compose's `.env` value; do not
change only the Compose `.env` port when using Make.

Changing a port recreates the database container but retains its named volume.
It does not require `db-reset` and must not remove existing data. If the chosen
port is occupied, select another override instead of stopping another project.

## Container deployment

The root `Dockerfile` has three responsibilities:

1. install and compile `/web`;
2. copy the generated bundle into `internal/webdist/dist` inside the build
   container and compile a CGO-disabled Go executable;
3. copy only `janusly` into a non-root minimal image.

Build provenance is injected with exact 40-character Git commit and tree IDs.
The build refuses a dirty checkout so those labels cannot misrepresent local
changes as the current commit.

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

For the locally qualified Railway shape, cost model, environment contract, and
remaining online gates, see [Railway deployment and cost qualification](railway.md).

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

## Local PostgreSQL backup and restore

The local recovery helper creates a PostgreSQL custom-format backup plus a
manifest containing its checksum, PostgreSQL major, migration/source
fingerprints, Git provenance, and (when managed credentials exist) only a
one-way fingerprint of the high-entropy credential root key. It never records
the key itself; the manifest and dump must still be protected as sensitive.

```bash
export JANUSLY_CREDENTIAL_MASTER_KEY='the-key-used-by-this-stack'
make backup-local OUTPUT=output/backups/before-maintenance
```

A restore is intentionally fail-closed: the Janusly service must be stopped,
the target must be an empty PostgreSQL 18 database, the checkout must match the
schema fingerprint, the dump checksum must pass, and the credential key must
match. The explicit confirmation guard is required.

```bash
docker compose stop janusly
# Start a new empty PostgreSQL 18 target before restoring.
make restore-local INPUT=output/backups/before-maintenance CONFIRM=restore
docker compose run --rm janusly migrate
docker compose up -d janusly
```

This package covers the Janusly application database. Supabase identities and
the credential root key are separate operator-owned systems and require their
own provider backup and escrow procedures. Protect the backup directory as
sensitive data even though managed credential values remain encrypted.

## Production checklist

1. Set `JANUSLY_ENV=production`.
2. Provide a PostgreSQL 18 database and apply `janusly migrate` once.
3. Set `JANUSLY_RESUME_TOKEN_SECRET`.
4. Configure the credential master key when managed credentials are used.
5. Configure Supabase or explicitly decide whether development auth headers
   are acceptable in the environment.
6. Inject real Git commit/tree build arguments.
7. Keep port `9464` private; expose port `3001` through TLS termination.
8. Configure provider-grade backups for PostgreSQL, Supabase identity, and the
   credential root key; test restoration into an isolated empty target.
9. Run the image as its built-in non-root user.
10. Verify `/healthz`, `/readyz`, `/health`, the React shell, and a controlled workflow.

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

## Supply-chain evidence

Build the production image and its local evidence bundle from a clean checkout:

```bash
make supply-chain IMAGE=janusly:supply-chain
```

The target fixes BuildKit's SBOM scanner and the standalone Syft generator by
digest, requests `mode=max` BuildKit provenance, and writes a Docker image
archive, BuildKit metadata, image inspection, runtime provenance, an SPDX 2.3
JSON SBOM, a summary, and `SHA256SUMS` under
`artifacts/supply-chain/`. It verifies the current commit/tree, the non-root
runtime user, OCI labels, provenance materials, and a non-empty SBOM before
publishing the directory.

This evidence is **not signed** and the target does not push or publish the
image. Signing and registry attestations remain an explicit release operation.
Base/runtime images and CI Actions are pinned by digest or commit; updates are
reviewed changes rather than mutable tag resolution at qualification time.
