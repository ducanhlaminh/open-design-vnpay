# DF-17: Import & Templates Data Flow

**Feature:** Import/Template — Nhập dự án từ nguồn bên ngoài (Figma, GitHub, Local Code) và quản lý Template cá nhân  
**Actors:** User, Web UI, Daemon, Filesystem, SQLite DB, External Service (GitHub/Figma)

---

## 1. Import from Source (GitHub / Local)

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant FS as 📁 Filesystem
    participant EXT as 🔗 External Source (Git/Local)

    U->>W: Chọn "Import GitHub" hoặc "Import Local"
    W->>D: POST /api/projects/import\n{ source: 'github', url: '...' }
    
    D->>EXT: Clone repository / Đọc local directory
    
    D->>D: Scan cấu trúc file
    D->>D: Detect template (Next.js, Vite, HTML thuần)
    
    D->>FS: Copy toàn bộ mã nguồn vào `{dataDir}/projects/<uuid>`
    D->>DB: Tạo bản ghi Project mới (kèm metadata detected)
    
    D-->>W: Project { id: uuid }
    W-->>U: Mở Project Workspace (với mã nguồn đã import)
```

---

## 2. Figma Import (Design to Code Flow)

```mermaid
flowchart TD
    U[User nhập Figma URL] --> W[Web UI]
    W -->|POST /api/projects/import/figma| D[Daemon]
    
    D -->|Fetch Nodes/Images| FIG[Figma API]
    FIG -->|JSON & Image URLs| D
    
    D -->|Lưu images/assets| FS[(Filesystem\nProject Dir)]
    
    D -->|Chuyển đổi Figma JSON\nthành HTML/CSS/React Code| AGENT[Agent CLI\nhoặc Heuristic Converter]
    
    AGENT --> FS
    
    D -->|Trả về Project ID| W
    W -->|Load Project UI| U
```

---

## 3. Custom Templates Flow (Save & Reuse)

User có thể lưu lại 1 project bất kỳ làm "Template" để tái sử dụng.

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant DB as 🗄️ SQLite
    participant FS as 📁 Filesystem

    Note over U,W: Save Project as Template
    U->>W: Bấm "Save as Template" từ Project đang mở
    W->>D: POST /api/projects/:id/template
    D->>FS: Đóng gói các file trong project thành 1 JSON/Zip (Snapshot)
    D->>DB: Ghi bản ghi vào `templates` table
    D-->>W: Success
    
    Note over U,W: Create New from Template
    U->>W: Chọn "My Templates" → Chọn template vừa lưu
    W->>D: POST /api/projects { templateId }
    
    D->>DB: Lấy cấu trúc thư mục từ template snapshot
    D->>FS: Giải nén / Ghi file ra thư mục Project mới
    D->>DB: Tạo Project mới
    D-->>W: Project { id: uuid_new }
    W-->>U: Mở workspace mới
```

---

## Data Store Map

| Data | Location | Notes |
|------|----------|-------|
| Import Data | Filesystem `projects/<id>` | Toàn bộ repo Git, files Local đều được copy vào OD filesystem |
| Templates | SQLite `templates` | Snapshot file dưới dạng JSON (nếu nhỏ) hoặc lưu file ZIP trong thư mục ẩn |
| Figma Assets | Filesystem `projects/<id>/assets` | Hình ảnh kéo từ Figma về lưu local để Agent/Code refer |
