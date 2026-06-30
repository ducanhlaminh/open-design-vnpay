# F-16: MCP Integration

**Nhóm:** 🔌 Platform — MCP  
**Nguồn code:** `apps/daemon/src/mcp.ts` (49KB), `apps/daemon/src/mcp-config.ts` (56KB)  
**UI:** `McpClientSection.tsx` (50KB)  
**Protocol:** Model Context Protocol (Anthropic spec)

---

## 1. Tổng quan

**Model Context Protocol (MCP)** cho phép tích hợp external tools và data sources vào agent context. Daemon vừa là **MCP Server** (expose tools cho agents) vừa là **MCP Client** (kết nối đến external MCP servers).

---

## 2. MCP Server — Daemon → Agent

Daemon expose MCP server cho agents để:

| Tool | Mô tả |
|------|-------|
| **Read live artifacts** | Đọc live artifact content và state |
| **Write live artifacts** | Cập nhật live artifact source data |
| **Access project files** | Read/write files trong project directory |
| **Execute design tools** | Trigger design operations |

**Use case:** Agent MCP tool dùng MCP để tạo Normal Artifact và persist manifest vào Active Project.

---

## 3. MCP Client — Daemon → External

Daemon kết nối như MCP client đến external MCP servers:

### 3.1 Config Management

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/mcp/config` | GET | Đọc MCP client config |
| `/api/mcp/config` | PUT | Cập nhật MCP client config |
| `/api/mcp/templates` | GET | MCP config templates sẵn có |

### 3.2 MCP Config Templates

Các templates phổ biến:
- **GitHub MCP** — Access repos, PRs, issues
- **Slack MCP** — Messages, channels
- **Notion MCP** — Pages, databases
- **Google Drive MCP** — Files, docs
- **Figma MCP** — Figma files, components

### 3.3 Supported Transport

- **stdio** — Local MCP servers
- **HTTP/SSE** — Remote MCP servers

---

## 4. OAuth 2.0 (F-16.3)

Nhiều MCP connectors yêu cầu OAuth để authenticate:

### 4.1 Flow

```
1. UI trigger: POST /api/mcp/oauth/begin
2. Daemon redirect user đến provider OAuth page
3. User authorize
4. Provider redirect về: POST /api/mcp/oauth/callback
5. Daemon exchange code → access token + refresh token
6. Token stored securely
```

**Grant type:** Authorization Code với PKCE

### 4.2 Token Management

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/mcp/oauth/begin` | POST | Start OAuth flow |
| `/api/mcp/oauth/callback` | POST | OAuth callback handler |
| `/api/mcp/tokens` | GET | Đọc stored tokens |
| `/api/mcp/oauth/refresh` | POST | Refresh expired tokens |

---

## 5. Tool Token Registry

- Mỗi MCP tool có một token/credential riêng
- Tokens được store encrypted
- Revoke/refresh individual tokens

---

## 6. Live Artifacts MCP Server

Một MCP server chuyên biệt cho Live Artifacts:

```
Agent → MCP tool: read_live_artifact(id)
      → MCP tool: write_live_artifact(id, source_data)
      → MCP tool: refresh_live_artifact(id)
```

Cho phép coding agents trong CLI tương tác với Live Artifacts trong Open Design UI.

---

## 7. Use Everywhere Modal

`UseEverywhereModal.tsx` — Hướng dẫn user cách:
- Thêm Open Design MCP server vào Claude Code config
- Thêm vào Cursor MCP config
- Thêm vào VS Code với MCP extension
- Sử dụng MCP tools từ bất kỳ agent nào

---

## 8. Acceptance Criteria

- [x] MCP config CRUD qua API
- [x] MCP templates sẵn có cho các provider phổ biến
- [x] OAuth 2.0 Authorization Code + PKCE flow
- [x] Token storage + auto-refresh
- [x] Live Artifacts MCP Server expose tools cho agents
- [x] Daemon hoạt động như MCP client đến external servers
