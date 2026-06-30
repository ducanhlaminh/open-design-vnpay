# DF-03: Design Systems Data Flow

**Feature:** Design Systems Library — Quản lý, apply và tạo mới (via agent) design systems  
**Actors:** User, Web UI, Daemon, SQLite DB, Filesystem, AI Provider (cho generation/review)

---

## 1. Design System Discovery & Selection

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant FS as 📁 Filesystem

    U->>W: Mở Settings → Design Systems
    W->>D: GET /api/design-systems
    D->>FS: Scan design-systems/ (built-in)
    D->>FS: Scan {dataDir}/design-systems/ (user-installed)
    D->>D: Parse DESIGN.md
    D-->>W: DesignSystemsResponse { designSystems: DesignSystemSummary[] }
    W-->>U: Danh sách thư viện design systems (kèm swatches preview)
```

---

## 2. Apply Design System vào Project

```mermaid
flowchart TD
    U[User chọn Design System] --> W[Web UI]
    W -->|POST /api/projects { designSystemId }| D[Daemon]
    D --> DB[(SQLite\nprojects.designSystemId)]
    
    subgraph RUN_PREP["Run Preparation (Chat Turn)"]
        D2[Daemon] -->|Đọc| FS[Filesystem\nDESIGN.md]
        FS --> EXTRACT[Trích xuất rules, tokens, conventions]
        EXTRACT --> INJECT[Inject vào Prompt Stack (Vị trí ③)]
    end
    
    DB --> D2
```

---

## 3. Tạo/Cập nhật Design System (via AI Agent)

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant A as 🤖 Agent CLI (background task)
    participant FS as 📁 Filesystem

    Note over U,D: Tính năng: Generate Design System từ prompt
    U->>W: Nhập mô tả ("Minimalist tech brand...")
    W->>D: POST /api/design-systems/generate\n{ prompt }
    D->>D: Tạo Job ID (status: queued)
    
    rect rgb(240, 240, 255)
        Note over D,A: Background Generation Process
        D->>A: spawn agent với DESIGN_SYSTEM_SKILL
        A->>A: Phân tích prompt
        A->>A: Sinh ra DESIGN.md (colors, typo, grid, components)
        A-->>D: Output DESIGN.md
        D->>FS: Ghi {dataDir}/design-systems/<id>/DESIGN.md
        D->>D: Update Job status = succeeded
    end
    
    W->>D: Polling GET /api/design-systems/jobs/:id
    D-->>W: Job status (progress)
    W-->>U: Hiển thị thanh tiến trình
    Note over W,U: Khi xong, load lại danh sách Design Systems
```

---

## 4. Design System Review Workflow (Section Revision)

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant A as 🤖 Agent CLI

    U->>W: Mở chi tiết Design System
    U->>W: Chọn 1 section (VD: Colors) → Nhập feedback ("Làm tối hơn")
    W->>D: POST /api/design-systems/:id/revisions\n{ sectionTitle, feedback, baseBody }
    
    D->>D: Tạo Revision object (status=pending)
    D->>A: spawn agent sửa section
    A-->>D: Proposed body cho section đó
    D-->>W: RevisionResponse { proposedBody }
    
    W-->>U: Hiển thị Diff (Before/After)
    U->>W: Click "Accept" hoặc "Reject"
    W->>D: POST /api/design-systems/:id/revisions/:revId/status\n{ status: 'accepted' }
    
    alt accepted
        D->>FS: Cập nhật DESIGN.md
    end
```

---

## 5. Import Design System từ Local / GitHub

```mermaid
flowchart TD
    U[User] --> W[Web UI]
    W -->|POST /api/import-design-system| D[Daemon]
    
    D --> CHK{Nguồn?}
    CHK -->|Local| LOC[Đọc folder nội bộ]
    CHK -->|GitHub| GH[Git clone / download ZIP]
    
    LOC --> PARSE
    GH --> PARSE
    
    PARSE[Parse files:\nCSS/Tailwind tokens\nReact components\nFigma exports] --> ASSEMBLE[Tổng hợp thành DESIGN.md]
    
    ASSEMBLE --> FS[(Filesystem\n{dataDir}/design-systems/)]
    FS --> RES[Trả về DesignSystemSummary]
```

---

## Data Store Map

| Data | Location | Notes |
|------|----------|-------|
| Built-in DS | `design-systems/` | Read-only (`DESIGN.md`) |
| User DS | `{dataDir}/design-systems/<id>/` | Mutable |
| Active DS ID | SQLite `projects.designSystemId` | Persisted per project |
| DS Revisions | SQLite `ds_revisions` | Lịch sử đề xuất thay đổi |
| DS Jobs | SQLite `ds_jobs` | Tracking tiến độ tạo/sửa DS |
