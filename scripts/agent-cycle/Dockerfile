# The official agent cycle figure: pinned clients in a Linux container with no
# keychain, display or operator home.
FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1

ARG CLAUDE_CODE_VERSION=2.1.322
ARG CODEX_VERSION=0.167.2

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates postgresql-client python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    && useradd --create-home --shell /usr/sbin/nologin cycle \
    && install -d -o cycle -g cycle /out

COPY cycle.py /cycle/cycle.py
USER cycle
WORKDIR /cycle
ENV CYCLE_OUT=/out
ENTRYPOINT ["python3", "/cycle/cycle.py"]
