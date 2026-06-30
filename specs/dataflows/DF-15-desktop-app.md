# DF-15: Desktop App Data Flow

**Feature:** Desktop App Wrapper — Electron/Tauri bọc Next.js (Web UI) và Node.js (Daemon)  
**Actors:** User, Desktop OS, Web UI (Frontend Window), Daemon (Background Process)

---

## 1. Application Startup Flow

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant OS as Desktop OS
    participant M as Desktop Main Process (Electron/Tauri)
    participant D as ⚙️ Daemon (Node.js)
    participant W as 🌐 Web UI (Renderer)

    U->>OS: Mở Open Design App
    OS->>M: Launch Process
    
    M->>M: Khởi tạo AppContext
    
    M->>D: Spawn Daemon (Express Server) ở port 7456
    D->>D: Đọc cấu hình (SQLite/config.json)
    D-->>M: Daemon Ready (Listening)
    
    M->>W: Mở BrowserWindow
    W->>W: Load http://localhost:7456 (hoặc static file)
    W->>D: REST / SSE connection
    W-->>U: Hiển thị Home Dashboard
```

---

## 2. Deep Linking / Handoff Flow

```mermaid
sequenceDiagram
    participant OS as Desktop OS
    participant M as Desktop Main Process
    participant W as 🌐 Web UI

    Note over OS,M: URL Handler đã đăng ký: `opendesign://`
    
    OS->>M: Truyền event "open-url" (e.g. `opendesign://project/uuid`)
    M->>M: Parse deep link
    
    M->>W: IPC Message: Navigation Request (`/project/uuid`)
    W->>W: Next.js Router: navigate
```

---

## 3. Desktop Native Integration Flow

```mermaid
flowchart TD
    W[Web UI\nRenderer] -->|Click Export/Save| M[Main Process\nIPC]
    M -->|Mở Dialog OS| OS_D[Native File Picker]
    
    OS_D -->|User chọn thư mục| M
    M -->|Truyền path| D[Daemon]
    
    D -->|Ghi file| FS[(Local Filesystem)]
    
    W -->|Yêu cầu Notification| M
    M -->|Push Alert| OS_N[Native System Notification]
```

---

## Data Store Map

| Data | Location | Notes |
|------|----------|-------|
| App Config | `~/.od/config.json` hoặc `%APPDATA%` | Shared state cho cả Web UI, Daemon và Desktop App |
| Database | `~/.od/app.sqlite` | Shared data |
| Project Files | `~/.od/projects/` | File lưu nội bộ của App |
