# F-03: Skills System

**Nhóm:** 🎨 Core — Skills  
**Nguồn code:** `apps/daemon/src/skills.ts`, `skills/` directory (139 skills)  
**API:** `GET /api/skills`, `GET /api/skills/:id`, `GET /api/skills/:id/example`

---

## 1. Tổng quan

Skills là các **workflow thiết kế** được định nghĩa dưới dạng file `SKILL.md` + `assets/` + `references/`. Mỗi skill định nghĩa một loại output cụ thể (landing page, dashboard, mobile app, deck, v.v.) kèm theo prompt template, template HTML mẫu, và tài liệu tham chiếu.

---

## 2. Cấu trúc Skill

```
skills/<skill-id>/
├── SKILL.md              ← Frontmatter od: + instructions
├── assets/
│   ├── template.html     ← Template artifact (auto-inject pre-flight)
│   └── ...
└── references/
    └── *.md              ← Reference docs (auto-inject pre-flight)
```

### Frontmatter `od:` schema

```yaml
od:
  mode: prototype | deck | image | video | audio | template | design-system | utility
  platform: desktop | mobile
  scenario: design | marketing | operation | engineering | product | finance | hr | sale | personal
  preview:
    type: html | deck | image | video | audio
  design_system:
    requires: boolean
  default_for: prototype | deck | ...
  featured: boolean
  fidelity: low | medium | high
  speaker_notes: boolean
  animations: boolean
  example_prompt: string
```

---

## 3. Catalog Modes

| Mode | Mô tả | Số lượng |
|------|-------|---------|
| `prototype` | Single-page HTML artifacts | ~32 skills |
| `deck` | Horizontal-swipe presentations | ~9 skills |
| `image` | Media generation — image workflow | — |
| `video` | Media generation — video workflow | — |
| `audio` | Media generation — audio workflow | — |
| `template` | Template files (non-interactive) | — |
| `design-system` | Design system builder workflow | — |
| `utility` | Post-export audit, catalog updaters | — |

---

## 4. Skills nổi bật

### 4.1 Prototype Mode — Desktop

| Skill ID | Scenario | Output |
|----------|---------|--------|
| `web-prototype` | design | Single-page HTML landing |
| `saas-landing` | marketing | Hero/features/pricing layout |
| `dashboard` | operation | Admin panel với data layout |
| `frontend-design` | design | Frontend prototype |
| `platform-design` | design | Platform-level UI |
| `login-flow` | design | Luồng đăng nhập đa bước |
| `faq-page` | design | Trang FAQ |
| `email-marketing` | marketing | HTML email template |
| `social-carousel` | marketing | 3-card 1080×1080 |
| `magazine-poster` | marketing | Editorial poster |
| `ad-creative` | marketing | Quảng cáo sáng tạo |
| `pm-spec` | product | PM specification document |
| `eng-runbook` | engineering | Incident runbook |
| `brainstorming` | product | Ideation board |
| `design-brief` | design | Design brief document |
| `data-report` | operation | Báo cáo dữ liệu |
| `finance-report` | finance | Exec finance summary |
| `resume-modern` | personal | CV hiện đại |
| `brand-guidelines` | design | Bộ nhận diện thương hiệu |

### 4.2 Prototype Mode — Mobile

| Skill ID | Scenario | Output |
|----------|---------|--------|
| `mobile-app` | design | iPhone 15 Pro / Pixel frames |
| `mobile-onboarding` | design | Multi-screen onboarding flow |
| `gamified-app` | personal | Gamified mobile prototype |
| `flutter-animating-apps` | engineering | Flutter app prototype |
| `swiftui-design` | design | SwiftUI design prototype |

### 4.3 Deck Mode

| Skill ID | Mô tả |
|---------|-------|
| `deck-guizang-editorial` | Magazine-style deck (default deck) |
| `deck-open-slide-canvas` | Canvas-based deck |
| `deck-swiss-international` | Swiss International style |
| `slides` | Minimal slides |
| `frontend-slides` | Frontend-focused slides |
| `nanobanana-ppt` | Compact PPT |
| `ppt-keynote` | Keynote-style presentation |
| `html-ppt-retro-quarterly-review` | Retro quarterly review |

### 4.4 Media Skills

| Skill ID | Mode | Mô tả |
|---------|------|-------|
| `imagegen` | image | GPT-Image-2 generation |
| `imagen` | image | Google Imagen |
| `fal-generate` | image | Fal.ai image generation |
| `fal-image-edit` | image | Fal.ai image editing |
| `fal-upscale` | image | Image upscaling |
| `fal-restore` | image | Image restoration |
| `fal-3d` | image | 3D rendering |
| `fal-tryon` | image | Virtual try-on |
| `video-hyperframes` | video | HTML→MP4 motion graphics |
| `sora` | video | OpenAI Sora video |
| `fal-kling-o3` | video | Kling video generation |
| `fal-video-edit` | video | Video editing |
| `remotion` | video | Programmatic video |
| `speech` | audio | Text-to-speech |
| `venice-audio-speech` | audio | Venice TTS |
| `venice-audio-music` | audio | Venice music generation |

### 4.5 Figma Integration Skills

| Skill ID | Mô tả |
|---------|-------|
| `figma-generate-design` | Tạo design trong Figma |
| `figma-implement-design` | Implement Figma design thành code |
| `figma-create-design-system-rules` | Tạo design system rules trong Figma |
| `figma-generate-library` | Tạo Figma component library |
| `figma-create-new-file` | Tạo file Figma mới |
| `figma-code-connect-components` | Code Connect cho Figma components |
| `figma-use` | Sử dụng Figma MCP tools |

### 4.6 Animation & Visual Skills (GSAP)

| Skill ID | Mô tả |
|---------|-------|
| `gsap-core` | GSAP animation cơ bản |
| `gsap-scrolltrigger` | Scroll-based animations |
| `gsap-timeline` | Timeline animations |
| `gsap-plugins` | GSAP plugins |
| `gsap-frameworks` | GSAP với React/Vue |
| `gsap-performance` | Performance optimization |
| `gsap-react` | GSAP + React integration |

### 4.7 AI Tools Skills (Fal.ai)

| Skill ID | Mô tả |
|---------|-------|
| `fal-realtime` | Realtime generation |
| `fal-lip-sync` | Lip sync video |
| `fal-vision` | Vision analysis |
| `fal-train` | Model fine-tuning |

### 4.8 HyperFrames / Motion Templates

| Skill ID | Mô tả |
|---------|-------|
| `frame-data-chart-nyt` | NYT-style data chart |
| `frame-flowchart-sticky` | Sticky note flowchart |
| `frame-glitch-title` | Glitch effect title |
| `frame-light-leak-cinema` | Cinematic light leak |
| `frame-liquid-bg-hero` | Liquid background hero |
| `frame-logo-outro` | Logo outro animation |
| `frame-macos-notification` | macOS notification animation |

### 4.9 Utility Skills

| Skill ID | Mô tả |
|---------|-------|
| `design-review` | Review và critique design |
| `competitive-ads-extractor` | Trích xuất quảng cáo cạnh tranh |
| `color-expert` | Tư vấn màu sắc |
| `enhance-prompt` | Cải thiện prompt |
| `creative-director` | Hướng dẫn creative direction |
| `copywriting` | Nội dung quảng cáo |
| `marketing-psychology` | Tâm lý marketing |
| `domain-name-brainstormer` | Đặt tên domain |
| `d3-visualization` | D3.js data visualization |
| `threejs` | Three.js 3D graphics |
| `shader-dev` | GLSL shader development |
| `hand-drawn-diagrams` | Sơ đồ vẽ tay |
| `algorithmic-art` | Nghệ thuật thuật toán |
| `screenshot` | Full-page screenshot |
| `full-page-screenshot` | Extended page capture |
| `kgs-knowledge` | KGS knowledge query |

### 4.10 Social Media Skills

| Skill ID | Mô tả |
|---------|-------|
| `card-twitter` | Twitter/X card |
| `card-xiaohongshu` | Xiaohongshu card |
| `social-x-post-card` | X post card |
| `social-reddit-card` | Reddit post card |
| `social-spotify-card` | Spotify share card |
| `gif-sticker-maker` | GIF sticker |
| `slack-gif-creator` | Slack GIF |

### 4.11 Document Skills

| Skill ID | Mô tả |
|---------|-------|
| `doc` | Document tổng quát |
| `doc-kami-parchment` | Document style cổ điển |
| `docx` | Word document |
| `pdf` | PDF document |
| `minimax-pdf` | PDF via Minimax |
| `minimax-docx` | DOCX via Minimax |

---

## 5. API

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/skills` | GET | Danh sách tất cả skills với summary |
| `/api/skills/:id` | GET | Chi tiết skill (full SKILL.md) |
| `/api/skills/:id/example` | GET | HTML preview artifact mẫu |

---

## 6. Thêm skill mới

1. Tạo folder `skills/<new-skill-id>/SKILL.md`
2. Định nghĩa frontmatter `od:` với mode, platform, scenario
3. Restart daemon (`pnpm tools-dev stop && pnpm tools-dev run web`)
4. Skill tự động xuất hiện trong catalog picker

---

## 7. Acceptance Criteria

- [x] Grid view với thumbnail preview
- [x] Filter theo mode, platform, scenario
- [x] Search theo tên skill
- [x] example.html render trong sandboxed iframe
- [x] Skill được inject context trước khi agent bắt đầu (pre-flight)
- [x] Template HTML từ `assets/template.html` tự động inject
- [x] Reference docs từ `references/*.md` tự động inject
