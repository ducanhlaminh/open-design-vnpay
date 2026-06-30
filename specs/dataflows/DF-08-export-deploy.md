# DF-08: Export & Deploy Data Flow

**Feature:** Export Artifact (ZIP, PDF, PPTX) và Deploy (Vercel, Cloudflare)  
**Actors:** User, Web UI, Daemon, Filesystem, External API (Vercel/Cloudflare)

---

## 1. Export Flow (HTML/React to ZIP)

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant FS as 📁 Filesystem

    U->>W: Bấm "Export as ZIP"
    W->>D: POST /api/projects/:id/finalize\n{ action: 'export-zip', fileName: 'index.html' }
    
    D->>FS: Đọc tất cả các file trong project
    D->>D: Lọc các file không cần thiết (.od, metadata)
    D->>D: Nén thành buffer ZIP
    D-->>W: URL download (/api/projects/:id/downloads/<uuid>.zip)
    
    W->>W: Tự động redirect/download file
    W-->>U: File .zip tải xuống máy
```

---

## 2. Deploy Preflight Flow

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant FS as 📁 Filesystem

    U->>W: Bấm "Deploy" → Chọn Vercel
    W->>D: POST /api/projects/:id/deploy/preflight
    
    D->>FS: Quét cấu trúc file project
    D->>D: Kiểm tra điều kiện deploy:\n- Có index.html / package.json chưa?\n- File có quá lớn không?\n- Thiếu viewport/doctype không?
    D-->>W: DeployPreflightResponse { files, warnings, totalBytes }
    
    W-->>U: Hiển thị bảng Confirm Deploy (kèm cảnh báo nếu có)
```

---

## 3. Deploy to Vercel Flow

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant DB as 🗄️ SQLite
    participant V as 🔗 Vercel API

    U->>W: Confirm Deploy
    W->>D: POST /api/projects/:id/deploy\n{ providerId: 'vercel' }
    
    D->>DB: Tạo Deployment record (status: 'deploying')
    
    D->>V: Lấy API token từ Auth (nếu có)
    D->>V: POST /v13/deployments (Upload files trực tiếp hoặc qua github)
    V-->>D: Deployment ID & URL
    
    D->>DB: Cập nhật URL & status = 'ready'
    D-->>W: DeploymentInfo
    W-->>U: Hiển thị URL Deploy thành công
```

---

## 4. Deploy to Cloudflare Pages Flow

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant DB as 🗄️ SQLite
    participant CF as 🔗 Cloudflare API

    W->>D: POST /api/projects/:id/deploy\n{ providerId: 'cloudflare-pages' }
    D->>DB: Tạo Deployment record
    
    D->>CF: Upload files via Direct Upload API (Pages)
    CF-->>D: Dự án name & pages.dev URL
    
    D->>CF: Cấu hình DNS / Custom domain (nếu setup)
    CF-->>D: DNS Status
    
    D->>DB: Cập nhật CloudflarePagesDeploymentInfo
    D-->>W: DeploymentInfo
```

---

## 5. Handoff Flow (to Figma / Code Agent)

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon

    U->>W: Bấm "Open in Cursor"
    W->>D: POST /api/projects/:id/handoff\n{ targetSurface: 'cursor' }
    
    D->>D: Generate handoff token
    D-->>W: HandoffResponse { url: "cursor://...", token }
    
    W->>W: window.open(url)
    W-->>U: Chuyển hướng sang external app
```

---

## Data Store Map

| Data | Location | Notes |
|------|----------|-------|
| `DeploymentInfo` | SQLite `deployments` | Tracking URL, provider, status |
| Custom Domain | SQLite (trong `DeploymentInfo`) | Cloudflare DNS record status |
| Export Artifacts | FS `/tmp` hoặc in-memory stream | Bị xóa sau khi download xong |
