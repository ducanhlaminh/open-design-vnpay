# DF-07: Artifact Rendering & Preview Comments Data Flow

**Feature:** Artifact Rendering (HTML, Deck, Markdown) và Preview Comments (Pod/Element annotation)  
**Actors:** User, Web UI (Renderer iframe), Daemon, Filesystem, AI Agent

---

## 1. Artifact File Synchronization Flow

```mermaid
sequenceDiagram
    participant A as 🤖 Agent CLI
    participant FS as 📁 Filesystem
    participant D as ⚙️ Daemon
    participant W as 🌐 Web UI (Preview iframe)

    A->>FS: Ghi file `index.html`
    A-->>D: Tool call: `write_file` event
    D->>D: Phát hiện file update
    D-->>W: SSE event (tool_use / live_artifact update)
    
    W->>D: GET /api/projects/:id/files/index.html (via blob URL proxy)
    D->>FS: Đọc file
    D-->>W: HTML content
    W->>W: Iframe reload (hoặc HMR injection)
    W-->>U: Hiển thị preview mới nhất
```

---

## 2. Preview Comments: Add New Comment

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI (Preview)
    participant D as ⚙️ Daemon
    participant DB as 🗄️ SQLite

    U->>W: Bật chế độ "Comment/Inspect"
    W->>W: Inject inspector overlay vào iframe
    U->>W: Click vào một element (VD: Button)
    W->>W: Lấy CSS Selector, Bounding Box, HTML hint
    U->>W: Nhập text comment ("Đổi màu nút này thành đỏ")
    
    W->>D: POST /api/preview-comments\n{ target: { selector, htmlHint, ... }, note }
    D->>DB: INSERT INTO preview_comments (status=open)
    D-->>W: PreviewCommentResponse
    W-->>U: Hiển thị comment pin trên UI
```

---

## 3. Apply Comments into Chat Flow

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant DB as 🗄️ SQLite
    participant A as 🤖 Agent CLI

    U->>W: Click "Apply Comments" (Gửi các comment đang open vào chat)
    W->>W: Gộp các comment open thành mảng `commentAttachments`
    
    W->>D: POST /api/projects/:id/conversations/:cid/messages\n{ message, commentAttachments }
    
    D->>DB: UPDATE preview_comments (status=attached)
    D->>D: Build prompt: Chuyển commentAttachments thành markdown blocks (chứa selector, note)
    
    D->>A: spawn agent với prompt chứa comments
    A->>A: Phân tích file (đọc index.html)
    A->>A: Tìm element theo selector/html hint
    A->>A: Apply thay đổi (write_file)
    
    A-->>D: Run finished
    D->>DB: UPDATE preview_comments (status=resolved)
    D-->>W: SSE end
    W-->>U: Iframe reload hiển thị thay đổi, comment đổi màu (resolved)
```

---

## 4. Render Types Flow (Mime & Viewers)

```mermaid
flowchart TD
    D[Daemon: Read File] --> CHK{Artifact manifest \n `renderer`?}
    
    CHK -->|html| V_HTML[HTML Iframe\n(có tailwind injection)]
    CHK -->|deck-html| V_DECK[Slide Deck Viewer\n(Reveal.js wrapper)]
    CHK -->|react-component| V_REACT[React Runner\n(Babel in-browser transpile)]
    CHK -->|markdown| V_MD[Markdown Viewer]
    CHK -->|code| V_CODE[Code Editor / Diff View]
    
    V_HTML --> W[Web UI]
    V_DECK --> W
    V_REACT --> W
    V_MD --> W
    V_CODE --> W
```

---

## Data Store Map

| Data | Location | Notes |
|------|----------|-------|
| Artifact Files | Filesystem `.od/projects/<id>/` | Phục vụ trực tiếp qua HTTP route `/:id/files/*` |
| `PreviewComment` | SQLite `preview_comments` | Lưu bounding box, selector, html hint |
| Comment Status | SQLite | Trạng thái: `open`, `attached`, `applying`, `resolved` |
| `ArtifactManifest` | File `artifact.json` hoặc HTML comment | Định nghĩa cách render (renderer) |
