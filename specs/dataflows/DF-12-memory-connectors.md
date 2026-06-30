# DF-12: Memory & Connectors Data Flow

**Feature:** Memory System (Fact extraction) & Connectors (Composio, third-party auth)  
**Actors:** User, Web UI, Daemon, AI Agent (Heuristic/LLM Extractor), SQLite DB, Filesystem, External Connectors (Composio, OAuth)

---

## 1. Memory Extraction Flow (Post-Chat)

```mermaid
sequenceDiagram
    participant D as ⚙️ Daemon
    participant A as 🤖 AI Provider (Extraction LLM)
    participant DB as 🗄️ SQLite
    participant FS as 📁 Filesystem

    Note over D,FS: Khi một chat run vừa hoàn thành
    D->>D: Kiểm tra config: chatExtractionEnabled == true?
    
    D->>D: Lấy nội dung hội thoại vừa diễn ra
    
    rect rgb(240, 248, 255)
        Note over D,A: Lọc Heuristic (Fast)
        D->>D: Tìm keyword (I am, My name is, Use React, ...)
        alt Có keyword tiềm năng
            D->>A: Gọi LLM (VD: Haiku/GPT-4o-mini)
            A-->>D: Trả về mảng các Facts (loại: user, project...)
        end
    end
    
    loop Cho mỗi Fact mới
        D->>DB: Ghi MemoryExtractionRecord (Lịch sử extract)
        D->>FS: Tạo/Cập nhật file `MEMORY.md` hoặc `memory/<slug>.md`
        D->>DB: Lưu MemoryEntrySummary
    end
    
    D-->>W: SSE event (MemoryChange: upsert)
```

---

## 2. Connectors Integration Flow (Composio / Native)

```mermaid
flowchart TD
    U[User] -->|Mở Connectors UI| W[Web UI]
    W -->|GET /api/connectors| D[Daemon]
    
    D --> DB[(SQLite\nConfig)]
    DB --> D
    D --> API[Composio API / Native Providers]
    API --> D
    
    D --> RES[ConnectorDetailResponse]
    RES --> W
    
    W -->|Bấm Connect (VD: Slack)| AUTH[OAuth Flow]
    AUTH -->|Callback| D
    D -->|Lưu Provider Token| DB
```

---

## 3. Connector Tool Execution (By Agent)

```mermaid
sequenceDiagram
    participant A as 🤖 Agent CLI
    participant D as ⚙️ Daemon
    participant C as 🔗 Connector Service (Composio)

    A->>D: Tool call: `connector_execute`\n{ connectorId: "slack", toolName: "send_message", input: {...} }
    
    D->>D: Kiểm tra Safety & Approval (read/write/destructive)
    
    alt Approval = 'confirm' (Chưa được duyệt)
        D-->>W: SSE: Yêu cầu User xác nhận tool call
        W-->>U: Hiển thị Dialog Confirm
        U->>W: Bấm Approve
        W->>D: Trả lời Tool Confirmation
    end
    
    D->>C: Gọi API thực thi Tool
    C-->>D: Kết quả thực thi
    D-->>A: Tool result (JSON)
```

---

## 4. Automation: Connector to Memory Flow

Routine tự động lấy dữ liệu từ Connector và đẩy vào Memory (hoặc tạo Artifact).

```mermaid
flowchart LR
    S[Cron Routine] -->|Trigger| D[Daemon]
    D -->|Execute| C[Connector\n(e.g., Gmail/Notion)]
    C -->|Lấy Data mới| D
    
    D --> ING[Ingestion Pipeline\n(Token Compression)]
    ING --> PACKET[(AutomationContentPacket)]
    
    PACKET --> EV[Evolution Pipeline]
    EV -->|LLM Propose| PROP[Memory Node Proposal]
    
    PROP -->|Auto-apply (if set)| MEM[(Memory Store)]
```

---

## Data Store Map

| Data | Location | Notes |
|------|----------|-------|
| `MemoryEntry` | Filesystem `memory/` (Markdown) | Chứa Frontmatter định danh, nội dung text |
| `MemorySummary` | SQLite (Cache) | Giúp list nhanh không cần đọc đĩa |
| `ExtractionRecord` | SQLite `memory_extractions` | Tracking lịch sử chạy auto-extract |
| Connector Config | SQLite `config.json` | Status connect, token (nếu native), provider type |
| `ConnectorToolDetail` | In-memory / Remote | Cấu hình an toàn của từng tool (read/write/destructive) |
