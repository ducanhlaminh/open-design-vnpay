# od-agent-sandbox — the agent-in-sandbox runtime for the docs-to-react
# workflow (see docs/agent-in-sandbox-spec-plan.md in the parent repo).
#
# Layers the Claude Code CLI and Codex CLI on top of uireact-base so the
# agent AND the React build toolchain live in one container: the daemon
# spawns `docker run -i … claude -p …` or `docker run -i … codex …` instead
# of host processes, and the ui-react skill's build.sh runs `tsc && vite build`
# directly in-container (UIREACT_IN_SANDBOX=1) — no docker-in-docker.
#
# Layout contract (inherited from uireact-base): the shared toolkit lives at
# /work/node_modules; the project dir is bind-mounted at /work/app (a CHILD
# dir) so Node/Vite/tsc resolve deps by walking up. NEVER mount the project
# at /work — that would shadow the toolkit.
#
# Auth contract: runtime-specific shared named volumes persist OAuth/device
# credentials across throwaway containers:
#   - Claude: `od-claude-auth` at /home/node/.claude
#   - Codex: `od-codex-auth` at /home/node/.codex
# Login once with the matching CLI command and the volume keeps the file-
# backed credentials/config. The container never mutates the host's home dir.
ARG TOOLKIT_VERSION
# BASE_IMAGE defaults to the locally-built base; push-ghcr.sh overrides it to
# the registry ref so buildx can resolve a multi-arch base during cross-builds.
ARG BASE_IMAGE=uireact-base:${TOOLKIT_VERSION}
FROM ${BASE_IMAGE}

USER root
# git: skills that init a local repo; ripgrep: Claude Code's search backend;
# jq/curl: skill scripting + calling the daemon API over host.docker.internal;
# python3: runtime for uvx-launched stdio MCP servers (mcp-atlassian).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ripgrep jq curl ca-certificates procps python3 \
 && rm -rf /var/lib/apt/lists/*

# uv/uvx — the launcher the daemon-seeded .mcp.json uses for the Atlassian
# stdio MCP server (`uvx mcp-atlassian@<pin>`). Installed system-wide so the
# node user finds it on PATH.
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# Pin the agent CLI — bump sandbox.version + rebuild deliberately, never float
# to latest (a silent CLI bump mid-week would change agent behavior).
ARG CLAUDE_CODE_VERSION
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
ARG CODEX_VERSION
RUN npm install -g "@openai/codex@${CODEX_VERSION}"

# All Claude CLI state (credentials, config, onboarding) lives in the mounted
# auth volume — including what would otherwise land at ~/.claude.json. Codex
# is file-backed too, via CODEX_HOME=/home/node/.codex and the od-codex-auth
# volume.
ENV CLAUDE_CONFIG_DIR=/home/node/.claude
ENV CODEX_HOME=/home/node/.codex
RUN mkdir -p /home/node/.claude && chown -R node:node /home/node
RUN mkdir -p /home/node/.codex && chown -R node:node /home/node

LABEL org.opencontainers.image.title="od-agent-sandbox" \
      org.opencontainers.image.description="Claude Code and Codex agents + VNPAY React toolkit sandbox"

USER node
# Pre-warm the pinned Atlassian MCP server into uv's cache NOW, at image
# build time: the container filesystem is throwaway, so without this every
# jira-ingest run would re-download the Python package tree at cold start.
# Keep the pin in sync with buildAtlassianServer in apps/daemon/src/mcp-config.ts.
#
# SKIPPED on cross-arch builds (BUILDARCH≠TARGETARCH, e.g. the amd64 half of a
# push-ghcr.sh run on Apple Silicon): Python segfaults under QEMU emulation
# here. Those images just re-download the package tree on their first
# jira-ingest run — a one-time cold start, not a functional loss. BuildKit
# auto-fills these ARGs; legacy builders leave them empty → pre-warm runs.
ARG BUILDARCH
ARG TARGETARCH
RUN if [ -z "${BUILDARCH:-}" ] || [ "${BUILDARCH}" = "${TARGETARCH}" ]; then \
      uvx mcp-atlassian@0.21.1 --help > /dev/null; \
    else \
      echo "[sandbox] skip mcp-atlassian pre-warm (cross-build ${BUILDARCH}→${TARGETARCH}, QEMU segfault)"; \
    fi

WORKDIR /work/app
