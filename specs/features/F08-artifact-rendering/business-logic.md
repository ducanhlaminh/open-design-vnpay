# F-08: Artifact Rendering & Preview — Business Logic

## Overview

Design artifacts are emitted by the agent as XML `<artifact>` tags containing full HTML documents. The system parses these in real-time (even while streaming), then renders them in a **sandboxed srcdoc iframe**. Users can interact with the preview, comment on elements, edit code manually, and view sketches.

---

## Business Rules

### Artifact Format & Parsing

| Rule | Detail |
|------|--------|
| **BR-01** | Artifacts are wrapped in `<artifact identifier="…" type="text/html" title="…">` XML tags |
| **BR-02** | `parser.ts` handles streaming — parses partially complete `<artifact>` tags in real time |
| **BR-03** | Multiple artifacts can be emitted in a single agent turn |
| **BR-04** | Each artifact has a unique `identifier` for reference across turns |

### Sandboxed Iframe Rendering

| Rule | Detail |
|------|--------|
| **BR-05** | All artifacts render in a `srcdoc` iframe with `sandbox="allow-scripts allow-forms allow-popups allow-same-origin"` |
| **BR-06** | The iframe is fully isolated — no script can leak to the parent page |
| **BR-07** | Interactions inside the iframe work: click, scroll, hover, animations |
| **BR-08** | Artifact must render within **< 2 seconds** after agent completes |
| **BR-09** | Preview panel is resizable |

### Render Modes

| Mode | Trigger | Renderer |
|------|---------|---------|
| `html` | Default, `.html` files | srcdoc iframe |
| `deck` | `kind: 'deck'` | Horizontal swipe deck player |
| `image` | `.png`, `.jpg`, `.gif`, `.webp` | Image viewer |
| `video` | `.mp4` | Video player |
| `audio` | `.mp3`, `.wav` | Audio player |
| `markdown` | `.md` files | Rendered Markdown |
| `code` | `.js`, `.css`, `.json`, etc. | Syntax-highlighted code view |

### Click Mode vs. Interact Mode

| Rule | Detail |
|------|--------|
| **BR-10** | Default is **Interact Mode** — user can interact with the iframe normally |
| **BR-11** | **Click Mode** activates the annotation overlay — clicks open comment popups instead |
| **BR-12** | Switching between modes is one click (toggle button) |

### Preview Comments & Annotations

| Rule | Detail |
|------|--------|
| **BR-13** | In Click Mode, clicking an element opens a comment popup |
| **BR-14** | Comment captures: CSS selector, element ID, position `{x, y, width, height}`, label, text, note |
| **BR-15** | Comments have status `open` or `resolved` |
| **BR-16** | Comments are persisted in SQLite |
| **BR-17** | Open comments are injected into conversation context for the next turn |
| **BR-18** | After agent addresses a comment, status transitions to `resolved` |

### Normal Artifact vs. Live Artifact

| Property | Normal Artifact | Live Artifact |
|----------|----------------|--------------|
| Storage | File on disk (`index.html`) | SQLite record with source data |
| Refresh | Re-chat with agent | Click "Refresh" button |
| Use case | Landing page, deck, prototype | Dashboard, data-driven views |

### Manual Edit Panel

| Rule | Detail |
|------|--------|
| **BR-19** | User can edit HTML/CSS/JS directly in a split-view editor |
| **BR-20** | Changes in editor reflect immediately in the preview |
| **BR-21** | Save writes the file to disk |

### Sketch Editor

| Rule | Detail |
|------|--------|
| **BR-22** | User can draw freehand sketches |
| **BR-23** | Sketch can be converted to a design prompt for the agent |

### Download Chips

After artifact creation, the following download options appear:
- 📥 **HTML** — Inlined assets, offline-capable
- 📄 **PDF** — Browser print
- 📦 **ZIP** — Entire project
- 📝 **Markdown** — Conversation transcript

### Deck Navigation

When `kind = 'deck'`:
- Horizontal swipe navigation
- Keyboard arrows (left/right)
- Slide counter (e.g., "3/10")
- Print mode for PDF export
- Scroll mode for single-page view

### Theater Mode (Full-Screen)

| Rule | Detail |
|------|--------|
| **BR-24** | Full-screen "theater" mode available for all artifact types |
| **BR-25** | Deck artifacts in theater mode = presentation mode |

---

## Data Model — Preview Comments

```typescript
interface PreviewComment {
  id: string;
  projectId: string;
  conversationId: string;
  filePath: string;
  elementId: string;
  selector: string;        // CSS selector targeting element
  label: string;
  text: string;
  positionJson: object;    // { x, y, width, height }
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

---

## Acceptance Criteria

- [ ] Artifact renders in < 2 seconds after agent completes
- [ ] Iframe has correct `sandbox` attributes
- [ ] Scroll, hover, animations in iframe work correctly
- [ ] Click Mode clearly distinct from Interact Mode
- [ ] Comment saved with element_id, selector, position
- [ ] Comment context injected into conversation when relevant
- [ ] Comment status: open → resolved
- [ ] Auto-save after 2 seconds
- [ ] Preview syncs with file being edited
- [ ] Diff view appears when agent creates a new file version
