# Dev task runner. Run `make` or `make help` for the list of targets.
# Backend and frontend targets skip their part until it has been scaffolded.

BACKEND    := source/backend
FRONTEND   := source/frontend
MIGRATIONS := internal/db/migrations
SPEC       := api/openapi.yaml
REDOCLY    := npx --yes @redocly/cli@2.62.1
# Generated files, committed so CI can check that they are up to date.
GENERATED  := $(BACKEND)/internal/api/api.gen.go $(BACKEND)/internal/db/sqlc $(FRONTEND)/src/api/schema.d.ts

HAS_BACKEND  := $(wildcard $(BACKEND)/go.mod)
HAS_QUERIES  := $(wildcard $(BACKEND)/internal/db/queries/*.sql)
HAS_FRONTEND := $(wildcard $(FRONTEND)/package.json)
skip = @echo "skip: $(1) is not scaffolded yet"

# Shared with Docker Compose. Created from .env.example on first run.
-include .env
POSTGRES_USER     ?= bucky
POSTGRES_PASSWORD ?= bucky
POSTGRES_DB       ?= bucky
POSTGRES_PORT     ?= 5432
DATABASE_URL      ?= postgres://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@localhost:$(POSTGRES_PORT)/$(POSTGRES_DB)?sslmode=disable
export

.DEFAULT_GOAL := help
.PHONY: help dev dev-backend dev-frontend db-up db-down db-reset psql migrate generate generate-check lint lint-spec test

help: ## Show this help
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

.env: | .env.example
	cp .env.example $@
	@echo "Created .env from .env.example"

dev: db-up ## Start the database, then the backend (air) and frontend (Vite) with live reload
	$(MAKE) -j2 dev-backend dev-frontend

# The dev server air runs. One left over from an earlier run (air can lose
# track of it) would keep the port, so the new one couldn't start. Anchored,
# so it doesn't match the shell running the recipe.
DEV_SERVER := ^$(CURDIR)/$(BACKEND)/tmp/server$$

dev-backend:
ifneq ($(HAS_BACKEND),)
	@if pkill -f '$(DEV_SERVER)'; then \
		echo "Stopped a dev server left over from an earlier run."; \
		while pgrep -f '$(DEV_SERVER)' >/dev/null; do sleep 0.2; done; \
	fi
	cd $(BACKEND) && go tool air
else
	$(call skip,backend)
endif

dev-frontend:
ifneq ($(HAS_FRONTEND),)
	cd $(FRONTEND) && npm run dev
else
	$(call skip,frontend)
endif

db-up: ## Start PostgreSQL and wait until it is healthy
	docker compose up -d --wait db

db-down: ## Stop PostgreSQL (keeps the data)
	docker compose stop db

db-reset: ## Delete the database volume, start a fresh database and migrate it
	docker compose down --volumes db
	$(MAKE) db-up migrate

psql: ## Open a psql shell in the database container
	docker compose exec db psql -U "$(POSTGRES_USER)" -d "$(POSTGRES_DB)"

migrate: ## Apply all pending migrations (goose)
ifneq ($(HAS_BACKEND),)
	cd $(BACKEND) && go tool goose -dir $(MIGRATIONS) postgres "$(DATABASE_URL)" up
else
	$(call skip,backend)
endif

generate: ## Regenerate code: sqlc, oapi-codegen (go generate) and the TS API client
ifneq ($(HAS_BACKEND),)
ifneq ($(HAS_QUERIES),)
	cd $(BACKEND) && go tool sqlc generate
endif
	cd $(BACKEND) && go generate ./...
else
	$(call skip,backend)
endif
ifneq ($(HAS_FRONTEND),)
	cd $(FRONTEND) && npm run generate
else
	$(call skip,frontend)
endif

generate-check: generate ## Fail if the committed generated code is out of date (used by CI)
	@if [ -n "$$(git status --porcelain -- $(GENERATED))" ]; then \
		git status --short -- $(GENERATED); \
		echo "Generated code is out of date. Run 'make generate' and commit the result."; \
		exit 1; \
	fi

lint-spec: ## Lint the OpenAPI spec (Redocly CLI)
	$(REDOCLY) lint $(SPEC)

lint: lint-spec ## Lint the API spec, backend (go vet, golangci-lint) and frontend (ESLint, tsc)
ifneq ($(HAS_BACKEND),)
	cd $(BACKEND) && go vet ./... && go tool golangci-lint run
else
	$(call skip,backend)
endif
ifneq ($(HAS_FRONTEND),)
	cd $(FRONTEND) && npm run lint && npm run typecheck
else
	$(call skip,frontend)
endif

test: db-up ## Run the backend and frontend tests (backend tests use the dev database)
ifneq ($(HAS_BACKEND),)
	cd $(BACKEND) && go test ./...
else
	$(call skip,backend)
endif
ifneq ($(HAS_FRONTEND),)
	cd $(FRONTEND) && npm test
else
	$(call skip,frontend)
endif
