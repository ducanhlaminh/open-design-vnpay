# F-04: Design Systems Library

**Nhóm:** 🎭 Core — Design Systems  
**Nguồn code:** `apps/daemon/src/design-systems.ts`, `design-systems/` directory (151 entries)  
**UI:** `DesignSystemsTab.tsx`, `DesignSystemFlow.tsx`, `DesignSystemsSection.tsx`  
**API:** `GET /api/design-systems`, `GET /api/design-systems/:id`

---

## 1. Tổng quan

Design Systems Library cung cấp 150+ design systems được định nghĩa theo schema **9-section DESIGN.md portable Markdown**. Không phải JSON theme — mỗi system là một tài liệu Markdown có thể đọc, fork, và mở rộng.

---

## 2. Schema DESIGN.md (9 sections)

```markdown
## 1. Color System
## 2. Typography
## 3. Spacing & Layout
## 4. Component Library
## 5. Motion & Animation
## 6. Voice & Tone
## 7. Brand Assets
## 8. Anti-patterns
## 9. Iconography
```

---

## 3. Danh sách Design Systems (150+)

### 3.1 Tech & SaaS

| Brand | Đặc điểm |
|-------|---------|
| Linear | Dark, purple accent, sharp typography |
| Stripe | Blue, clean, financial clarity |
| Vercel | Black & white, minimal |
| Supabase | Green, dark mode, developer-first |
| Figma | Colorful, creative tooling |
| GitHub | Octopus, developer ecosystem |
| Notion | Minimal, document-centric |
| Sentry | Error monitoring aesthetic |
| PostHog | Open source analytics |
| Raycast | macOS native, productivity |
| Webflow | No-code visual builder |
| Sanity | Structured content |
| Framer | Motion-first |

### 3.2 AI & ML Companies

| Brand | Đặc điểm |
|-------|---------|
| Anthropic | Claude's brand, careful & thoughtful |
| OpenAI | Clean, research-forward |
| Cursor | IDE-inspired, developer tools |
| Mistral AI | European AI, elegant |
| Perplexity | Search-forward |
| ElevenLabs | Audio-first |

### 3.3 Finance & Crypto

| Brand | Đặc điểm |
|-------|---------|
| Revolut | Dark, modern fintech |
| Coinbase | Crypto blue, trustworthy |
| Stripe | Financial clarity |

### 3.4 Consumer

| Brand | Đặc điểm |
|-------|---------|
| Apple | Cupertino design language |
| Spotify | Music, dark green |
| Airbnb | Warm, rausch red |
| Discord | Gaming community |
| Slack | Collaboration, purple |

### 3.5 E-commerce & Platform

| Brand | Đặc điểm |
|-------|---------|
| Shopify | Commerce, Polaris DS |
| Tesla | Automotive, premium |
| MongoDB | Developer database |

### 3.6 VNPay Custom (Phase 2)

| Brand | Đặc điểm |
|-------|---------|
| VNPay | Vietnamese fintech brand (đang phát triển) |

---

## 4. Tính năng chính

### 4.1 Browse & Preview

- **Grid view** với color swatches (4 màu signature mỗi system)
- **Detail modal**: DESIGN.md đầy đủ + swatch grid
- **Live showcase**: Render artifact theo đúng system đó

### 4.2 Switch Design System

- Switch system trong project → lần render tiếp dùng token mới
- Không xóa project history khi switch
- Artifact mới dùng đúng color, font, spacing của system mới

### 4.3 Create Custom Design System

```markdown
1. Settings → Design Systems → Create New
2. Nhập tên + định nghĩa theo schema 9-section DESIGN.md
3. Upload brand assets (logo, fonts)
4. Preview màu sắc real-time
5. Lưu vào user library
```

### 4.4 Import từ GitHub

```http
POST /api/design-systems/import/github
Body: { repoUrl: string }
```

- Parse repo URL, clone DESIGN.md, extract metadata
- Validate theo schema 9 sections

---

## 5. API

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/design-systems` | GET | Danh sách tất cả design systems |
| `/api/design-systems/:id` | GET | Chi tiết (DESIGN.md + files) |
| `/api/design-systems/:id/preview` | GET | Preview HTML showcase |
| `/api/design-systems/:id/showcase` | GET | Showcase artifact |
| `/api/design-systems` | POST | Tạo custom design system |
| `/api/design-systems/:id` | PUT | Update design system |
| `/api/design-systems/:id` | DELETE | Xóa design system |
| `/api/design-systems/import/github` | POST | Import từ GitHub repo |

---

## 6. Integration với Prompt Stack

DESIGN.md của system được chọn được inject vào prompt stack theo thứ tự:

```
1. DISCOVERY directives
2. identity charter
3. → active DESIGN.md  ← ĐÂY
4. active SKILL.md
5. project metadata
```

---

## 7. Acceptance Criteria

- [x] Hiển thị 150+ systems với color swatches
- [x] Xem DESIGN.md đầy đủ
- [x] Swatch grid cho color palette
- [x] Live showcase render đúng system đó
- [x] Switch design system không xóa project history
- [x] Tạo custom design system theo schema 9-section
- [x] Import từ GitHub repository
- [x] Validate schema (9 sections bắt buộc)
