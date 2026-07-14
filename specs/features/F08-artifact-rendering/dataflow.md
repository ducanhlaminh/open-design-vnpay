# F-08: Artifact Rendering & Preview — Data Flow

## Artifact Streaming & Parsing Flow

```
Agent stdout (streaming)
    │
    ▼
parser.ts: Real-time XML stream parser
    │
    ├── Scan for <artifact …> opening tag
    │   → Record: identifier, type, title
    │
    ├── Stream content into buffer
    │   → Update streaming artifact state in UI
    │
    └── Detect </artifact> closing tag
        → Emit complete artifact event to UI
    │
    ▼
SSE event: artifact
data: {
  "html": "<!DOCTYPE html>…",
  "title": "My Landing Page",
  "identifier": "landing-page-v1"
}
```

## Artifact Rendering in UI

```
SSE artifact event received
    │
    ▼
Determine render mode:
    ├── type = "text/html" → srcdoc iframe
    ├── kind = "deck"      → DeckPlayer
    ├── image file         → ImageViewer
    ├── video file         → VideoPlayer
    └── audio file         → AudioPlayer
    │
    ▼
(For HTML)
Build srcdoc iframe:
    <iframe
      srcdoc="{artifact.html}"
      sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
      loading="lazy"
    />
    │
    ▼
Render within < 2 seconds
```

## File Workspace → Preview Sync Flow

```
User edits file in CodeEditor
    │
    ▼
Debounce 2 seconds
    │
    ▼
PUT /api/projects/:id/files/:name
    │
    ▼
File written to .od/projects/<id>/<name>
    │
    ▼
PreviewPane detects file change
    │
    ▼
Reload iframe src / update srcdoc
```

## Comment Annotation Flow

```
User clicks "Comment Mode" (Click Mode toggle)
    │
    ▼
PreviewDrawOverlay activates
    │
    ▼
User clicks element in iframe
    │
    ▼
Overlay captures:
    ├── elementId: target element's id attribute
    ├── selector: CSS selector path
    ├── position: getBoundingClientRect() → { x, y, width, height }
    └── htmlHint: outerHTML snippet
    │
    ▼
Comment popup opens
    └── User enters: label, text, note
    │
    ▼
POST /api/projects/:id/comments
    Body: {
      conversationId, filePath,
      elementId, selector, label, text,
      positionJson, htmlHint, note,
      status: 'open'
    }
    │
    ▼
Comment persisted in SQLite
    │
    ▼
Next conversation turn:
    Daemon injects open comments into prompt context
    → Agent sees: "Comment on #hero-cta: 'Button color too light'"
    → Agent addresses and resolves
    → Comment status → 'resolved'
```

## Manual Edit Flow

```
User opens ManualEditPanel
    │
    ▼
Split view:
    ├── Left: CodeEditor (MonacoEditor or CodeMirror)
    │   └── syntax highlighting for HTML/CSS/JS
    └── Right: Preview iframe
    │
User edits code
    │
    ▼
Real-time preview update (immediate)
    │
User clicks Save
    │
    ▼
PUT /api/projects/:id/files/:name
    └── { content: editorValue }
```

## Deck Navigation Flow

```
Artifact kind = 'deck'
    │
    ▼
DeckPlayer renders:
    ├── Parse slide boundaries (e.g., <section> tags or slide dividers)
    ├── Show slide counter: "1 / 10"
    ├── Left/Right arrow buttons
    └── Keyboard listener: ArrowLeft / ArrowRight
    │
User navigates
    │
    ▼
Active slide scrolls / transitions into view
    │
    ▼
Theater Mode:
    └── DeckPlayer fills entire viewport (fullscreen)
```

## Theater Mode Flow

```
User clicks fullscreen button
    │
    ▼
Theater component mounts
    │
    ▼
Artifact iframe displayed in full viewport
    ├── ESC key → exit theater
    └── Deck in theater → presentation mode
```

## Comment Status Flow

```
New comment created → status: 'open'
    │
Agent addresses comment in next turn
    │
    ▼
PATCH /api/projects/:id/comments/:commentId
    Body: { status: 'resolved' }
    │
    ▼
Comment badge changes: ● open → ✓ resolved
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects/:id/comments` | List all comments |
| POST | `/api/projects/:id/comments` | Create new comment |
| GET | `/api/projects/:id/comments/:cid` | Comment detail |
| PATCH | `/api/projects/:id/comments/:cid` | Update comment (status, note) |
| DELETE | `/api/projects/:id/comments/:cid` | Delete comment |
