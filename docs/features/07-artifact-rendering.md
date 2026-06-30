# F-08: Artifact Rendering & Preview

**Nhóm:** 🖼️ Core — Artifact  
**Nguồn code:** `apps/web/src/artifacts/parser.ts`, `apps/web/src/components/FileViewer.tsx` (311KB)  
**UI:** `FileWorkspace.tsx` (95KB), `PreviewModal.tsx`, `PreviewDrawOverlay.tsx`, `ManualEditPanel.tsx`

---

## 1. Tổng quan

Mỗi artifact được agent emit dưới dạng XML tag `<artifact>`, hệ thống parse và render trong **sandboxed srcdoc iframe**. User có thể interact, comment, và edit trực tiếp.

---

## 2. Artifact Format

```xml
<artifact identifier="unique-id" type="text/html" title="My Landing Page">
<!DOCTYPE html>
<html>
  ...full HTML document...
</html>
</artifact>
```

---

## 3. Sandboxed Iframe Rendering

```html
<iframe
  srcdoc="...artifact HTML..."
  sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
  loading="lazy"
/>
```

**Đặc điểm:**
- Độc lập hoàn toàn với trang chính (no script leak)
- User có thể interact: click, scroll, hover, animations hoạt động
- Resize preview panel
- Render trong vòng **< 2 giây** sau khi agent hoàn thành

---

## 4. Artifact Parser

`parser.ts` xử lý:
- Tách `<artifact>` XML blocks từ streaming text
- Parse real-time khi agent đang stream
- Multiple artifacts trong một turn
- Fallback khi tag không hoàn chỉnh (partial stream)

---

## 5. Normal Artifact vs Live Artifact

| | Normal Artifact | Live Artifact |
|--|----------------|--------------|
| **Storage** | File trên disk (`index.html`) | Record trong SQLite + source data |
| **Refresh** | Re-chat với agent | Click "Refresh" button |
| **Use case** | Design output tĩnh | Dashboard, data-driven views |
| **Preview** | srcdoc iframe | srcdoc iframe + refresh state |

---

## 6. File Workspace

`FileWorkspace.tsx` cung cấp:

### 6.1 File Browser
- Sidebar liệt kê tất cả files trong project
- Icons theo file type (HTML, CSS, JS, MD, image, v.v.)
- Sort theo tên hoặc update time

### 6.2 Code Editor
- Syntax highlighting cho HTML, CSS, JS, Markdown, JSON
- **Auto-save** sau 2 giây không có thay đổi
- **Diff view** khi agent tạo version mới
- Line numbers, code folding

### 6.3 Preview Sync
- Preview cập nhật khi file được save
- Iframe reload tự động

### 6.4 Render Modes

`file-viewer-render-mode.ts` xác định cách render mỗi file:
- `html` → srcdoc iframe
- `deck` → horizontal swipe deck player
- `image` → image viewer
- `video` → video player
- `audio` → audio player
- `markdown` → rendered Markdown
- `code` → syntax highlighted code view

---

## 7. Preview Comments & Annotations

`PreviewDrawOverlay.tsx` cho phép user comment trực tiếp trên preview:

```typescript
interface PreviewComment {
  id: string;
  projectId: string;
  conversationId: string;
  filePath: string;
  elementId: string;
  selector: string;         // CSS selector
  label: string;
  text: string;
  positionJson: object;     // {x, y, width, height}
  htmlHint: string;
  styleJson?: object;
  note: string;
  status: 'open' | 'resolved';
  selectionKind: 'element' | 'visual' | 'pod';
  memberCount?: number;
  podMembersJson?: object[];
  createdAt: number;
  updatedAt: number;
}
```

**Cơ chế:**
- **Click mode** vs **Interact mode** phân biệt rõ ràng
- Click vào element → popup để nhập comment
- Comment lưu với element selector và position
- Comment inject vào conversation context cho turn tiếp theo
- Status: `open` → `resolved` sau khi agent fix

---

## 8. Manual Edit Panel

`ManualEditPanel.tsx` cho phép edit HTML/CSS/JS trực tiếp:
- Split view: editor bên trái, preview bên phải
- Thay đổi reflect ngay trong preview
- Save ghi file xuống disk

---

## 9. Sketch Editor

`SketchEditor.tsx` + `SketchPreview.tsx`:
- Vẽ tay sketches đơn giản
- Convert sketch → design prompt cho agent
- Preview sketch trong real-time

---

## 10. Download Chips

Sau khi artifact được tạo, user thấy download chips:
- 📥 **HTML** — Inline assets, offline-capable
- 📄 **PDF** — Browser print
- 📦 **ZIP** — Toàn bộ project
- 📝 **Markdown** — Transcript

---

## 11. Full-Screen Theater Mode

`Theater/` component:
- Xem artifact ở full-screen
- Presentation mode cho deck artifacts

---

## 12. Deck Navigation

Khi artifact là deck (`kind: "deck"`):
- Horizontal swipe navigation
- Keyboard arrows left/right
- Slide counter (e.g., "3/10")
- Print mode cho PDF export
- Scroll mode cho single-page view

---

## 13. Acceptance Criteria

- [x] Artifact render trong vòng 2 giây sau khi agent hoàn thành
- [x] Iframe có sandbox attributes đúng
- [x] Scroll, hover, animation trong iframe hoạt động
- [x] Click mode phân biệt với interact mode
- [x] Comment lưu vào database với element_id, selector, position
- [x] Comment context inject vào conversation khi cần
- [x] Status comment: open / resolved
- [x] Auto-save sau 2 giây
- [x] Preview sync với file đang edit
- [x] Diff view khi agent tạo version mới
