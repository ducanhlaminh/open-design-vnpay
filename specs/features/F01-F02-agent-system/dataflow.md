# F-01 & F-02: Agent System — Data Flow

## F-01: Multi-Agent Detection Flow

```
Daemon Boot
    │
    ▼
scan PATH for 16 known binaries
    │
    ├── binary found → AgentInfo { status: 'available' }
    └── not found   → AgentInfo { status: 'not_found' }
    │
    ▼
Cache in memory (AgentInfo[])
    │
    ▼
GET /api/agents
    └── → AgentInfo[] to UI
```

## F-02: BYOK Proxy Flow

```
UI                   Daemon Proxy             Provider API
 │                        │                        │
 ├─ POST /api/proxy/{provider}/stream ──────────→  │
 │   { apiKey, model, messages }                   │
 │                        │                        │
 │                   SSRF check                    │
 │                   (reject private IPs)          │
 │                        │                        │
 │                        ├─ forward request ────→ │
 │                        │                        │
 │                   normalize SSE events          │
 │                        │                        │
 │ ←── SSE stream ─────── │ ←── provider SSE ───── │
 │   event: delta         │
 │   event: tool_use      │
 │   event: end           │
```

## Agent Spawn Flow

```
User submits prompt
    │
    ▼
POST /api/projects/:id/conversations/:cid/messages
    │
    ▼
Daemon resolves active agent
    │
    ├── CLI agent available → spawn child_process
    │       ├── cwd = .od/projects/<id>/
    │       ├── env = process.env + agentSpecificEnv
    │       └── stdio = pipe
    │
    └── No CLI → BYOK proxy flow
    │
    ▼
Stream stdout → parse protocol events
    │
    ▼
Emit normalized SSE events to client
```

## SSRF Validation Flow

```
Incoming proxy URL
    │
    ▼
Resolve hostname → IP
    │
    ├── 127.x.x.x / ::1 → ALLOW (Ollama)
    ├── 192.168.x.x     → REJECT
    ├── 10.x.x.x        → REJECT
    ├── 172.16-31.x.x   → REJECT
    ├── 169.254.x.x     → REJECT
    ├── 100.64-127.x.x  → REJECT
    ├── Multicast       → REJECT
    └── Public IP       → ALLOW
```

## Connection Test Flow

```
POST /api/agents/test
    │
    ├── { agentId } → spawn agent --version or ping
    │
    └── { apiKey, baseUrl, model } → send minimal request to API
    │
    ▼
Timeout: 5 seconds
    │
    ▼
→ { ok: boolean, error?: string }
```

## SSE Event Normalization

All agent protocols are normalized to the same event schema:

```
event: delta
data: { "text": "..." }

event: tool_use
data: { "name": "...", "input": {...}, "output": {...} }

event: todo
data: { "items": [{ "label": "...", "status": "..." }] }

event: artifact
data: { "html": "...", "title": "...", "identifier": "..." }

event: file_op
data: { "path": "...", "operation": "write|delete" }

event: question_form
data: { "fields": [...] }

event: direction_picker
data: { "directions": [...] }

event: end
data: { "runId": "...", "status": "succeeded|failed|canceled" }

event: error
data: { "message": "...", "code": "..." }
```

## Data Model

```typescript
interface AgentInfo {
  id: string;
  name: string;
  status: 'available' | 'not_found';
  protocol: string;
  binary: string;
}

interface ConnectionTestRequest {
  agentId?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

interface ConnectionTestResponse {
  ok: boolean;
  error?: string;
}
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agents` | List all agents with status |
| POST | `/api/agents/test` | Test agent or API connection |
| POST | `/api/proxy/{provider}/stream` | BYOK SSE proxy stream |
