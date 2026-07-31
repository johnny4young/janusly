SHELL := /bin/bash
DB_URL ?= postgres://janusly:janusly-go-local@127.0.0.1:4632/janusly_go
PG_CONTAINER := janusly-go-pilot-postgres-1

.PHONY: db-up db-down migrate schema-dump generate lint test run build parity

db-up:
	docker compose -f docker-compose.yml up -d --wait

db-down:
	docker compose -f docker-compose.yml down

# The shared drizzle migrations are the single schema author. Running them
# through the repo's own tooling keeps the drizzle.__drizzle_migrations
# journal that the boot probe asserts. Pilot-only objects (go_pilot_* tables)
# follow from ./migrations, applied idempotently to the pilot database only.
migrate:
	cd .. && DATABASE_URL=$(DB_URL) pnpm migrate
	for f in migrations/*.sql; do \
		docker exec -i $(PG_CONTAINER) psql -v ON_ERROR_STOP=1 -U janusly -d janusly_go < $$f; \
	done

# schema.sql feeds sqlc so `make generate` works without a live database.
# Regenerate after any migration change; the file is committed on purpose.
schema-dump:
	docker exec $(PG_CONTAINER) pg_dump -U janusly -d janusly_go --schema-only --no-owner --no-privileges > schema.sql

generate:
	go tool sqlc generate

build:
	go build ./...

lint:
	golangci-lint run ./...

test:
	JANUSLY_GO_DATABASE_URL=$(DB_URL) go test -race -tags integration -p 1 ./...

run:
	JANUSLY_GO_DATABASE_URL=$(DB_URL) go run ./cmd/api

# Semantic parity against the reference goldens (regenerate them with
# conformance/gen-goldens.mjs against a locally booted reference stack).
parity:
	JANUSLY_GO_DATABASE_URL=$(DB_URL) go test -race -tags integration -count=1 -run TestSemanticParity ./internal/parity/ -v
