# DF-04: Project Management Data Flow

**Feature:** Project Management — Quản lý vòng đời project, folder structures, metadata  
**Actors:** User, Web UI, Daemon, SQLite DB, Filesystem

---

## 1. Project Creation Flow

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant DB as 🗄️ SQLite
    participant FS as 📁 Filesystem

    U->>W: Bấm "New Project" (hoặc chọn Skill/Template)
    W->>D: POST /api/projects\n{ name, skillId, designSystemId, metadata, ... }
    
    D->>D: Tạo UUID (projectId)
    D->>FS: mkdir -p {dataDir}/projects/<projectId>
    D->>FS: mkdir -p {dataDir}/projects/<projectId>/.open-design
    
    D->>DB: INSERT INTO projects (id, name, skillId, designSystemId, metadataJson)
    D->>DB: INSERT INTO conversations (id, projectId, title)
    
    D-->>W: { project, conversationId }
    W-->>U: Chuyển hướng vào Project Workspace
```

---

## 2. Project List & Pagination Flow

```mermaid
flowchart TD
    U[User] --> W[Web UI\nHome Dashboard]
    W -->|GET /api/projects?limit=20&offset=0| D[Daemon]
    
    D --> DB[(SQLite\n`projects` table)]
    DB -->|SELECT * FROM projects\nORDER BY updatedAt DESC| D
    
    D --> ENRICH[Tính toán latestRun status\nĐếm file count/size]
    ENRICH --> RES[ProjectsResponse]
    RES --> W
```

---

## 3. Project File Tree Sync Flow

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant FS as 📁 Filesystem

    Note over U,W: Trong Project Workspace (bên trái là File Explorer)
    
    W->>D: GET /api/projects/:id/files
    D->>FS: Đọc thư mục {dataDir}/projects/<projectId>
    D->>D: Parse artifacts (tìm artifact.json / html comments)
    D->>D: Bỏ qua thư mục ẩn (.open-design, node_modules)
    D-->>W: ProjectFilesResponse { files: ProjectFile[] }
    W-->>U: Hiển thị cây thư mục
```

---

## 4. Save as Template Flow

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant DB as 🗄️ SQLite
    participant FS as 📁 Filesystem

    U->>W: Bấm "Save as Template" trên Project
    W->>D: POST /api/projects/:id/template\n{ templateName, description }
    
    D->>FS: Đọc các file quan trọng của project (code, html, config)
    D->>D: Tạo UUID mới (templateId)
    D->>DB: INSERT INTO templates (id, name, sourceProjectId, filesJson)
    
    D-->>W: TemplateResponse
    W-->>U: Thông báo "Template saved successfully"
```

---

## 5. Project Deletion Flow

```mermaid
flowchart TD
    U[User] -->|Click Delete Project| W[Web UI]
    W -->|DELETE /api/projects/:id| D[Daemon]
    
    D --> DB_DEL[(SQLite)]
    DB_DEL -->|DELETE FROM projects\nCASCADE conversations/messages| D
    
    D --> FS_DEL[(Filesystem)]
    FS_DEL -->|rm -rf {dataDir}/projects/<projectId>| D
    
    D --> W_RES[HTTP 200 OK]
    W_RES --> W
```

---

## Data Store Map

| Data | Location | Notes |
|------|----------|-------|
| `Project` | SQLite `projects` table | Chứa `metadataJson` cấu hình chi tiết |
| Project files | Filesystem `{dataDir}/projects/<id>/` | Source of truth cho file nội dung |
| Artifact metadata | Embedded trong file (`artifact.json` hoặc HTML comments) | Được parse khi list files |
| `Conversation` | SQLite `conversations` table | Liên kết 1-n với Project (thực tế 1-1 ở v1) |
| Templates | SQLite `templates` table | Chứa `filesJson` snapshot |
