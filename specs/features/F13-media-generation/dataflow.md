# F-13: Media Generation — Data Flow

## Image Generation Flow

```
User: Home → Image tab (or "Image" chip)
    │
    ├── Select prompt template (optional, 43 available)
    ├── Write/edit prompt
    ├── Select model (GPT-Image-2, Fal.ai, Imagen, …)
    └── Select aspect ratio (1:1, 16:9, 4:3, 9:16, …)
    │
    ▼
POST /api/media/image
    Body: {
      prompt: "Minimalist tech startup poster…",
      model: "gpt-image-2",
      aspect: "16:9",
      projectId: "…"
    }
    │
    ▼
Daemon:
    ├── CREATE media task in SQLite: { status: 'pending', kind: 'image' }
    ├── Resolve provider credentials from media-config.json
    ├── Call provider API (async):
    │   ├── GPT-Image-2 → OpenAI/Azure images.generate
    │   ├── Fal.ai → fal.run('fal-ai/flux', { prompt })
    │   └── Imagen → Google AI API
    ├── On result:
    │   ├── Download image binary
    │   ├── Save to .od/projects/<id>/<timestamp>.png
    │   └── UPDATE task: { status: 'ready', resultUrl: '/files/…' }
    └── On failure:
        └── UPDATE task: { status: 'failed', errorMessage: '…' }
    │
    ▼
→ { taskId, status: 'pending' }
    │
    ▼
UI: Poll GET /api/media/tasks/:taskId
    ├── status = 'pending'/'processing' → show spinner
    └── status = 'ready' → display image in project
```

## Video Generation Flow

```
User: Home → Video tab (or "Video" chip)
    │
    ├── Select model (Seedance, HyperFrames, Sora, Kling, …)
    ├── Select prompt template (39 Seedance / 11 HyperFrames)
    ├── Write prompt
    └── Configure: duration, aspect ratio
    │
    ▼
POST /api/media/video
    Body: {
      prompt: "Cinematic product reveal…",
      model: "seedance-2.0",
      duration: 15,
      aspect: "16:9",
      projectId: "…"
    }
    │
    ▼
Daemon:
    ├── CREATE media task: { status: 'pending', kind: 'video' }
    ├── Call ByteDance Seedance API (or HeyGen, OpenAI Sora, Fal.ai…)
    ├── Poll provider status (async, every 5-10s):
    │   ├── processing → update task status
    │   └── completed → download .mp4 → save to project folder
    └── UPDATE task: { status: 'ready', resultUrl: '/files/video.mp4' }
    │
    ▼
UI: Poll task status → show progress bar → render inline video player
```

## HyperFrames Special Flow

```
User: Home → "Motion" chip (or HyperFrames model)
    │
    ▼
Project created with: { metadata: { videoModel: "hyperframes-html" } }
    │
    ▼
Agent generates HTML artifact with animations
    │
    ▼
POST /api/media/video
    Body: { model: "hyperframes-html", sourceFile: "index.html" }
    │
    ▼
Daemon:
    ├── Read .od/projects/<id>/index.html
    ├── POST to HeyGen HyperFrames API
    │   └── { html: "<artifact content>", … }
    ├── HeyGen renders HTML → MP4
    ├── Poll HeyGen status
    └── Download + save: .od/projects/<id>/output.mp4
    │
    ▼
UI: Video player with download button
```

## Audio Generation Flow

```
User: Home → Audio tab (or audio project)
    │
    ├── Select audio kind: Speech | Sound Effects
    ├── For Speech: type text + select voice
    └── For Sound Effects: write prompt
    │
    ▼
GET /api/elevenlabs/voices
    └── → Voice[] (with fallback to default voice on API failure)
    │
    ▼
POST /api/media/audio
    Body: {
      kind: 'speech',
      text: "Welcome to VNPay design platform",
      voiceId: "voice-xyz",
      projectId: "…"
    }
    │
    ▼
Daemon:
    ├── CREATE media task: { status: 'pending', kind: 'audio' }
    ├── Call ElevenLabs API (or Venice, SenseAudio)
    ├── Download .mp3 binary
    ├── Save to .od/projects/<id>/speech-<timestamp>.mp3
    └── UPDATE task: { status: 'ready', resultUrl: '/files/speech.mp3' }
    │
    ▼
UI: Inline audio player + download .mp3 button
```

## Task Reconciliation on Boot

```
Daemon starts
    │
    ▼
reconcileMediaTasksOnBoot()
    │
    ├── SELECT tasks WHERE status IN ('pending', 'processing')
    │
    ├── For each stale task:
    │   ├── Check if result file already exists on disk
    │   │   └── Yes → UPDATE status = 'ready'
    │   └── No → Re-submit to provider OR mark as 'failed'
    │
    └── Log reconciliation results
```

## Prompt Templates Flow

```
GET /api/media/prompt-templates
    └── → PromptTemplate[] { id, title, surface, prompt, category, tags, model, aspect }

UI: PromptTemplatesTab
    ├── Grid view filtered by surface (image | video)
    ├── Click template → preview text prompt
    └── "Use this template" → pre-fill prompt field
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/media/image` | Submit image generation task |
| POST | `/api/media/video` | Submit video generation task |
| POST | `/api/media/audio` | Submit audio generation task |
| GET | `/api/media/tasks/:taskId` | Poll task status |
| GET | `/api/media/prompt-templates` | List all prompt templates |
| GET | `/api/elevenlabs/voices` | List ElevenLabs voices |
