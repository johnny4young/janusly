FROM node:26-bookworm@sha256:b7087bc4d973034b30854b378ba107f9fab622b47514cb7e2592e41b8bab8d49 AS web-deps
WORKDIR /src/web
# Node 25+ no longer bundles corepack.
RUN npm install -g corepack@0.36.0 && corepack enable && corepack prepare pnpm@11.17.0 --activate
COPY web/package.json web/pnpm-lock.yaml ./
RUN --mount=type=cache,id=janusly-pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile

FROM web-deps AS web-build
COPY web/ ./
ARG JANUSLY_BUILD_ID
ARG VITE_SUPABASE_URL
ARG JANUSLY_WEB_SUPABASE_PUBLISHABLE
ARG VITE_DOCS_URL
RUN JANUSLY_BUILD_ID="${JANUSLY_BUILD_ID}" \
    VITE_SUPABASE_URL="${VITE_SUPABASE_URL}" \
    VITE_SUPABASE_ANON_KEY="${JANUSLY_WEB_SUPABASE_PUBLISHABLE}" \
    VITE_DOCS_URL="${VITE_DOCS_URL}" \
    pnpm build

FROM golang:1.26.11-bookworm@sha256:dc40a13b61304647ed7e5d581d246b86413dfc29d63c6d018310feb93cd98fc0 AS go-build
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
