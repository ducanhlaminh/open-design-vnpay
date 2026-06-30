# DF-14: Live Artifacts Data Flow

**Feature:** Live Artifacts — Các artifact có khả năng tự động cập nhật dữ liệu (Refreshable) thông qua Connector hoặc Tool.  
**Actors:** User, Web UI, Daemon, Filesystem, External API (Connectors), SQLite DB

---

## 1. Live Artifact Creation Flow

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant A as 🤖 Agent CLI
    participant FS as 📁 Filesystem

    U->>W: Nhập Prompt tạo Live Dashboard (Kèm Connector Notion)
    W->>D: Start Chat Run
    D->>A: spawn agent
    
    A->>A: Tool call `create_live_artifact`\n{ id, title, source: { connector... }, outputMapping }
    A-->>D: Event `live_artifact` (action: created)
    D-->>W: SSE event (Update UI badge)
    
    A->>FS: Ghi file preview `index.html` (chứa logic render data.json)
    A->>FS: Ghi data khởi tạo `data.json`
    
    A-->>D: Run finished
    D->>DB: Lưu LiveArtifact metadata (ID, status, refreshPermission)
```

---

## 2. Live Artifact Refresh Flow

Quy trình cập nhật dữ liệu (Refresh) của một Live Artifact.

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant DB as 🗄️ SQLite
    participant C as 🔗 Connector (vd: Notion)
    participant FS as 📁 Filesystem

    Note over U,W: Có thể trigger Manual hoặc qua Routine
    U->>W: Bấm "Refresh Data" trên Live Artifact
    W->>D: POST /api/projects/:id/live-artifacts/:aid/refresh
    
    D->>DB: Ghi LiveArtifactRefreshLog (step: init)
    D-->>W: SSE `live_artifact_refresh` (started)
    
    D->>D: Đọc cấu hình source.connector từ DB
    D->>C: Gọi External API lấy data mới
    C-->>D: Raw JSON Data
    
    D->>D: Apply `outputMapping.transform` (VD: compact_table)
    
    D->>FS: Ghi đè vào file `data.json` của artifact
    
    D->>DB: Cập nhật RefreshLog (succeeded)
    D-->>W: SSE `live_artifact_refresh` (succeeded)
    
    W->>W: Reload iframe preview để đọc `data.json` mới
    W-->>U: Hiển thị Dashboard với dữ liệu mới
```

---

## 3. Data Transformation Flow

```mermaid
flowchart TD
    RAW[Raw API Data\n(Từ Connector)] --> CHK{Transform?}
    
    CHK -->|identity| RES_IDENT[Giữ nguyên JSON]
    CHK -->|compact_table| RES_COMPACT[Biến đổi mảng object thành mảng 2D headers/rows]
    CHK -->|metric_summary| RES_METRIC[Chỉ lấy các số liệu chính]
    
    RES_IDENT --> SAVE[Lưu vào data.json]
    RES_COMPACT --> SAVE
    RES_METRIC --> SAVE
```

---

## Data Store Map

| Data | Location | Notes |
|------|----------|-------|
| `LiveArtifact` Metadata | SQLite `live_artifacts` | Trạng thái pin, status, refreshPermission |
| Refresh Logs | SQLite `live_artifact_refresh_logs` | Tracking lịch sử mỗi lần refresh |
| Preview File | Filesystem `.od/projects/<id>/<artifactId>.html` | File render giao diện |
| Data File | Filesystem `.od/projects/<id>/<artifactId>.json` | Dữ liệu data.json thực tế (được ghi đè liên tục) |
