# od-agent-sandbox — the agent-in-sandbox runtime for the docs-to-react
# workflow (see docs/agent-in-sandbox-spec-plan.md in the parent repo).
#
# Layers the Claude Code CLI on top of uireact-base so the agent AND the
# React build toolchain live in one container: the daemon spawns
# `docker run -i … claude -p …` instead of a host `claude` process, and the
# ui-react skill's build.sh runs `tsc && vite build` directly in-container
# (UIREACT_IN_SANDBOX=1) — no docker-in-docker.
#
# Layout contract (inherited from uireact-base): the shared toolkit lives at
# /work/node_modules; the project dir is bind-mounted at /work/app (a CHILD
# dir) so Node/Vite/tsc resolve deps by walking up. NEVER mount the project
# at /work — that would shadow the toolkit.
#
# Auth contract: a shared named volume (default `od-claude-auth`) is mounted
# at /home/node/.claude and CLAUDE_CONFIG_DIR points there, so OAuth
# credentials + CLI config persist across throwaway containers. Login once:
#   docker run -it --rm -v od-claude-auth:/home/node/.claude \
#     od-agent-sandbox:<ver> claude /login
ARG TOOLKIT_VERSION
FROM uireact-base:${TOOLKIT_VERSION}

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

# All Claude CLI state (credentials, config, onboarding) lives in the mounted
# auth volume — including what would otherwise land at ~/.claude.json.
ENV CLAUDE_CONFIG_DIR=/home/node/.claude
RUN mkdir -p /home/node/.claude && chown -R node:node /home/node

LABEL org.opencontainers.image.title="od-agent-sandbox" \
      org.opencontainers.image.description="Claude Code agent + VNPAY React toolkit sandbox for docs-to-react"

USER node
# Pre-warm the pinned Atlassian MCP server into uv's cache NOW, at image
# build time: the container filesystem is throwaway, so without this every
# jira-ingest run would re-download the Python package tree at cold start.
# Keep the pin in sync with buildAtlassianServer in apps/daemon/src/mcp-config.ts.
RUN uvx mcp-atlassian@0.21.1 --help > /dev/null

WORKDIR /work/app
