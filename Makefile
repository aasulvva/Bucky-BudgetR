# Dev task runner. Run `make` or `make help` for the list of targets.
# Backend and frontend targets skip their part until it has been scaffolded.

BACKEND    := source/backend
FRONTEND   := source/frontend
MIGRATIONS := internal/db/migrations

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
.PHONY: help dev dev-backend dev-frontend db-up db-down db-reset psql migrate generate lint test

help: ## Show this help
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

.env: | .env.example
	cp .env.example $@
	@echo "Created .env from .env.example"

dev: db-up ## Start the database, then the backend (air) and frontend (Vite) with live reload
	$(MAKE) -j2 dev-backend dev-frontend

dev-backend:
ifneq ($(HAS_BACKEND),)
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

lint: ## Lint the backend (go vet, golangci-lint) and frontend (ESLint, tsc)
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
