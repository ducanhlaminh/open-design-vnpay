# DF-06: Discovery Form & Direction Picker Data Flow

**Feature:** Discovery Form — Thu thập thông tin requirement đầu vào từ user một cách có cấu trúc trước khi sinh code. Cung cấp Direction Picker để chọn visual direction.  
**Actors:** User, Web UI, Daemon, AI Agent

---

## 1. Discovery Form Injection Flow

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant A as 🤖 Agent CLI

    U->>W: Khởi tạo project với Skill có `discovery-question-form` atom
    W->>D: POST /api/projects
    
    D->>D: Set ProjectMetadata (chứa cờ skipDiscoveryBrief=false)
    
    Note over D,A: Khi bắt đầu chat run đầu tiên
    D->>D: Inject DISCOVERY directives vào System Prompt
    D->>A: spawn agent với prompt = "Hãy sinh ra một form JSON để hỏi user..."
    A-->>D: Tool call: `render_genui` { kind: 'form', schema: ... }
    D-->>W: SSE event (tool_use)
    W-->>U: Hiển thị UI Form tương tác
```

---

## 2. User Form Submission Flow

```mermaid
flowchart TD
    U[User điền form] --> W[Web UI]
    W -->|Submit form data| W2[Format data thành Markdown]
    
    W2 -->|POST /messages\n{ message: "Discovery Form Data:\n..." }| D[Daemon]
    
    D --> DB[(SQLite\nChat Message)]
    D --> A[🤖 Agent CLI]
    A -->|Phân tích Data| P[AI Provider]
    P -->|Phản hồi kế hoạch| A
    A -->|Streaming text / Update Artifact| D
    D -->|SSE Stream| W
    W -->|Hiển thị kết quả| U
```

---

## 3. Direction Picker Flow (Visual Styles)

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant A as 🤖 Agent CLI

    A-->>D: Tool call: `render_genui` { kind: 'choice', type: 'visual-direction', options: [...] }
    D-->>W: SSE event (tool_use)
    
    W-->>U: Hiển thị Grid các Visual Directions (Minimal, Brutalism, v.v.)
    U->>W: Click chọn một Style (vd: Brutalism)
    
    W->>D: POST /messages\n{ message: "Selected direction: Brutalism" }
    D->>A: Tiếp tục hội thoại với Style đã chọn
    A->>A: Áp dụng style vào việc sinh UI Artifact
```

---

## 4. Skip Discovery Flow (Batch / API)

```mermaid
flowchart LR
    API[External API/Routine] -->|POST /api/projects\nskipDiscoveryBrief=true| D[Daemon]
    D --> DB[(ProjectMetadata)]
    
    D --> CHK{Prompt Stack Assembly}
    DB --> CHK
    
    CHK -->|skip=true| INJ[Bỏ qua DISCOVERY directives]
    INJ --> A[Agent CLI\nChạy thẳng vào generate]
```

---

## Data Store Map

| Data | Location | Notes |
|------|----------|-------|
| Form Schema | In-memory stream (từ Agent) | Agent tự quyết định schema dựa trên prompt |
| Form Data (submitted) | SQLite `messages` | Lưu dưới dạng text / markdown từ user turn |
| Skip Flag | SQLite `projects.metadataJson` | Dùng để bỏ qua form khi chạy automation |
