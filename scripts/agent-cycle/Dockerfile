# The official agent cycle figure: pinned clients in a Linux container with no
# keychain, display or operator home.
FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1

ARG CLAUDE_CODE_VERSION=2.1.322
ARG CODEX_VERSION=0.167.2
ARG CURSOR_VERSION=2026.11.11-b912975
ARG CURSOR_SHA256_X64=be01f42ad334f81d05a9992fcf060a52cc746f52cc451e849eb652146a6e3c91
ARG CURSOR_SHA256_ARM64=f068af64ed91b5304605976586f690579679f740a41f388091a6b3a2e776987c
ARG TARGETARCH

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl postgresql-client python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    && case "${TARGETARCH:-amd64}" in amd64) arch=x64 sum="${CURSOR_SHA256_X64}";; arm64) arch=arm64 sum="${CURSOR_SHA256_ARM64}";; *) exit 1;; esac \
    && curl -fsSL -o /tmp/cursor.tar.gz "https://downloads.cursor.com/lab/${CURSOR_VERSION}/linux/${arch}/agent-cli-package.tar.gz" \
    && echo "${sum}  /tmp/cursor.tar.gz" | sha256sum -c - \
    && mkdir -p /opt/cursor-agent && tar --strip-components=1 -xzf /tmp/cursor.tar.gz -C /opt/cursor-agent && rm /tmp/cursor.tar.gz \
    && ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent \
    && useradd --create-home --shell /usr/sbin/nologin cycle \
    && install -d -o cycle -g cycle /out

COPY cycle.py /cycle/cycle.py
USER cycle
WORKDIR /cycle
ENV CYCLE_OUT=/out
ENTRYPOINT ["python3", "/cycle/cycle.py"]
