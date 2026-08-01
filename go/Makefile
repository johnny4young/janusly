SHELL := /bin/bash
DB_URL ?= postgres://janusly:janusly-go-local@127.0.0.1:4632/janusly_go
PG_CONTAINER := janusly-go-pilot-postgres-1

.PHONY: db-up db-down migrate schema-dump generate lint test run build parity ci test-pg15 bench fuzz contract

db-up:
	docker compose -f docker-compose.yml up -d --wait

db-down:
	docker compose -f docker-compose.yml down

# The shared drizzle migrations are the single schema author. Running them
# through the repo's own tooling keeps the drizzle.__drizzle_migrations
# journal that the boot probe asserts. Pilot-only objects (go_pilot_* tables)
# follow from ./migrations, applied idempotently to the pilot database only.
# goose owns the pilot's schema (2026-07-31 decision): migrations embed in
# the binary; no Node repo needed. Pre-goose databases get stamped at the
# baseline automatically on first run.
migrate:
	JANUSLY_GO_DATABASE_URL=$(DB_URL) go run ./cmd/api migrate
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

# Dual-run shadow comparator: same corpus at the pinned Node reference AND
# the Go pilot, normalized diff; fails on any divergence outside the
# annotated expected list (see CUTOVER-MAP.md).
dual:
	node conformance/run-reference-stack.mjs node go/conformance/run-dual.mjs

# The one-command truth lane: everything a reviewer needs to trust the
# branch, failing fast with an honest exit code. Assumes the pilot DB is up
# (make db-up + make migrate once per checkout).
contract:
	go run ./cmd/contract

ci:
	@echo "== generate (sqlc drift check) =="
	$(MAKE) generate
	@git diff --quiet -- internal/store || (echo "sqlc output drifted: run make generate and commit" && exit 1)
	@echo "== contract (drift check) =="
	$(MAKE) contract
	@git diff --quiet -- contract/ || (echo "openapi contract drifted: run make contract and commit" && exit 1)
	@echo "== build =="
	$(MAKE) build
	@echo "== lint =="
	$(MAKE) lint
	@echo "== tests (unit + integration, -race, -p 1) =="
	$(MAKE) test
	@echo "== semantic parity F01-F10 =="
	$(MAKE) parity
	@echo "== ci green =="

# Postgres 15 floor: the full integration suite against an ephemeral pg15
# container (port 4634), mirroring the reference CI's test_compat_pg15 lane.
test-pg15:
	docker compose -f pg15.compose.yml up -d --wait
	JANUSLY_GO_DATABASE_URL=postgres://janusly:janusly-go-local@127.0.0.1:4634/janusly_go go run ./cmd/api migrate
	JANUSLY_GO_DATABASE_URL=postgres://janusly:janusly-go-local@127.0.0.1:4634/janusly_go \
		go test -race -tags integration -p 1 -count=1 ./... ; \
		status=$$?; docker compose -f pg15.compose.yml down -v; exit $$status

# k6 regression bench: boots the Go binary, runs the three sequential
# scenarios, appends to conformance/perf/series.jsonl, refreshes BENCH.md.
bench:
	node conformance/run-bench.mjs

# Grammar fuzzing: robustness properties over the two operator-facing
# grammars (never panic; validate/evaluate agreement; total rendering).
FUZZTIME ?= 45s
fuzz:
	go test ./internal/grammar/ -fuzz FuzzValidateAndEvaluateExpression -fuzztime $(FUZZTIME)
	go test ./internal/grammar/ -fuzz FuzzRenderTemplate -fuzztime $(FUZZTIME)

# Lane HA: dos engines con pools separados sobre la misma base — el
# modelo in-test de dos réplicas. Corre SOLO los tests etiquetados ha.
test-ha:
	go test -race -tags "integration ha" -p 1 -count=1 -run 'TestHA' ./internal/engine/ -timeout 10m

# Soak sostenido (default 1h; SOAK_DURATION=3m para validar el arnés).
soak:
	node conformance/run-soak.mjs

# Kill-failover: dos instancias sobre la misma base, SIGKILL a una a mitad
# de vuelo; el sobreviviente absorbe todo (reaper corto vía env) y la
# instancia caída se reincorpora. Ver conformance/run-failover.mjs.
failover:
	node conformance/run-failover.mjs
