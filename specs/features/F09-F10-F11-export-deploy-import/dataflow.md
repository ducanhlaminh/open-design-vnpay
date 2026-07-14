# F-09 / F-10 / F-11: Export, Deploy & Import — Data Flow

## HTML Export Flow

```
User: Download → HTML
    │
    ▼
GET /api/projects/:id/files/:name/export/html
    │
    ▼
inline-assets.ts:
    ├── Read .od/projects/<id>/<name> (HTML source)
    ├── Parse all <link rel="stylesheet" href="…"> → fetch + inline as <style>
    ├── Parse all <script src="…"> → fetch + inline as <script>
    ├── Parse all <img src="…"> → fetch + convert to base64 data URI
    ├── Google Fonts → bundle or fallback
    └── Font files → base64 embedded
    │
    ▼
Output: single self-contained HTML file
    │
    ▼
→ Download: application/html (< 5MB)
```

## PDF Export Flow

```
User: Download → PDF
    │
    ▼
GET /api/projects/:id/files/:name/export/pdf
    │
    ▼
Daemon:
    ├── Serve artifact with print-friendly CSS injected
    ├── Deck mode: @page { break-after: always } per slide
    └── Return HTML configured for browser print
    │
    ▼
UI: window.print() triggered
    └── Browser PDF dialog → save file
```

## ZIP Archive Flow

```
User: Download → ZIP
    │
    ▼
GET /api/projects/:id/archive
    │
    ▼
Daemon:
    ├── Enumerate all files in .od/projects/<id>/
    ├── archiver.create('zip')
    │   └── append each file
    └── Pipe zip stream to response
    │
    ▼
→ Download: application/zip
```

## Vercel Deploy Flow

```
User: Deploy → Vercel
    │
    ▼
Step 1: Preflight
POST /api/projects/:id/deployments/preflight
    Body: { fileName, providerId: 'vercel-self' }
    │
    ▼
Daemon:
    ├── Enumerate file set
    ├── Check for warnings:
    │   ├── broken-reference
    │   ├── large-asset (> 1MB)
    │   ├── no-doctype
    │   └── external-script
    └── → { files[], totalBytes, warnings[] }
    │
    ▼
UI: Show preflight results, user confirms
    │
    ▼
Step 2: Deploy
POST /api/projects/:id/deployments/vercel
    Body: { fileName, providerId: 'vercel-self' }
    │
    ▼
Daemon:
    ├── Inline all assets (via inline-assets.ts)
    ├── POST to Vercel API:
    │   └── { files, name, projectName }
    ├── Vercel: status = 'deploying'
    ├── Poll Vercel status API
    │   ├── pending → keep polling (every 3s)
    │   └── ready → record URL
    ├── INSERT deployment record into SQLite
    └── → { url, status: 'ready', … }
    │
    ▼
UI: Show "Deployed at https://…" with copy link
```

## Cloudflare Pages Deploy Flow

```
User: Deploy → Cloudflare Pages
    │
    ▼
GET /api/cloudflare/zones
    └── → zones[] for domain selection
    │
User selects: zone, domainPrefix
    │
    ▼
POST /api/projects/:id/deployments/cloudflare
    Body: { fileName, cloudflarePages: { zoneId, zoneName, domainPrefix } }
    │
    ▼
Daemon:
    ├── Inline assets
    ├── POST to Cloudflare Pages API
    ├── Create/reuse DNS record
    ├── aggregateCloudflarePagesStatus() → normalize status
    └── → { url, deploymentId, status, cloudflarePages: { pagesDev, customDomain? } }
```

## Claude Design ZIP Import Flow

```
User: drag & drop .zip file into welcome dialog
    │
    ▼
POST /api/import/claude-design
    Content-Type: multipart/form-data
    Body: { zip: File }
    │
    ▼
claude-design-import.ts:
    ├── Validate: is a ZIP file
    ├── Parse ZIP structure (Claude Design format)
    │   ├── Extract: project name, conversation history, files
    │   └── Validate format (error if not Claude Design format)
    ├── CREATE project in SQLite (new UUID)
    ├── Copy files to .od/projects/<newId>/
    ├── Reconstruct conversation messages in SQLite
    └── → { projectId, name }
    │
    ▼
UI: navigate to new project
```

## GitHub Design System Import Flow

```
User: paste GitHub repo URL
    │
    ▼
POST /api/design-systems/import/github
    Body: { repoUrl: "https://github.com/owner/repo" }
    │
    ▼
Daemon:
    ├── Parse URL: extract owner/repo
    ├── Fetch DESIGN.md from GitHub raw content API
    ├── Parse 9 sections (## 1. Color … ## 9. Iconography)
    │   ├── All present → proceed
    │   └── Missing sections → return { error: "Missing sections: [3, 7]" }
    ├── Extract: name, colors, typography, components
    ├── Save to user's design systems
    └── → { designSystem: DesignSystemSummary }
```

## Folder Import Flow

```
User: Open Design → Import folder (desktop)
    │
    ▼
Desktop main process: shell.openPath dialog
    ├── Generate X-OD-Desktop-Import-Token (HMAC-signed)
    └── Send to daemon
    │
    ▼
POST /api/import/folder
    Headers: { X-OD-Desktop-Import-Token: "…" }
    Body: { baseDir: "/Users/user/my-project", name?, skillId? }
    │
    ▼
Daemon:
    ├── Verify HMAC token
    ├── realpath(baseDir) → canonicalize
    ├── Scan for entry file (index.html, main.html, etc.)
    ├── CREATE project: metadata.baseDir = canonicalized path
    └── → { project, conversationId, entryFile }
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects/:id/files/:name/export/html` | Inline HTML export |
| GET | `/api/projects/:id/files/:name/export/pdf` | PDF export |
| GET | `/api/projects/:id/archive` | ZIP archive |
| GET | `/api/projects/:id/transcript` | Markdown transcript |
| POST | `/api/projects/:id/deployments/preflight` | Preflight check |
| POST | `/api/projects/:id/deployments/vercel` | Deploy to Vercel |
| POST | `/api/projects/:id/deployments/cloudflare` | Deploy to Cloudflare Pages |
| GET | `/api/projects/:id/deployments` | List deployments |
| GET | `/api/cloudflare/zones` | List Cloudflare zones |
| POST | `/api/import/claude-design` | Import Claude Design ZIP |
| POST | `/api/import/folder` | Import local folder |
