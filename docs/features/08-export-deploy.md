# F-09 & F-10 & F-11: Export, Deploy & Import

**Nhóm:** 📤 Export & Deploy  
**Nguồn code:**
- `apps/daemon/src/import-export-routes.ts`
- `apps/daemon/src/inline-assets.ts`
- `apps/daemon/src/deploy.ts` (74KB)
- `apps/daemon/src/deploy-routes.ts`
- `apps/daemon/src/claude-design-import.ts`

---

## 1. Export (F-09)

Hỗ trợ 5 định dạng export từ project artifact:

| Format | Endpoint | Mô tả |
|--------|---------|-------|
| **HTML** | `GET /api/projects/:id/files/:name/export/html` | Inline assets, offline-capable |
| **PDF** | `GET /api/projects/:id/files/:name/export/pdf` | Browser print, deck-aware |
| **PPTX** | Agent-driven via skill | File .pptx trong project folder |
| **ZIP** | `GET /api/projects/:id/archive` | Toàn bộ project |
| **Markdown** | `GET /api/projects/:id/transcript` | Conversation transcript |

### 1.1 HTML Export

- **CSS, JS, images inline** (base64 hoặc `<style>`)
- File < **5MB** cho artifact thông thường
- Hoạt động **offline** trên Chrome, Firefox, Safari
- Không cần server để mở

### 1.2 PDF Export

- Browser print API
- **Deck mode:** mỗi slide = một trang PDF
- Text selectable trong PDF
- Page breaks hợp lý
- Layout match với preview

### 1.3 PPTX Export

- Agent-driven qua skill (ví dụ: `pptx-generator`, `ppt-keynote`)
- File `.pptx` được tạo trong project folder
- Xuất hiện như download chip trong workspace
- Compatible với PowerPoint 2019+, Keynote

### 1.4 ZIP Export

- Archiver toàn bộ project folder
- Include: HTML, CSS, JS, images, markdown files
- `GET /api/projects/:id/archive` → `.zip` file download

### 1.5 Markdown Export

- Transcript toàn bộ conversation
- Bao gồm: prompt, response, file operations
- Format Markdown chuẩn, readable

---

## 2. Deploy (F-10)

Deploy artifact lên hosting provider và trả về public URL.

### 2.1 Vercel Deploy

```http
POST /api/projects/:id/deployments/vercel
Body: { fileName, token, teamId?, projectName? }
→ { url, status: 'pending' | 'ready' | 'failed' }
```

**Flow:**
1. Build file set (inline assets)
2. POST to Vercel API
3. Poll deployment status
4. Return stable URL

**SLA:** Deploy < **60 giây** với artifact < 1MB

### 2.2 Cloudflare Pages Deploy

```http
POST /api/projects/:id/deployments/cloudflare
Body: { fileName, accountId, token, projectName }
→ { url, deploymentId, status }
```

**Đặc điểm:**
- `POST /api/cloudflare/zones` — List CF zones
- `aggregateCloudflarePagesStatus()` — Normalize CF status

### 2.3 Deployment Tracking

```typescript
interface Deployment {
  id: string;
  projectId: string;
  fileName: string;
  providerId: 'vercel' | 'cloudflare';
  url: string;
  deploymentId?: string;
  deploymentCount: number;
  target: 'preview';
  status: 'ready' | 'pending' | 'failed';
  statusMessage?: string;
  reachableAt?: number;
  createdAt: number;
  updatedAt: number;
}
```

**API:**
| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/projects/:id/deployments/vercel` | POST | Deploy lên Vercel |
| `/api/projects/:id/deployments/cloudflare` | POST | Deploy lên Cloudflare |
| `/api/projects/:id/deployments` | GET | Danh sách deployments |
| `/api/cloudflare/zones` | GET | List CF zones |

---

## 3. Import (F-11)

### 3.1 Import Claude Design ZIP

```http
POST /api/import/claude-design
Content-Type: multipart/form-data
Body: { zip: File }
→ { projectId, name }
```

- Parse ZIP format của Claude Design (Anthropic)
- Tạo real project với history đầy đủ
- Files accessible trong File Workspace
- Error message rõ ràng nếu ZIP invalid
- Hỗ trợ drag & drop vào welcome dialog

### 3.2 GitHub Design System Import

```http
POST /api/design-systems/import/github
Body: { repoUrl: string }
```

- Parse repo URL, clone DESIGN.md
- Extract metadata (name, colors, typography)
- Add vào user's design systems library

---

## 4. Inline Assets Processing

`inline-assets.ts` xử lý:
- External CSS → `<style>` inline
- External JS → `<script>` inline
- Images → base64 data URI
- Google Fonts → bundle hoặc fallback system font
- Font files → base64 embedded

---

## 5. Use Cases

### UC: Deploy landing page cho marketing review
```
1. Designer tạo landing page artifact
2. Click "Deploy → Vercel"
3. Nhập Vercel API token
4. Status: pending → building → ready
5. URL trả về: https://my-landing.vercel.app
6. Share URL với team
```

### UC: Chia sẻ deck cho management
```
1. Tạo seed round pitch deck
2. Export → PDF
3. File PDF 10 trang với slide boundaries
4. Attach vào email
```

---

## 6. Acceptance Criteria

**Export:**
- [x] HTML export < 5MB cho artifact thông thường
- [x] CSS, JS, images inline (offline-capable)
- [x] PDF: deck mode mỗi slide = một trang
- [x] Text selectable trong PDF
- [x] PPTX mở được trong PowerPoint 2019+
- [x] ZIP bao gồm toàn bộ project files

**Deploy:**
- [x] Deploy < 60 giây với artifact < 1MB
- [x] URL stable sau re-deploy
- [x] Status tracking: pending / ready / failed
- [x] Cloudflare Pages deploy tương tự Vercel

**Import:**
- [x] Support Claude Design ZIP format
- [x] Project history được giữ nguyên
- [x] Files accessible trong File Workspace
- [x] Error message rõ ràng nếu ZIP invalid
