# F-05: Project Management

**Nhóm:** 📁 Core — Projects  
**Nguồn code:** `apps/daemon/src/projects.ts`, `apps/daemon/src/db.ts`  
**UI:** `ProjectView.tsx`, `HomeView.tsx`, `RecentProjectsStrip.tsx`, `NewProjectPanel.tsx`  
**API:** `GET /api/projects`, `POST /api/projects`, `PATCH /api/projects/:id`, v.v.

---

## 1. Tổng quan

Projects là **top-level workspace** chứa conversations và design files. Mỗi project có một thư mục riêng trên disk (``.od/projects/<id>/``), được quản lý bởi daemon và persist trong SQLite.

---

## 2. Project Lifecycle

```
Create → Active → [Chat turns] → Files on disk → Export/Deploy → Archive
```

---

## 3. Data Model

```typescript
interface Project {
  id: string;              // UUID
  name: string;
  skillId?: string;        // Skill được chọn
  designSystemId?: string; // Design system được chọn
  pendingPrompt?: string;  // Prompt chờ xử lý
  metadata?: ProjectMetadata;
  customInstructions?: string;
  appliedPluginSnapshotId?: string;
  createdAt: number;
  updatedAt: number;
}

interface ProjectMetadata {
  kind?: ProjectKind;       // 'design' | 'deck' | 'image' | 'video' | 'audio'
  platform?: string;        // 'desktop' | 'mobile'
  fidelity?: string;        // 'low' | 'medium' | 'high'
  speakerNotes?: boolean;
  animations?: boolean;
  inspirationIds?: string[];
  videoModel?: string;      // 'hyperframes-html' cho HyperFrames
}
```

---

## 4. Project Kinds

| Kind | Mô tả |
|------|-------|
| `design` | Web prototype, landing page, dashboard |
| `deck` | Presentation slides |
| `image` | Image generation project |
| `video` | Video generation project |
| `audio` | Audio generation project |

---

## 5. Project Filesystem

```
.od/
├── app.sqlite          ← Metadata DB (WAL mode)
├── artifacts/          ← One-off "Save to disk" renders
├── media-config.json   ← API keys (gitignored)
└── projects/<id>/      ← Working dir (agent's cwd)
    ├── index.html      ← Main artifact file
    ├── brand-spec.md
    ├── style.css
    └── ...
```

**Đặc điểm:**
- Agent có quyền: Read, Write, Bash, WebFetch trên filesystem thực
- Mỗi project là một thư mục độc lập
- Files persist qua daemon restart
- `OD_DATA_DIR` để relocate toàn bộ data directory

---

## 6. File Workspace

Quản lý files trong project:

```typescript
interface ProjectFile {
  name: string;
  content: string;
  size: number;
  updatedAt: number;
}
```

- Sidebar liệt kê tất cả files trong project
- Syntax highlighting cho HTML, CSS, JS, Markdown
- Auto-save sau 2 giây không có thay đổi
- Preview sync với file đang edit

---

## 7. API

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/projects` | GET | Danh sách projects (sorted by updatedAt) |
| `/api/projects` | POST | Tạo project mới |
| `/api/projects/:id` | GET | Chi tiết project |
| `/api/projects/:id` | PATCH | Cập nhật metadata |
| `/api/projects/:id` | DELETE | Xóa project + files |
| `/api/projects/:id/files` | GET | Danh sách files |
| `/api/projects/:id/files/:name` | GET | Đọc file |
| `/api/projects/:id/files/:name` | PUT | Ghi file |
| `/api/projects/:id/files/:name` | DELETE | Xóa file |
| `/api/projects/:id/archive` | GET | Download ZIP archive |
| `/api/projects/:id/transcript` | GET | Conversation transcript (Markdown) |

---

## 8. Home Composer Media Surfaces

Từ Home page, user có thể tạo project với các **Chip Rail** intents:

| Surface | Chip Label | Project Kind | Notes |
|---------|-----------|-------------|-------|
| Design | "Design" | `design` | Prototype, landing page |
| Deck | "Deck" | `deck` | Presentation |
| Image | "Image" | `image` | Image generation |
| Video | "Video" | `video` | Video generation |
| HyperFrames | "Motion" | `video` | `videoModel: "hyperframes-html"` |
| Audio | "Audio" | `audio` | Speech & sound effects |

---

## 9. Quick Switcher

Keyboard shortcut để nhanh chóng switch giữa projects:
- Lưu recent projects list (`quickSwitcherRecents.ts`)
- Search theo project name
- Keyboard navigation

---

## 10. Acceptance Criteria

- [x] Tạo project mới từ Home với skill và design system
- [x] Project list sorted by updatedAt
- [x] Files persist qua daemon restart
- [x] File workspace với syntax highlighting
- [x] Auto-save sau 2 giây
- [x] Download ZIP archive toàn bộ project
- [x] Delete project xóa cả files trên disk
- [x] Sessions persist trong SQLite — mở lại project ngày mai
