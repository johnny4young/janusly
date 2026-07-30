SHELL := /bin/bash
DB_URL ?= postgres://janusly:janusly-go-local@127.0.0.1:4632/janusly_go

.PHONY: db-up db-down migrate lint test run build

db-up:
	docker compose -f docker-compose.yml up -d --wait

db-down:
	docker compose -f docker-compose.yml down

# The shared drizzle migrations are the single schema author. Running them
# through the repo's own tooling keeps the drizzle.__drizzle_migrations
# journal that the boot probe asserts.
migrate:
	cd .. && DATABASE_URL=$(DB_URL) pnpm migrate

build:
	go build ./...

lint:
	golangci-lint run ./...

test:
	JANUSLY_GO_DATABASE_URL=$(DB_URL) go test -race -tags integration ./...

run:
	JANUSLY_GO_DATABASE_URL=$(DB_URL) go run ./cmd/api
