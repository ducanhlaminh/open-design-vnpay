# F-01 & F-02: Agent System — Multi-Agent Detection & BYOK Proxy

**Nhóm:** 🤖 Core — Agent System  
**Nguồn code:** `apps/daemon/src/agents.ts`, `apps/daemon/src/server.ts`, `apps/daemon/src/connectionTest.ts`  
**API:** `GET /api/agents`, `POST /api/proxy/{provider}/stream`

---

## 1. Tổng quan

Open Design không tích hợp AI model riêng. Thay vào đó, daemon tự động phát hiện các **coding agent CLI** đã cài sẵn trên máy user, spawn chúng như subprocess trong project directory, và stream output về UI qua **Server-Sent Events (SSE)**.

> "We don't ship an agent. Yours is good enough."

---

## 2. Multi-Agent Detection (F-01)

### 2.1 Danh sách 16 agent được hỗ trợ

| Agent ID | CLI Binary | Protocol | Nhà cung cấp |
|----------|-----------|---------|--------------|
| `claude` | `claude` | `claude-stream-json` | Anthropic |
| `codex` | `codex` | `json-event-stream` | OpenAI |
| `devin` | `devin` | `acp-json-rpc` | Cognition |
| `cursor-agent` | `cursor-agent` | `json-event-stream` | Cursor |
| `gemini` | `gemini` | `json-event-stream` | Google |
| `opencode` | `opencode` | `json-event-stream` | OpenCode |
| `qwen` | `qwen` | `plain` | Alibaba |
| `qodercli` | `qodercli` | `qoder-stream-json` | Qoder |
| `copilot` | `copilot` | `copilot-stream-json` | GitHub/MS |
| `hermes` | `hermes` | `acp-json-rpc` | — |
| `kimi` | `kimi` | `acp-json-rpc` | Moonshot AI |
| `pi` | `pi` | `pi-rpc` | Inflection AI |
| `kiro-cli` | `kiro-cli` | `acp-json-rpc` | AWS |
| `kilo` | `kilo` | `acp-json-rpc` | — |
| `vibe-acp` | `vibe-acp` | `acp-json-rpc` | Mistral Vibe |
| `deepseek` | `deepseek` | `plain` | DeepSeek |

### 2.2 Cơ chế phát hiện

- Daemon scan `PATH` khi khởi động
- Mỗi agent có status: `available` | `not_found`
- Kết quả cache và refresh khi user reload
- Daemon cần ≥1 agent CLI **hoặc** BYOK API config hợp lệ để cho phép tạo artifact

### 2.3 API

```http
GET /api/agents
→ AgentInfo[]
```

```typescript
interface AgentInfo {
  id: string;
  name: string;
  status: 'available' | 'not_found';
  protocol: string;
  binary: string;
}
```

### 2.4 Agent Spawn

```javascript
spawn(agentBinary, args, {
  cwd: `.od/projects/${projectId}/`,
  env: { ...process.env, ...agentSpecificEnv },
  stdio: ['pipe', 'pipe', 'pipe']
})
```

**Windows ENAMETOOLONG fallbacks:** Khi command line > 8191 ký tự → stdin injection hoặc prompt-file.

---

## 3. BYOK API Proxy (F-02)

### 3.1 Mô tả

Khi không có agent CLI, daemon đóng vai trò **reverse proxy** chuyển SSE stream từ provider API về client. Hỗ trợ bất kỳ endpoint OpenAI-compatible.

### 3.2 Các provider được hỗ trợ

| Provider | Endpoint Proxy |
|---------|----------------|
| Anthropic | `POST /api/proxy/anthropic/stream` |
| OpenAI | `POST /api/proxy/openai/stream` |
| Azure OpenAI | `POST /api/proxy/azure/stream` |
| Google (Gemini) | `POST /api/proxy/google/stream` |
| Ollama (local) | `POST /api/proxy/ollama/stream` |
| SenseAudio | `POST /api/proxy/senseaudio/stream` |

### 3.3 Chuẩn hóa SSE response

Tất cả provider trả về SSE events theo format thống nhất:

```
event: delta
data: {"text": "..."}

event: tool_use
data: {"name": "...", "input": {...}, "output": {...}}

event: end
data: {}

event: error
data: {"message": "..."}
```

### 3.4 SSRF Protection

| Rule | Status |
|------|--------|
| Loopback (`127.0.0.1`, `::1`) | ✅ ALLOWED (dành cho Ollama, LM Studio) |
| Private IP (192.168.x.x, 10.x.x.x) | ❌ REJECTED |
| Link-local (169.254.x.x) | ❌ REJECTED |
| CGNAT (100.64.x.x/10) | ❌ REJECTED |
| Multicast | ❌ REJECTED |
| Upstream redirect | ❌ DISABLED |

### 3.5 SenseAudio đặc biệt

Proxy SenseAudio expose thêm `generate_image` và `generate_video` tools để model có thể tạo artifact media trực tiếp.

---

## 4. Model Picker và Agent Switching

- **One-click switch** giữa các agents từ model picker trong UI
- **Per-project agent**: Có thể set agent khác nhau cho từng project
- **agentModels**: Config model khác nhau per-agent (trong `AppConfig`)
- **agentCliEnv**: Custom env variables per-agent CLI

---

## 5. Connection Test

Endpoint test kết nối agent/API:
```http
POST /api/agents/test
Body: { agentId: string } | { apiKey: string, baseUrl: string, model: string }
→ { ok: boolean, error?: string }
```

Kết quả trả về trong vòng **5 giây**.

---

## 6. Acceptance Criteria

- [x] Hiển thị danh sách agents với badge `Available` / `Not found`
- [x] Test connection trả về kết quả trong 5 giây
- [x] Chuyển đổi agent một click từ model picker
- [x] BYOK proxy hoạt động khi không có CLI agent
- [x] SSRF blocking: loopback OK, private/link-local/CGNAT rejected
- [x] Daemon cần ≥1 agent hoặc BYOK config để unlock artifact creation
