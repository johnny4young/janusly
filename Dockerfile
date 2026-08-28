FROM node:24-bookworm@sha256:392e1e23f34da768d8d1f4e502b64f200d3be3465934d4b7930f57d7e2fc1989 AS web-deps
WORKDIR /src/web
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
COPY web/package.json web/pnpm-lock.yaml ./
RUN --mount=type=cache,id=janusly-pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile

FROM web-deps AS web-build
COPY web/ ./
ARG JANUSLY_BUILD_ID
ARG VITE_SUPABASE_URL
ARG JANUSLY_WEB_SUPABASE_PUBLISHABLE
ARG VITE_DOCS_URL
ENV JANUSLY_BUILD_ID="${JANUSLY_BUILD_ID}" \
    VITE_SUPABASE_URL="${VITE_SUPABASE_URL}" \
    VITE_SUPABASE_ANON_KEY="${JANUSLY_WEB_SUPABASE_PUBLISHABLE}" \
    VITE_DOCS_URL="${VITE_DOCS_URL}"
RUN pnpm build

FROM golang:1.26.6-bookworm@sha256:116d58cbd88c1297624acc6e967a060012422bacf9930927e23fb719189c6f36 AS go-build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,id=janusly-mod,target=/go/pkg/mod go mod download
COPY . .
RUN rm -rf internal/webdist/dist
COPY --from=web-build /src/web/dist/ internal/webdist/dist/
ARG JANUSLY_BUILD_COMMIT=0000000000000000000000000000000000000000
ARG JANUSLY_BUILD_TREE=0000000000000000000000000000000000000000
RUN --mount=type=cache,id=janusly-mod,target=/go/pkg/mod \
    --mount=type=cache,id=janusly-build,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -buildvcs=false \
      -ldflags="-s -w -X github.com/johnny4young/janusly/internal/buildinfo.buildCommit=${JANUSLY_BUILD_COMMIT} -X github.com/johnny4young/janusly/internal/buildinfo.buildTree=${JANUSLY_BUILD_TREE}" \
      -o /out/janusly ./cmd/api

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
ARG JANUSLY_BUILD_COMMIT=0000000000000000000000000000000000000000
ARG JANUSLY_BUILD_TREE=0000000000000000000000000000000000000000
LABEL org.opencontainers.image.title="Janusly" \
      org.opencontainers.image.description="AI operator for business workflows" \
      org.opencontainers.image.source="https://github.com/johnny4young/janusly" \
      org.opencontainers.image.revision="${JANUSLY_BUILD_COMMIT}" \
      io.janusly.source-tree="${JANUSLY_BUILD_TREE}"
COPY --from=go-build --chown=nonroot:nonroot /out/janusly /janusly
USER nonroot:nonroot
EXPOSE 3001
ENTRYPOINT ["/janusly"]
