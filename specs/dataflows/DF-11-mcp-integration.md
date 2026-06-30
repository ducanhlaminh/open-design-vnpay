# DF-11: MCP Integration Data Flow

**Feature:** Model Context Protocol (MCP) — Giao tiếp với các external tool servers (File, DB, APIs)  
**Actors:** User, Web UI, Daemon, External MCP Server (stdio/sse/http), Agent CLI

---

## 1. Connect & Configure MCP Server Flow

```mermaid
flowchart TD
    U[User] -->|Nhập cấu hình MCP Server| W[Web UI\nSettings → MCP]
    W -->|POST /api/mcp/servers| D[Daemon]
    
    D --> DB[(SQLite\nconfig.json)]
    DB -->|Lưu cấu hình| D
    
    D --> CHK{Transport type?}
    CHK -->|stdio| STD[Spawn child process\n(VD: npx -y @modelcontextprotocol...)]
    CHK -->|sse| SSE[Mở kết nối SSE client]
    CHK -->|http| HTTP[Ping healthcheck endpoint]
    
    STD --> INIT[Gửi message `initialize`]
    SSE --> INIT
    HTTP --> INIT
    
    INIT --> RES[Nhận Capabilities\n(Tools, Prompts, Resources)]
    RES --> WS[Broadcast state\n(connected)]
```

---

## 2. MCP Tool Execution (During Chat Run)

```mermaid
sequenceDiagram
    participant A as 🤖 Agent CLI
    participant D as ⚙️ Daemon
    participant MCP as 🔌 External MCP Server
    
    Note over A,D: Prompt Stack đã include danh sách MCP Tools
    
    A->>D: Tool call: `mcp_execute`\n{ server: "postgres", tool: "query", args: {"sql": "SELECT..."} }
    
    D->>D: Tra cứu active MCP connection
    
    alt stdio / sse
        D->>MCP: JSON-RPC call `tools/call`
        MCP-->>D: Kết quả JSON
    else http
        D->>MCP: POST HTTP request
        MCP-->>D: Response
    end
    
    D-->>A: Tool result (output)
    
    Note over A: Agent dùng kết quả để tiếp tục generate
```

---

## 3. MCP OAuth Flow (Auth Mode = oauth)

Đối với các MCP server yêu cầu xác thực user riêng (VD: Google Drive MCP).

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant MCP as 🔌 MCP Server

    U->>W: Bấm "Connect" trên MCP Server
    W->>D: POST /api/mcp/servers/:id/oauth/start
    D->>MCP: Request OAuth URL
    MCP-->>D: authorizeUrl, state, redirectUri
    D-->>W: { authorizeUrl, state }
    
    W->>W: Mở popup: window.open(authorizeUrl)
    Note over U,W: User đăng nhập trên trang của Third-party
    
    W->>W: Catcher page nhận callback (postMessage)
    W->>D: POST /api/mcp/servers/:id/oauth/status (polling)
    D-->>W: { connected: true, expiresAt }
    
    W-->>U: Hiển thị trạng thái "Connected"
```

---

## Data Store Map

| Data | Location | Notes |
|------|----------|-------|
| `McpConfig` | SQLite `config.json` | Chứa command, url, môi trường env của các server |
| MCP Active Conns | In-memory (Daemon) | Process reference (stdio) hoặc EventSource (sse) |
| OAuth Tokens | Local Storage / Config | Do Third-party quản lý hoặc Daemon giữ tuỳ protocol |
| MCP Templates | Built-in (Mã nguồn) | Catalog các server có sẵn (Settings → MCP → Add) |
