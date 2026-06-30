# 09 — Prompt Template Models

**Nguồn:** `prompt-templates/image/*.json`, `prompt-templates/video/*.json`

Prompt templates là các JSON files định nghĩa prompt mẫu cho image và video generation. Chúng xuất hiện trong Settings → Image/Video tabs và Home Chip Rail.

---

## Image Prompt Template

**Thư mục:** `prompt-templates/image/`  
**Số lượng:** 46 files

### Schema

```json
{
  "id": "profile-avatar-anime-girl-to-cinematic-photo",
  "surface": "image",
  "title": "Profile / Avatar - Anime Girl to Cinematic Photo",
  "summary": "Mô tả ngắn về template này làm gì.",
  "category": "Profile / Avatar",
  "tags": ["anime", "cinematic", "fantasy"],
  "model": "gpt-image-2",
  "aspect": "1:1",
  "prompt": "Full prompt text...",
  "previewImageUrl": "https://cms-assets.youmind.com/...",
  "source": {
    "repo": "YouMind-OpenLab/awesome-gpt-image-2",
    "license": "CC-BY-4.0",
    "author": "maku",
    "url": "https://x.com/..."
  }
}
```

### TypeScript Interface

```typescript
interface PromptTemplate {
  id: string;
  surface: 'image' | 'video';
  title: string;
  summary?: string;
  category?: string;
  tags?: string[];
  model?: string;               // e.g. 'gpt-image-2', 'seedance-2.0'
  aspect?: MediaAspect;         // '1:1' | '16:9' | '9:16' | '4:3' | '3:4'
  prompt: string;               // Full prompt body
  previewImageUrl?: string;
  source?: PromptTemplateSource;
}

interface PromptTemplateSource {
  repo: string;
  license: string;
  author?: string;
  url?: string;
}
```

---

## Image Template Categories

| Category | Số lượng | Ví dụ |
|---------|---------|-------|
| Profile / Avatar | ~20 | cinematic portrait, fantasy, hanfu, anime |
| Social Media Post | ~8 | editorial fashion, storyboard, vintage |
| Game Screenshot | ~4 | anime fighting, three kingdoms |
| Game UI | ~1 | ancient china MMO HUD |
| Infographic | ~3 | 3D staircase, otaku dance breakdown |
| Illustrated Map | ~1 | illustrated city food map |
| Illustration | ~1 | crayon kid drawing |
| E-commerce | ~1 | live stream UI mockup |
| VR/Tech | ~1 | VR headset exploded view |
| Live Artifact | ~1 | Notion team dashboard |

---

## Video Prompt Template

**Thư mục:** `prompt-templates/video/`  
**Số lượng:** 57 files (39 Seedance + 18 HyperFrames)

### Schema (ví dụ)

```json
{
  "id": "cinematic-street-racing-sequence-for-seedance-2",
  "surface": "video",
  "title": "Cinematic Street Racing - Seedance 2.0",
  "summary": "High-speed chase sequence",
  "category": "Cinematic",
  "tags": ["racing", "cinematic", "seedance-2"],
  "model": "seedance-2.0",
  "aspect": "16:9",
  "prompt": "...",
  "previewImageUrl": "...",
  "source": { ... }
}
```

---

## Video Template Categories

### Seedance Video Templates (39 files)

| Category | Ví dụ |
|---------|-------|
| Cinematic | Street racing, marine biologist, dragon flight |
| Character | Anime martial arts, three kingdoms |
| Motion Graphics | Character intro sequence |
| Cultural | K-pop dance, traditional dance |
| Fantasy | Ancient guardian dragon, vampire alley fight |
| Gaming | Cyberpunk trailer, forbidden city cat |
| Short Film | Japanese romance 30s, 80-year-old rapper MV |
| Lifestyle | Rural aesthetics healing, beat-synced outfit |
| Other | Hunched character, toaster rocket jumpscare |

### HyperFrames Templates (18 files)

HyperFrames = HTML → MP4 conversion via HeyGen.

| Template | Mô tả |
|---------|-------|
| `hyperframes-app-showcase-three-phones` | 3-phone mockup showcase |
| `hyperframes-brand-sizzle-reel` | Brand intro video |
| `hyperframes-data-bar-chart-race` | Animated bar chart race |
| `hyperframes-flight-map-route` | Animated flight route map |
| `hyperframes-html-in-canvas-iphone-device` | iPhone device frame |
| `hyperframes-html-in-canvas-liquid-background` | Liquid bg effect |
| `hyperframes-html-in-canvas-liquid-glass` | Liquid glass effect |
| `hyperframes-html-in-canvas-magnetic` | Magnetic particle effect |
| `hyperframes-html-in-canvas-portal-reveal` | Portal reveal |
| `hyperframes-html-in-canvas-shatter` | Shatter effect |
| `hyperframes-html-in-canvas-text-cursor` | Typing cursor animation |
| `hyperframes-logo-outro-cinematic` | Logo outro |
| `hyperframes-money-counter-hype` | Money counter animation |
| `hyperframes-product-reveal-minimal` | Product minimal reveal |
| `hyperframes-saas-product-promo-30s` | 30s SaaS promo |
| `hyperframes-social-overlay-stack` | Social media overlay |
| `hyperframes-tiktok-karaoke-talking-head` | TikTok karaoke |
| `hyperframes-website-to-video-promo` | Website-to-video |

---

## PromptTemplateMetadata (on Project)

Subset lưu trên project khi user chọn template lúc tạo project:

```typescript
// packages/contracts/src/api/projects.ts
interface PromptTemplateMetadata {
  id: string;
  surface: 'image' | 'video';
  title: string;
  prompt: string;           // User có thể edit trước khi create
  summary?: string;
  category?: string;
  tags?: string[];
  model?: string;
  aspect?: MediaAspect;
  source?: PromptTemplateMetadataSource;
}

interface PromptTemplateMetadataSource {
  repo: string;
  license: string;
  author?: string;
  url?: string;
}
```

Khi user chọn template và edit prompt trước khi tạo project → `prompt` field trong `ProjectMetadata.promptTemplate` chứa prompt đã được user chỉnh sửa (authoritative).

---

## Supported Models

### Image Generation Models

| Model | Provider | Notes |
|-------|---------|-------|
| `gpt-image-2` | OpenAI / Azure | Chủ yếu dùng trong image templates |
| Custom BYOK | OpenAI-compatible | Settings → Media providers |

### Video Generation Models

| Model | Provider | Notes |
|-------|---------|-------|
| `seedance-2.0` | ByteDance | 15s cinematic |
| `hyperframes-html` | HeyGen | HTML→MP4 |
| `sora` | OpenAI | — |
| `kling` | Fal.ai | — |
| `venice-video` | Venice | — |

---

## Aspect Ratios

```typescript
type MediaAspect = '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
```

| Aspect | Use case |
|--------|---------|
| `1:1` | Avatar, square social post |
| `16:9` | Landscape video, desktop hero |
| `9:16` | Mobile/TikTok vertical |
| `4:3` | Traditional photo/presentation |
| `3:4` | Portrait photo |
