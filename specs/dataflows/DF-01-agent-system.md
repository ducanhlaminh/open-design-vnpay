# DF-01: Agent System & BYOK Data Flow

**Feature:** Agent System — Multi-agent support, BYOK proxy, SSRF protection  
**Actors:** User, Web UI, Daemon, Agent CLI, AI Provider, SQLite DB, Filesystem

---

## 1. Agent Discovery Flow

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant DB as 🗄️ SQLite

    U->>W: Mở Settings → Agent
    W->>D: GET /api/agents
    D->>D: Quét PATH cho 16 binary names\n(claude, cursor, codex, amp, ...)
    D->>D: Kiểm tra binary tồn tại + version
    D->>DB: Cache kết quả (available/not_found)
    D-->>W: AgentsResponse { agents: AgentInfo[] }
    W-->>U: Hiển thị danh sách với badge Available/Not found
```

---

## 2. BYOK API Proxy Flow

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon (proxy)
    participant P as ☁️ AI Provider

    Note over U,W: User chọn BYOK mode trong Settings
    U->>W: Nhập API Key + Base URL + Model
    W->>D: PUT /api/config { apiKey, baseUrl, model, protocol }
    D->>D: Validate SSRF (block private IPs, loopback OK)
    D->>DB: Lưu config (apiKey masked trong memory)

    Note over W,P: Khi Agent gọi AI
    W->>D: POST /api/proxy/ { messages, model, stream:true }
    D->>D: Kiểm tra SSRF guard trên baseUrl
    D->>P: Forward request (Authorization: Bearer <apiKey>)
    P-->>D: SSE stream (delta tokens)
    D-->>W: Relay SSE stream
    W-->>U: Hiển thị tokens streaming
```

---

## 3. SSRF Validation Flow

```mermaid
flowchart TD
    A[User nhập Base URL] --> B{Parse URL}
    B -->|Invalid URL| ERR1[Error: Invalid baseUrl]
    B -->|Valid| C{Protocol?}
    C -->|Not http/https| ERR2[Error: Only http/https allowed]
    C -->|http/https| D{Host là loopback?\nlocalhost, 127.x, ::1}
    D -->|Yes| OK[✅ Allowed — dùng cho Ollama local]
    D -->|No| E{Host là private/blocked IP?\n10.x, 192.168.x, 169.254.x\n172.16-31.x, 0.0.0.0, fc00::, fe80::}
    E -->|Yes| ERR3[Error: Internal IPs blocked\nHTTP 403]
    E -->|No| OK2[✅ Allowed — external API]
```

---

## 4. Agent Connection Test Flow

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant A as 🤖 Agent CLI
    participant P as ☁️ AI Provider

    U->>W: Click "Test Connection"
    W->>D: POST /api/connection-test\n{ mode: 'agent', agentId }

    rect rgb(240, 248, 255)
        Note over D,A: Phase 1: binary_resolution
        D->>D: Tìm binary path trong PATH
    end

    rect rgb(240, 255, 240)
        Note over D,A: Phase 2: version_probe
        D->>A: spawn --version
        A-->>D: version string
    end

    rect rgb(255, 248, 240)
        Note over D,A: Phase 3: spawn + smoke test
        D->>A: spawn với test prompt
        A->>P: gọi AI (model test)
        P-->>A: response
        A-->>D: output
    end

    D-->>W: ConnectionTestResponse\n{ ok, kind, latencyMs, sample, diagnostics }
    W-->>U: Hiện kết quả OK / Error với detail
```

---

## 5. Per-agent Model Selection Flow

```mermaid
flowchart LR
    U[👤 User\nchọn Agent] --> D{Daemon}
    D -->|Probe models| A[Agent CLI]
    A -->|model list| D
    D -->|fallback nếu probe fail| FB[Static model list]
    D --> W[🌐 Web UI]
    W -->|Hiển thị| DD[Dropdown model\nper-agent]
    U -->|Chọn model| SAVE[PUT /api/config\nagentModels]
    SAVE --> DB[(SQLite\nconfig.json)]
```

---

## Data Store Map

| Data | Location | Schema |
|------|----------|--------|
| Agent availability cache | SQLite `config.json` | `{ agentId: { available, version, path } }` |
| BYOK API key | `config.json` | Plain text (not encrypted at rest) |
| Agent model prefs | `config.json` | `agentModels: Record<agentId, {model, reasoning}>` |
| Connection test result | In-memory (not persisted) | `ConnectionTestResponse` |

---

## Error Paths

| Scenario | Error | User Action |
|---------|-------|------------|
| Binary không tìm thấy | `agent_not_installed` | Hướng đến `installUrl` |
| Auth thiếu (API key) | `agent_auth_required` | Cấu hình credentials |
| SSRF blocked | `forbidden` | Dùng public URL |
| Rate limited | `rate_limited` | Chờ hoặc nâng plan |
| Provider down | `upstream_unavailable` | Retry sau |
