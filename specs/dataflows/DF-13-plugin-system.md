# DF-13: Plugin System Data Flow

**Feature:** Hệ thống Plugin (Manifest v1) mở rộng tính năng của Open Design  
**Actors:** User, Web UI, Daemon, SQLite DB, Filesystem, Agent CLI

---

## 1. Plugin Install Flow

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant DB as 🗄️ SQLite
    participant FS as 📁 Filesystem

    U->>W: Install Plugin (từ Local path hoặc URL)
    W->>D: POST /api/plugins/install { source }
    
    D->>D: Đọc open-design.json (Manifest)
    D->>D: Validate bằng Zod schema
    D->>D: Resolve capabilities (fs:read, mcp, network...)
    
    D->>FS: Copy/Extract plugin vào {dataDir}/plugins/<id>/
    D->>DB: Ghi InstalledPluginRecord (status, version, digest)
    
    D-->>W: Install outcome (ok: true)
    W-->>U: Hiển thị plugin trong Settings
```

---

## 2. Apply Plugin to Project Run

Khi User bắt đầu một project mới hoặc một run mới với một plugin cụ thể.

```mermaid
sequenceDiagram
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant DB as 🗄️ SQLite
    participant A as 🤖 Agent CLI
    
    W->>D: Bắt đầu chat run + `pluginId`
    
    D->>DB: Lấy InstalledPluginRecord
    D->>D: Tạo AppliedPluginSnapshot (Immutable copy)
    D->>DB: Lưu Snapshot ID
    
    Note over D,A: Lắp ráp Execution Pipeline
    D->>D: Đọc `pipeline.stages` từ Manifest
    D->>D: Liên kết các MCP servers yêu cầu
    D->>D: Liên kết Connectors yêu cầu
    
    D->>A: spawn agent với Context (Atoms, MCP, Connectors) đã cấp quyền
    
    A->>A: Thực thi tuần tự các Atom trong Pipeline stage
    A-->>D: Report kết quả từng stage
```

---

## 3. GenUI (Plugin UI) Flow

Plugin có thể định nghĩa các form / UI tuỳ chỉnh qua `genui.surfaces`.

```mermaid
flowchart TD
    A[Agent CLI đang chạy Atom] -->|Gặp Atom yêu cầu UI| D[Daemon]
    
    D -->|Tool call render_genui| W[Web UI]
    W -->|Lấy schema từ PluginSnapshot| RENDER[Render Custom Form / Component]
    RENDER --> U[User tương tác]
    
    U -->|Submit form| W2[Gửi lại Daemon]
    W2 -->|Tool result| D
    D -->|Tiếp tục pipeline| A
```

---

## Data Store Map

| Data | Location | Notes |
|------|----------|-------|
| `InstalledPluginRecord` | SQLite `installed_plugins` | Trạng thái cài đặt hiện tại trên máy |
| Plugin Files | Filesystem `{dataDir}/plugins/<id>/` | Mã nguồn/tài sản của plugin (open-design.json) |
| `AppliedPluginSnapshot` | SQLite `plugin_snapshots` | Bản sao bất biến lúc plugin được chạy (chống trôi dạt version) |
