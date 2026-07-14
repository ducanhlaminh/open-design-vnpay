# F-16: MCP Integration — Business Logic

## Overview

The daemon acts simultaneously as an **MCP Server** (exposing tools to agents) and an **MCP Client** (connecting to external MCP servers). OAuth 2.0 with PKCE handles third-party authentication for MCP connectors. A dedicated Live Artifacts MCP Server exposes refresh operations to CLI agents.

---

## Business Rules

### MCP Server (Daemon → Agent)

| Rule | Detail |
|------|--------|
| **BR-01** | Daemon exposes an MCP server that agents can use as a tool source |
| **BR-02** | Exposed tools: read live artifacts, write live artifacts, access project files, execute design operations |
| **BR-03** | CLI agents (Claude, Codex, etc.) can connect to daemon's MCP server |

### MCP Client (Daemon → External)

| Rule | Detail |
|------|--------|
| **BR-04** | Daemon connects to external MCP servers as an MCP client |
| **BR-05** | Supported transports: `stdio` (local servers) and `HTTP/SSE` (remote servers) |
| **BR-06** | MCP client configs are stored and managed via API |
| **BR-07** | Pre-built config templates available for GitHub, Slack, Notion, Google Drive, Figma |

### OAuth 2.0 (F-16.3)

| Rule | Detail |
|------|--------|
| **BR-08** | Grant type: Authorization Code with PKCE |
| **BR-09** | OAuth flow: begin → provider page → user authorizes → callback → token exchange |
| **BR-10** | Access token and refresh token stored securely |
| **BR-11** | Tokens auto-refreshed before expiry |
| **BR-12** | Individual tool tokens can be revoked |

### Tool Token Registry

| Rule | Detail |
|------|--------|
| **BR-13** | Each MCP tool has an independent credential/token |
| **BR-14** | Tokens are stored encrypted |
| **BR-15** | Individual token revoke/refresh supported |

### Live Artifacts MCP Server

| Rule | Detail |
|------|--------|
| **BR-16** | A specialized MCP server exposes Live Artifact operations to CLI agents |
| **BR-17** | Tools: `read_live_artifact`, `write_live_artifact`, `refresh_live_artifact` |
| **BR-18** | Enables CLI agents to interact with Live Artifacts in the Open Design UI |

### Use Everywhere Feature

| Rule | Detail |
|------|--------|
| **BR-19** | UI provides instructions for adding Open Design as an MCP server in: Claude Code, Cursor, VS Code |

---

## MCP Config Templates

| Template | Description |
|----------|-------------|
| GitHub MCP | Access repos, PRs, issues |
| Slack MCP | Messages, channels |
| Notion MCP | Pages, databases |
| Google Drive MCP | Files, docs |
| Figma MCP | Files, components |

---

## Acceptance Criteria

- [ ] MCP config CRUD via API
- [ ] MCP templates available for popular providers
- [ ] OAuth 2.0 Authorization Code + PKCE flow
- [ ] Token storage + auto-refresh
- [ ] Live Artifacts MCP Server exposes tools to agents
- [ ] Daemon works as MCP client to external servers
