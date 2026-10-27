# syntax=docker/dockerfile:1
# The production image: the frontend built to static files and embedded in
# the Go binary, on a minimal non-root base. Build from the repo root:
#   docker build --build-arg VERSION=$(git describe --tags --always) .
# deploy/compose.yaml builds it this way; see docs/DEPLOYMENT.md.

FROM node:24.22.1-alpine3.24 AS frontend
WORKDIR /src/source/frontend
COPY source/frontend/package.json source/frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY source/frontend/ ./
RUN npm run build

FROM golang:1.26.10-alpine3.24 AS backend
WORKDIR /src
COPY source/backend/go.mod source/backend/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY source/backend/ ./
COPY --from=frontend /src/source/frontend/dist/ ./internal/web/dist/
ARG VERSION=dev
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" \
    -o /out/bucky-server ./cmd/server

# Distroless static: no shell or package manager; runs as uid 65532.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=backend /out/bucky-server /usr/local/bin/bucky-server
USER nonroot:nonroot
ENV APP_ENV=production API_HOST=0.0.0.0 API_PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["bucky-server", "healthcheck"]
ENTRYPOINT ["bucky-server"]
CMD ["serve"]
