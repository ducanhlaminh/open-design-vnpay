# F-13: Media Generation

**Nhóm:** 🎬 Media  
**Nguồn code:** `apps/daemon/src/media.ts` (105KB), `apps/daemon/src/media-routes.ts`  
**UI:** `apps/web/src/media/`, `HomeHero.tsx`  
**Config:** `.od/media-config.json`

---

## 1. Tổng quan

Hỗ trợ tạo media (image, video, audio) từ prompt hoặc source text. Media tasks được track async trong SQLite và kết quả lưu vào project folder.

---

## 2. Image Generation (F-07)

### 2.1 Providers

| Provider | Endpoint | Mô tả |
|---------|---------|-------|
| **GPT-Image-2** | Azure / OpenAI | Poster, avatar, infographic, illustrated map |
| **Custom Image API** | OpenAI-compatible | Bất kỳ endpoint tương thích |
| **ImageRouter** | OpenAI-compatible | Route to multiple backends |
| **Fal.ai** | fal.ai | `fal-generate`, `fal-image-edit`, `fal-upscale`, `fal-restore`, `fal-3d`, `fal-tryon` |
| **Google Imagen** | Google AI | `imagen` skill |
| **Venice** | Venice.ai | `venice-image-generate`, `venice-image-edit` |
| **Pixelbin** | Pixelbin.io | `pixelbin-media` skill |
| **Replicate** | Replicate.com | `replicate` skill |

### 2.2 API

```http
POST /api/media/image
Body: {
  prompt: string,
  model: string,     // 'gpt-image-2', ...
  aspect: '1:1' | '16:9' | '4:3' | '9:16' | ...
}
→ { taskId, status: 'pending' | 'ready' | 'failed', imageUrl? }
```

### 2.3 Prompt Templates

- **43 prompt templates** sẵn có (trong `prompt-templates/`)
- Phân loại: poster, avatar, infographic, map, product, background, v.v.
- Preview modal để xem template trước khi dùng (`PromptTemplatesTab.tsx`)

### 2.4 Tính năng

- Image lưu vào project folder
- Aspect ratio tùy chỉnh (1:1, 16:9, 4:3, 9:16, ...)
- Image generation < **30 giây**
- Hỗ trợ image edit (Fal.ai: `fal-image-edit`)
- Image upscaling (`fal-upscale`)
- 3D rendering (`fal-3d`)
- Virtual try-on (`fal-tryon`)
- Realtime generation (`fal-realtime`)

---

## 3. Video Generation (F-08)

### 3.1 Providers

| Provider | Skill | Mô tả |
|---------|-------|-------|
| **Seedance 2.0** (ByteDance) | — | Text-to-video và image-to-video, 15s cinematic |
| **HyperFrames** (HeyGen) | `video-hyperframes` | HTML→MP4 motion graphics |
| **Sora** (OpenAI) | `sora` | OpenAI Sora |
| **Kling** (Fal.ai) | `fal-kling-o3` | Kling video model |
| **Venice Video** | `venice-video` | Venice video generation |
| **Fal Video Edit** | `fal-video-edit` | Video editing |
| **Remotion** | `remotion` | Programmatic React video |
| **8-bit Orbit** | `8-bit-orbit-video-template` | Retro 8-bit video template |
| **Stitch Loop** | `stitch-loop` | Loop video effect |

### 3.2 API

```http
POST /api/media/video
Body: {
  prompt: string,
  model: string,   // 'seedance-2.0', 'hyperframes-html'
  duration: number,
  aspect: string
}
→ { taskId, status: 'pending' | 'processing' | 'ready' | 'failed' }
```

### 3.3 Prompt Templates

- **39 Seedance** prompt templates
- **11 HyperFrames** prompt templates

### 3.4 HyperFrames đặc biệt

- Input: HTML artifact (animation-ready)
- Output: MP4 video
- Flow: HTML → HeyGen render → MP4
- `videoModel: "hyperframes-html"` trong project metadata
- Có entry point riêng trong Home Chip Rail ("Motion")

### 3.5 Tính năng

- Async polling với status updates
- Video `.mp4` lưu vào project folder
- Video preview inline
- Download `.mp4` file

---

## 4. Audio Generation (F-09)

### 4.1 Providers

| Provider | Skill | Mô tả |
|---------|-------|-------|
| **ElevenLabs** | `speech` | Text-to-speech, sound effects |
| **Venice Audio Speech** | `venice-audio-speech` | Venice TTS |
| **Venice Audio Music** | `venice-audio-music` | Music generation |
| **SenseAudio** | BYOK proxy | Audio via SenseAudio API |

### 4.2 API

```http
POST /api/media/audio
Body: {
  text: string,              // Cho speech
  prompt?: string,           // Cho sound effects
  kind: 'speech' | 'sound_effects',
  voiceId?: string
}
→ { taskId, status, audioUrl? }
```

**Voice list:**
```http
GET /api/elevenlabs/voices
→ Voice[]
```

### 4.3 Audio Source Field (Essential Audio Generation)

| Kind | Source Field | Mô tả |
|------|------------|-------|
| **Speech** | Text input | Nội dung được đọc thành tiếng |
| **Sound Effects** | Prompt input | Mô tả âm thanh cần tổng hợp |

### 4.4 ElevenLabs Fallback Voice

- Khi không load được voices từ API → dùng default voice ID
- Giữ ElevenLabs speech runnable mà không cần setup thêm
- User thấy "Default Voice" thay vì empty selector

### 4.5 Tính năng

- Voice list load từ ElevenLabs API
- Audio preview inline trong app
- Download `.mp3` file

---

## 5. Media Task Tracking

```typescript
interface MediaTask {
  id: string;
  projectId: string;
  kind: 'image' | 'video' | 'audio';
  status: 'pending' | 'processing' | 'ready' | 'failed';
  prompt: string;
  model: string;
  providerId: string;
  resultUrl?: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}
```

- Tasks persist trong SQLite
- `reconcileMediaTasksOnBoot()` — recover stale tasks khi daemon restart
- Progress indicator cho async tasks

---

## 6. Media Config

`.od/media-config.json` (gitignored):
```json
{
  "providers": {
    "openai": { "apiKey": "...", "baseUrl": "..." },
    "azure": { "apiKey": "...", "endpoint": "..." },
    "elevenlabs": { "apiKey": "..." },
    "bytedance": { "apiKey": "..." }
  }
}
```

---

## 7. Acceptance Criteria

**Image:**
- [x] Image generation < 30 giây
- [x] Image lưu vào project folder
- [x] Aspect ratio tuỳ chỉnh (1:1, 16:9, 4:3)
- [x] Hỗ trợ GPT-Image-2 (Azure/OpenAI)
- [x] 43 prompt templates sẵn có

**Video:**
- [x] Status polling với progress indicator
- [x] Video preview inline
- [x] Download .mp4 file
- [x] HyperFrames HTML→MP4 workflow

**Audio:**
- [x] Voice list load từ ElevenLabs API
- [x] ElevenLabs Fallback Voice khi API lỗi
- [x] Audio preview inline
- [x] Download .mp3
