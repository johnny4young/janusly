SHELL := /bin/bash

COMPOSE_PROJECT_NAME ?= janusly
COMPOSE := docker compose -p $(COMPOSE_PROJECT_NAME)
DB_URL ?= postgres://janusly:janusly-local@127.0.0.1:5432/janusly?sslmode=disable
PNPM ?= pnpm --ignore-workspace
IMAGE ?= janusly:local
ARTIFACT_DIR ?= artifacts
GIT_COMMIT := $(shell git rev-parse HEAD 2>/dev/null || printf '%040d' 0)
GIT_TREE := $(shell git rev-parse 'HEAD^{tree}' 2>/dev/null || printf '%040d' 0)

.PHONY: dev build artifact db-up db-down db-reset migrate generate lint test \
	test-integration test-e2e test-e2e-full verify vuln frontend-install \
	frontend-audit frontend-build contract qualify-local qualify-local-selftest backup-local \
	restore-local recovery-local-selftest load-soak-local-selftest \
	qualify-oci-local qualify-real-provider

dev: db-up migrate
	JANUSLY_DATABASE_URL='$(DB_URL)' PNPM='$(PNPM)' bash scripts/dev.sh

build:
	bash scripts/assert-clean-source.sh
	docker build \
		--build-arg JANUSLY_BUILD_COMMIT=$(GIT_COMMIT) \
		--build-arg JANUSLY_BUILD_TREE=$(GIT_TREE) \
		--build-arg JANUSLY_BUILD_ID=$$(git rev-parse --short HEAD) \
		-t '$(IMAGE)' .

artifact: frontend-build
	go run ./cmd/artifact -output-dir '$(ARTIFACT_DIR)'

db-up:
	$(COMPOSE) up -d --wait postgres

db-down:
	$(COMPOSE) down --remove-orphans

db-reset:
	@test "$(CONFIRM)" = "reset" || { \
		echo "Refusing to remove the $(COMPOSE_PROJECT_NAME) database volume."; \
		echo "Re-run with: make db-reset CONFIRM=reset"; \
		exit 2; \
	}
	$(COMPOSE) down --volumes --remove-orphans

migrate:
	JANUSLY_DATABASE_URL='$(DB_URL)' go run ./cmd/api migrate

generate:
	go tool sqlc generate
	go run ./cmd/contract

contract:
	go run ./cmd/contract

frontend-install:
	cd web && $(PNPM) install --frozen-lockfile

frontend-build:
	cd web && $(PNPM) build

frontend-audit:
	cd web && $(PNPM) audit:ci

lint:
	@unformatted=$$(gofmt -l $$(find cmd internal e2e -name '*.go' -type f)); \
		test -z "$$unformatted" || { echo "Go files need gofmt:"; echo "$$unformatted"; exit 1; }
	golangci-lint run ./...
	cd web && $(PNPM) lint && $(PNPM) typecheck

vuln:
	go tool govulncheck ./...

test:
	go test -race ./...
	cd web && $(PNPM) test && $(PNPM) test:scripts && $(PNPM) test:browser

test-integration:
	JANUSLY_DATABASE_URL='$(DB_URL)' go test -race -tags integration -p 1 -count=1 ./...

test-e2e:
	PNPM='$(PNPM)' bash scripts/test-e2e.sh

# Opt-in: the full Playwright suite (tenant isolation, security, recovery,
# accessibility, ...). Requires the dev stack from `make dev` on :3001;
# Playwright starts its own Vite server against it.
test-e2e-full:
	cd web && $(PNPM) exec playwright test --project=chromium

qualify-local-selftest:
	bash scripts/qualification-local.test.sh
	bash scripts/load-soak-local.test.sh
	bash scripts/assert-clean-source.test.sh
	bash scripts/oci-railway-local.test.sh
	bash scripts/real-provider-local.test.sh

load-soak-local-selftest:
	bash scripts/load-soak-local.test.sh

qualify-local:
	CONFIRM='$(CONFIRM)' bash scripts/qualification-local.sh '$(or $(PROFILE),all)'

qualify-oci-local:
	CONFIRM='$(CONFIRM)' IMAGE='$(IMAGE)' bash scripts/oci-railway-local.sh

qualify-real-provider:
	bash scripts/real-provider-local.sh

recovery-local-selftest:
	bash scripts/postgres-local-recovery.test.sh

backup-local:
	@bash scripts/postgres-local-recovery.sh backup '$(or $(OUTPUT),output/backups/$$(date -u +%Y%m%dT%H%M%SZ))'

restore-local:
	@CONFIRM='$(CONFIRM)' bash scripts/postgres-local-recovery.sh restore '$(INPUT)'

verify: db-up migrate generate
	@git diff --exit-code -- schema.sql internal/store contract || { \
		echo "Generated SQLC or OpenAPI files drifted; run make generate and commit the result."; \
		exit 1; \
	}
	$(MAKE) lint
	$(MAKE) vuln
	$(MAKE) frontend-audit
	$(MAKE) test
	$(MAKE) test-integration
	$(MAKE) frontend-build
	cd web && $(PNPM) bundle-check
	$(MAKE) test-e2e
	@git diff --exit-code || { echo "Verification modified tracked files."; exit 1; }
