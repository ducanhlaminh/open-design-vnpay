# F-13: Media Generation — Business Logic

## Overview

Media Generation covers image, video, and audio creation from text prompts. Tasks are tracked asynchronously in SQLite, and results (image/video/audio files) are saved into the project folder. On daemon restart, stale tasks are reconciled (`reconcileMediaTasksOnBoot`).

---

## Business Rules

### General

| Rule | Detail |
|------|--------|
| **BR-01** | All media tasks are tracked in SQLite with `status: pending → processing → ready | failed` |
| **BR-02** | Media files are saved directly into the project folder |
| **BR-03** | `reconcileMediaTasksOnBoot()` recovers stale in-progress tasks on daemon restart |
| **BR-04** | API keys for each provider are stored in `.od/media-config.json` (gitignored) |
| **BR-05** | Progress indicator shown for all async tasks |

### Image Generation (F-07)

| Rule | Detail |
|------|--------|
| **BR-06** | Supported providers: GPT-Image-2, Custom Image API (OpenAI-compatible), ImageRouter, Fal.ai, Google Imagen, Venice, Pixelbin, Replicate |
| **BR-07** | Image generation SLA: < 30 seconds |
| **BR-08** | Images are saved to project folder |
| **BR-09** | Aspect ratio is selectable: `1:1`, `16:9`, `4:3`, `9:16`, `3:4` |
| **BR-10** | 43 image prompt templates are available |
| **BR-11** | Fal.ai supports extended operations: image edit, upscaling, restoration, 3D rendering, virtual try-on, realtime generation |

### Video Generation (F-08)

| Rule | Detail |
|------|--------|
| **BR-12** | Supported providers: Seedance 2.0 (ByteDance), HyperFrames (HeyGen), Sora, Kling (Fal.ai), Venice Video, Fal Video Edit, Remotion, 8-bit Orbit, Stitch Loop |
| **BR-13** | Video is saved as `.mp4` in the project folder |
| **BR-14** | Status polling with progress indicator |
| **BR-15** | 39 Seedance prompt templates and 11 HyperFrames templates available |
| **BR-16** | HyperFrames: HTML artifact → HeyGen render → `.mp4` |
| **BR-17** | HyperFrames has dedicated Home Chip Rail entry ("Motion") |

### Audio Generation (F-09)

| Rule | Detail |
|------|--------|
| **BR-18** | Supported providers: ElevenLabs (TTS + SFX), Venice Audio Speech, Venice Audio Music, SenseAudio (via BYOK proxy) |
| **BR-19** | Two audio kinds: `speech` (text-to-speech) and `sound_effects` (prompt → audio) |
| **BR-20** | Voice list loaded from ElevenLabs API; fallback to default voice if API fails |
| **BR-21** | Audio saved as `.mp3` in project folder |
| **BR-22** | Audio preview inline in the app |

---

## Supported Providers Summary

### Image
| Provider | Skills |
|---------|--------|
| GPT-Image-2 | `imagegen` |
| Google Imagen | `imagen` |
| Fal.ai | `fal-generate`, `fal-image-edit`, `fal-upscale`, `fal-restore`, `fal-3d`, `fal-tryon`, `fal-realtime` |
| Venice | `venice-image-generate`, `venice-image-edit` |
| Pixelbin | `pixelbin-media` |
| Replicate | `replicate` |

### Video
| Provider | Skills |
|---------|--------|
| Seedance 2.0 (ByteDance) | direct |
| HyperFrames (HeyGen) | `video-hyperframes` |
| Sora (OpenAI) | `sora` |
| Kling (Fal.ai) | `fal-kling-o3` |
| Venice | `venice-video` |
| Fal Video Edit | `fal-video-edit` |
| Remotion | `remotion` |

### Audio
| Provider | Skills |
|---------|--------|
| ElevenLabs | `speech` |
| Venice | `venice-audio-speech`, `venice-audio-music` |
| SenseAudio | BYOK proxy |

---

## Media Task Data Model

```typescript
type MediaTaskKind = 'image' | 'video' | 'audio';
type MediaTaskStatus = 'pending' | 'processing' | 'ready' | 'failed';

interface MediaTask {
  id: string;
  projectId: string;
  kind: MediaTaskKind;
  status: MediaTaskStatus;
  prompt: string;
  model: string;
  providerId: string;
  resultUrl?: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}
```

---

## Media Config

```json
.od/media-config.json
{
  "providers": {
    "openai": { "apiKey": "…", "baseUrl": "…" },
    "azure": { "apiKey": "…", "endpoint": "…" },
    "elevenlabs": { "apiKey": "…" },
    "bytedance": { "apiKey": "…" },
    "fal": { "apiKey": "…" },
    "venice": { "apiKey": "…" }
  }
}
```

---

## Acceptance Criteria

**Image:**
- [ ] Image generation < 30 seconds
- [ ] Image saved to project folder
- [ ] Aspect ratio customizable (1:1, 16:9, 4:3, 9:16)
- [ ] GPT-Image-2 (Azure/OpenAI) supported
- [ ] 43 prompt templates available

**Video:**
- [ ] Status polling with progress indicator
- [ ] Video preview inline
- [ ] Download `.mp4` file
- [ ] HyperFrames HTML → MP4 workflow

**Audio:**
- [ ] Voice list loaded from ElevenLabs API
- [ ] ElevenLabs fallback voice when API unavailable
- [ ] Audio preview inline
- [ ] Download `.mp3`
