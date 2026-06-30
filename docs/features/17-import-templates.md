# F-12: Import & Templates

**Nhóm:** 📥 Platform — Import & Templates  
**Nguồn code:**
- `apps/daemon/src/claude-design-import.ts`
- `apps/daemon/src/import-export-routes.ts`
- `apps/daemon/src/db.ts` (table: `templates`)

---

## 1. Import (F-11)

### 1.1 Import Claude Design ZIP

**Mô tả:** Nhập project từ Claude Design (Anthropic) vào Open Design.

```http
POST /api/import/claude-design
Content-Type: multipart/form-data
Body: { zip: File }
→ { projectId, name }
```

**Flow:**
```
User drag & drop ZIP vào welcome dialog
  → POST /api/import/claude-design
  → Parse ZIP format của Claude Design
  → Tạo project mới với UUID
  → Copy files vào .od/projects/<id>/
  → Reconstruct conversation history
  → Return { projectId }
  → UI navigate đến project
```

**Tính năng:**
- Support Claude Design export ZIP format
- Project history được giữ nguyên
- Files accessible trong File Workspace
- Error message rõ ràng nếu ZIP invalid hoặc sai format

### 1.2 GitHub Design System Import

```http
POST /api/design-systems/import/github
Body: { repoUrl: string }
```

**Flow:**
```
User paste GitHub repo URL
  → Daemon fetch repo (hoặc clone)
  → Parse DESIGN.md
  → Extract: name, colors, typography, components
  → Validate 9-section schema
  → Add to user's design systems library
```

---

## 2. Templates (F-12)

### 2.1 Tổng quan

User có thể lưu project làm **template** để tái sử dụng sau này. Template capture file structure và nội dung hiện tại của project.

### 2.2 Data Model

```typescript
interface ProjectTemplate {
  id: string;
  name: string;
  description?: string;
  sourceProjectId?: string;     // Project gốc được lưu làm template
  files: ProjectFile[];         // Snapshot của project files
  createdAt: number;
}
```

### 2.3 Template Lifecycle

```
Project (completed) → "Save as Template" → Template Library
                                          ↓
New Project → Browse Templates → Select → Create from Template
```

### 2.4 API

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/templates` | GET | Danh sách templates |
| `/api/templates` | POST | Tạo template từ project |
| `/api/templates/:id` | GET | Chi tiết template |
| `/api/templates/:id` | PUT | Update template |
| `/api/templates/:id` | DELETE | Xóa template |

### 2.5 Tính năng

- **Save as Template**: Lưu project hiện tại làm template
- **Templates Library**: Browse và search templates
- **Preview template** trước khi dùng
- **Create from Template**: Tạo project mới từ template
- Template giữ file structure, cho phép customize sau khi tạo

---

## 3. Design Files Import

Ngoài Claude Design ZIP, user có thể import:

### 3.1 File Upload trong Chat

- Drag & drop images, documents vào chat composer
- Paste image từ clipboard
- File đính kèm như chat attachment
- Agent có thể reference file trong context

### 3.2 Figma Import (via Skills)

- `figma-use` skill: Kết nối với Figma MCP
- Import Figma designs thành HTML/CSS artifacts
- `figma-implement-design`: Convert Figma design → code

---

## 4. Examples Tab

`ExamplesTab.tsx` — Gallery các design examples:
- Browse theo category: landing pages, dashboards, mobile apps, decks
- Preview example trong sandboxed iframe
- "Use this example" → tạo project mới từ example
- Search và filter examples

---

## 5. Prompt Templates

`PromptTemplatesTab.tsx` + `PromptTemplatePreviewModal.tsx`:
- **43 image prompt templates** (poster, avatar, infographic, v.v.)
- **39 Seedance video templates**
- **11 HyperFrames templates**
- Browse, preview, và apply template vào chat composer

---

## 6. Acceptance Criteria

**Import:**
- [x] Support Claude Design ZIP format
- [x] Project history được giữ nguyên
- [x] Files accessible trong File Workspace
- [x] Error message rõ ràng nếu ZIP invalid
- [x] GitHub Design System: parse DESIGN.md + validate schema

**Templates:**
- [x] Save project làm template
- [x] Templates list với search/filter
- [x] Preview template trước khi dùng
- [x] Create project từ template
- [x] Template capture file structure đầy đủ
