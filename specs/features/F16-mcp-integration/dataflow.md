# F-16: MCP Integration — Data Flow

## MCP Server (Daemon Exposes Tools to Agents)

```
Agent (Claude CLI, Codex, etc.)
    │
    ├── MCP tool call: read_live_artifact({ id: "artifact-xyz" })
    │       │
    │       ▼
    │   Daemon MCP Server
    │       ├── Look up LiveArtifact by id in SQLite
    │       ├── Return: { html, sourceData, preview }
    │       └── → MCP response to agent
    │
    ├── MCP tool call: write_live_artifact({ id, sourceData })
    │       │
    │       ▼
    │   Daemon MCP Server
    │       ├── UPDATE live_artifacts SET source_data = … WHERE id = …
    │       └── → { success: true }
    │
    └── MCP tool call: refresh_live_artifact({ id })
            │
            ▼
        POST /api/projects/:pid/live-artifacts/:id/refresh (internal)
            └── → trigger refresh pipeline
```

## MCP Client Config Flow

```
GET /api/mcp/config
    └── → McpClientConfig { servers: McpServerConfig[] }

PUT /api/mcp/config
    Body: {
      servers: [
        {
          id: "github",
          transport: "stdio",
          command: "npx @modelcontextprotocol/server-github",
          env: { GITHUB_TOKEN: "…" }
        },
        {
          id: "figma",
          transport: "http",
          url: "https://mcp.figma.com/v1/sse"
        }
      ]
    }
    └── → { config: McpClientConfig }

GET /api/mcp/templates
    └── → McpConfigTemplate[] (GitHub, Slack, Notion, Google Drive, Figma)
```

## OAuth 2.0 Flow

```
Step 1: Begin OAuth
POST /api/mcp/oauth/begin
    Body: { serverId: "github", scopes: ["repo", "read:user"] }
    │
    ▼
Daemon:
    ├── Generate PKCE code_verifier + code_challenge
    ├── Build authorization URL:
    │   https://github.com/login/oauth/authorize
    │   ?client_id=…&redirect_uri=…&scope=repo&code_challenge=…
    └── → { authorizeUrl: "https://github.com/…" }
    │
    ▼
UI: Redirect user to authorizeUrl

---

Step 2: User Authorizes
Provider → redirect to:
    http://localhost:7456/api/mcp/oauth/callback?code=abc&state=xyz
    │
    ▼
Daemon: POST /api/mcp/oauth/callback
    ├── Validate state parameter
    ├── Exchange code + code_verifier → access_token + refresh_token
    │   POST https://github.com/login/oauth/access_token
    ├── Store tokens encrypted (keyed by serverId)
    └── → { success: true }

---

Step 3: Token Refresh
POST /api/mcp/oauth/refresh
    Body: { serverId: "github" }
    │
    ▼
Daemon:
    ├── Load refresh_token for serverId
    ├── POST to provider token endpoint with refresh_token
    ├── Update stored tokens
    └── → { expires_at: timestamp }
```

## Token Registry Flow

```
GET /api/mcp/tokens
    └── → [{ serverId, tokenMask, expiresAt, scopes }]
        (access tokens masked, not exposed in full)

DELETE /api/mcp/tokens/:serverId
    └── Remove stored credentials for server
        → { revoked: true }
```

## Live Artifacts MCP Server Registration

```
Daemon startup
    │
    ▼
Register Live Artifacts MCP server:
    {
      name: "open-design-live-artifacts",
      transport: "stdio",
      tools: [
        "read_live_artifact",
        "write_live_artifact",
        "refresh_live_artifact"
      ]
    }
    │
    ▼
CLI agents discover via MCP discovery protocol
    └── Can now call live artifact tools from terminal
```

## Use Everywhere Flow

```
UI: UseEverywhereModal
    │
    ├── Generate MCP server config snippet for Claude Code:
    │   {
    │     "mcpServers": {
    │       "open-design": {
    │         "command": "npx @open-design/mcp-server",
    │         "env": { "OD_DAEMON_URL": "http://localhost:7456" }
    │       }
    │     }
    │   }
    │
    ├── Snippet for Cursor: similar format
    └── Snippet for VS Code MCP extension: similar format
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/mcp/config` | Read MCP client config |
| PUT | `/api/mcp/config` | Update MCP client config |
| GET | `/api/mcp/templates` | List config templates |
| POST | `/api/mcp/oauth/begin` | Start OAuth flow |
| POST | `/api/mcp/oauth/callback` | OAuth callback handler |
| GET | `/api/mcp/tokens` | List stored tokens (masked) |
| DELETE | `/api/mcp/tokens/:serverId` | Revoke token |
| POST | `/api/mcp/oauth/refresh` | Refresh expired token |
