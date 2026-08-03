SHELL := /bin/bash
DB_URL ?= postgres://janusly:janusly-go-local@127.0.0.1:4632/janusly_go
PG_CONTAINER := janusly-go-pilot-postgres-1
SCHEMA_DB := janusly_go_schema_dump
SCHEMA_DB_URL ?= postgres://janusly:janusly-go-local@127.0.0.1:4632/$(SCHEMA_DB)

.PHONY: db-up db-down migrate schema-dump generate lint vuln test run build parity ci test-pg18 bench benchmark-campaign fuzz contract web-embed verify seed chaos bench-hostile script-test queue-handoff-test queue-handoff queue-handoff-rehearsal release-checks release-manifest release-review release-production-check external-gate-template external-gate-record

RELEASE_ARTIFACTS ?= ../artifacts
RELEASE_MANIFEST_ARGS ?=
EXTERNAL_GATE ?=
EXTERNAL_EVIDENCE ?=
BENCHMARK_SAMPLES ?= 5

db-up:
	docker compose -f docker-compose.yml up -d --wait

db-down:
	docker compose -f docker-compose.yml down

# Goose owns Go-runtime databases. Migrations, including the original
# go_pilot_* bootstrap objects, are embedded in the binary; no Node runner or
# second SQL loop participates. Pre-goose databases are stamped at the shared
# Node baseline before later versions install and reconcile Go runtime state.
migrate:
	JANUSLY_GO_DATABASE_URL=$(DB_URL) go run ./cmd/api migrate

# schema.sql feeds sqlc so `make generate` works without a live database.
# Regenerate from a fresh migrated database after any migration change. Never
# dump the shared integration database: tests create transient fixture tables.
schema-dump:
	@set -euo pipefail; \
		docker exec $(PG_CONTAINER) dropdb -U janusly --if-exists --force $(SCHEMA_DB); \
		trap 'docker exec $(PG_CONTAINER) dropdb -U janusly --if-exists --force $(SCHEMA_DB) >/dev/null' EXIT; \
		docker exec $(PG_CONTAINER) createdb -U janusly -T template0 $(SCHEMA_DB); \
		JANUSLY_GO_DATABASE_URL=$(SCHEMA_DB_URL) go run ./cmd/api migrate; \
		docker exec $(PG_CONTAINER) pg_dump -U janusly -d $(SCHEMA_DB) --schema-only --no-owner --no-privileges \
			--restrict-key=januslyGoSchema20260802 > schema.sql

generate:
	go tool sqlc generate

build:
	go build ./...

lint:
	golangci-lint run ./...

vuln:
	go tool govulncheck ./...

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

# Pure fail-closed queue catalog/verdict tests. The live gate below additionally
# requires the frozen Node workspace dependencies, Redis, and PostgreSQL.
queue-handoff-test:
	node --check conformance/queue-handoff.mjs
	node --test conformance/queue-handoff-policy.test.mjs

script-test:
	node --test conformance/*.test.mjs

HANDOFF_DIRECTION ?= node-to-go
queue-handoff:
	node conformance/queue-handoff.mjs verify --direction=$(HANDOFF_DIRECTION)

# Full isolated Node -> Go -> Node -> Go queue ownership rehearsal.
queue-handoff-rehearsal:
	node conformance/run-queue-handoff-rehearsal.mjs

# Exact-commit local validation receipts. Artifacts are ignored so evidence can
# hash the candidate tree without becoming part of that tree.
release-checks:
	node conformance/run-release-checks.mjs \
		--output=$(RELEASE_ARTIFACTS)/go-release-checks.json \
		--queue=$(RELEASE_ARTIFACTS)/go-queue-handoff-evidence.json \
		--benchmark=$(RELEASE_ARTIFACTS)/go-benchmark-campaign.json \
		--benchmark-markdown=$(RELEASE_ARTIFACTS)/go-benchmark-campaign.md

release-manifest:
	node conformance/run-release-candidate.mjs \
		--checks=$(RELEASE_ARTIFACTS)/go-release-checks.json \
		--queue=$(RELEASE_ARTIFACTS)/go-queue-handoff-evidence.json \
		--external=$(RELEASE_ARTIFACTS)/go-external-gates.json \
		--json=$(RELEASE_ARTIFACTS)/go-release-candidate.json \
		--markdown=$(RELEASE_ARTIFACTS)/go-release-candidate.md \
		$(RELEASE_MANIFEST_ARGS)

release-review: release-checks
	$(MAKE) release-manifest RELEASE_MANIFEST_ARGS=--check-review

release-production-check:
	$(MAKE) release-manifest RELEASE_MANIFEST_ARGS=--check-production

external-gate-template:
	@test -n "$(EXTERNAL_GATE)" || (echo "EXTERNAL_GATE is required" && exit 2)
	@node conformance/run-external-gate.mjs --template=$(EXTERNAL_GATE)

external-gate-record:
	@test -n "$(EXTERNAL_GATE)" || (echo "EXTERNAL_GATE is required" && exit 2)
	@test -n "$(EXTERNAL_EVIDENCE)" || (echo "EXTERNAL_EVIDENCE is required" && exit 2)
	@node conformance/run-external-gate.mjs \
		--gate=$(EXTERNAL_GATE) \
		--input="$(EXTERNAL_EVIDENCE)" \
		--output="$(RELEASE_ARTIFACTS)/go-external-gates.json"

ci:
	@echo "== generate (sqlc drift check) =="
	$(MAKE) generate
	@git diff --quiet -- internal/store || (echo "sqlc output drifted: run make generate and commit" && exit 1)
	@echo "== queue handoff policy =="
	$(MAKE) queue-handoff-test
	@echo "== conformance script tests =="
	$(MAKE) script-test
	@echo "== coverage floors =="
	@bash scripts/coverage-floor.sh
	@echo "== contract (drift check) =="
	$(MAKE) contract
	@git diff --quiet -- contract/ || (echo "openapi contract drifted: run make contract and commit" && exit 1)
	@echo "== build =="
	$(MAKE) build
	@echo "== lint =="
	$(MAKE) lint
	@echo "== reachable vulnerabilities =="
	$(MAKE) vuln
	@echo "== tests (unit + integration, -race, -p 1) =="
	$(MAKE) test
	@echo "== semantic parity F01-F10 =="
	$(MAKE) parity
	@echo "== ci green =="

# PostgreSQL 18 revalidation: the full integration suite against an isolated
# container on port 4634, matching the only supported database major.
test-pg18:
	docker compose -f pg18.compose.yml up -d --wait
	JANUSLY_GO_DATABASE_URL=postgres://janusly:janusly-go-local@127.0.0.1:4634/janusly_go go run ./cmd/api migrate
	JANUSLY_GO_DATABASE_URL=postgres://janusly:janusly-go-local@127.0.0.1:4634/janusly_go \
		go test -race -tags integration -p 1 -count=1 ./... ; \
		status=$$?; docker compose -f pg18.compose.yml down -v; exit $$status

# k6 regression bench: boots the Go binary, runs the three sequential
# scenarios, appends to conformance/perf/series.jsonl, refreshes BENCH.md.
bench:
	node conformance/run-bench.mjs

# Exact-candidate repeated benchmark: five co-scheduled A/B pairs by default.
# Each side receives its own fresh PG18 instance/database; receipts stay under
# ignored artifacts and the tracked historical series is not modified.
benchmark-campaign:
	node conformance/run-benchmark-campaign.mjs --samples=$(BENCHMARK_SAMPLES) \
		--output=$(RELEASE_ARTIFACTS)/go-benchmark-campaign.json \
		--markdown=$(RELEASE_ARTIFACTS)/go-benchmark-campaign.md \
		--evidence=$(RELEASE_ARTIFACTS)/go-benchmark-campaign

# Grammar fuzzing: robustness properties over the two operator-facing
# grammars (never panic; validate/evaluate agreement; total rendering).
FUZZTIME ?= 45s
fuzz:
	go test ./internal/grammar/ -fuzz FuzzValidateAndEvaluateExpression -fuzztime $(FUZZTIME)
	go test ./internal/grammar/ -fuzz FuzzRenderTemplate -fuzztime $(FUZZTIME)
	go test ./internal/cron/ -fuzz FuzzCronParse -fuzztime $(FUZZTIME) -run '^$$'
	go test ./internal/httpapi/ -fuzz FuzzParseExternalRuntimeEvent -fuzztime $(FUZZTIME) -run '^$$'
	go test ./internal/tools/ -fuzz FuzzRenderMarkdownPDF -fuzztime $(FUZZTIME) -run '^$$'
	go test ./internal/tools/ -fuzz FuzzRenderHTMLPDF -fuzztime $(FUZZTIME) -run '^$$'

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

# Single-binary web: build the Vite bundle and copy it into the
# embed root before `go build`. The committed dist/ is only a placeholder;
# the real assets stay out of git.
web-embed:
	cd .. && pnpm --filter @janusly/web build
	rm -rf internal/webdist/dist
	cp -R ../apps/web/dist internal/webdist/dist

# DX lane: the one-command truth ladder (fail-fast, per-stage
# timing) and the deterministic demo org (API-driven, idempotent).
verify:
	@bash scripts/verify.sh

seed:
	go run ./cmd/seed

# Postgres chaos: the failover twin with the DATABASE as the
# victim. Runs its OWN Postgres container (never the shared pilot DB).
chaos:
	node conformance/run-chaos.mjs

# Hostile-world bench: reads must stay under 2x the healthy p95
# while the DLQ grows and the breaker trips. NEVER co-resident with the
# 24h soak (SIGSTOP it first).
bench-hostile:
	node conformance/run-hostile-bench.mjs
