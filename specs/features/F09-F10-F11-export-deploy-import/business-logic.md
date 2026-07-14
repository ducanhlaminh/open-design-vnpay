# F-09 / F-10 / F-11: Export, Deploy & Import — Business Logic

## Overview

This feature group covers three related platform capabilities:
- **Export (F-09):** Convert artifacts to distributable formats (HTML, PDF, PPTX, ZIP, Markdown)
- **Deploy (F-10):** Publish artifacts to hosting providers and get a public URL
- **Import (F-11):** Bring external design projects (Claude Design ZIP, GitHub DS) into Open Design

---

## Export (F-09) — Business Rules

| Rule | Detail |
|------|--------|
| **BR-01** | HTML export inlines all assets (CSS, JS, images as base64) — works offline |
| **BR-02** | Exported HTML must be < 5MB for standard artifacts |
| **BR-03** | HTML export works offline on Chrome, Firefox, Safari — no server required |
| **BR-04** | PDF export uses browser print API; in deck mode, each slide = one PDF page |
| **BR-05** | Text must be selectable in exported PDFs |
| **BR-06** | PDF page breaks must match slide boundaries |
| **BR-07** | PPTX export is agent-driven via skill (e.g., `ppt-keynote`) and produces a `.pptx` in the project folder |
| **BR-08** | PPTX must be compatible with PowerPoint 2019+ and Keynote |
| **BR-09** | ZIP export includes all project files: HTML, CSS, JS, images, markdown |
| **BR-10** | Markdown export produces a readable conversation transcript |

### Inline Assets Processing

`inline-assets.ts` handles:
- External CSS → `<style>` tag (inline)
- External JS → `<script>` tag (inline)
- Images → base64 `data:` URI
- Google Fonts → bundled or fallback system font
- Font files → base64 embedded

---

## Deploy (F-10) — Business Rules

| Rule | Detail |
|------|--------|
| **BR-11** | Deploy uploads the artifact (with inlined assets) to the selected hosting provider |
| **BR-12** | Supported providers: Vercel and Cloudflare Pages |
| **BR-13** | Deploy SLA: < 60 seconds for artifact < 1MB |
| **BR-14** | Deploy URL is stable across re-deploys (idempotent project name) |
| **BR-15** | Status tracking: `deploying → preparing-link → ready | failed` |
| **BR-16** | Cloudflare Pages deploy additionally supports custom domain configuration |
| **BR-17** | Deployment records are persisted in SQLite |
| **BR-18** | A preflight check runs to validate file set before uploading: checks broken references, large assets, missing doctype, missing viewport, external scripts |

### Deployment Status States

| Status | Meaning |
|--------|---------|
| `deploying` | Upload in progress |
| `preparing-link` | Build or DNS propagation |
| `ready` | URL live and reachable |
| `link-delayed` | Link not yet reachable (CDN lag) |
| `protected` | Auth-protected deployment |
| `failed` | Deploy failed |

---

## Import (F-11) — Business Rules

| Rule | Detail |
|------|--------|
| **BR-19** | Claude Design ZIP format from Anthropic can be imported via drag-and-drop |
| **BR-20** | Import creates a real project with full conversation history preserved |
| **BR-21** | Imported files are accessible in the File Workspace |
| **BR-22** | Clear error message if ZIP format is invalid or unsupported |
| **BR-23** | GitHub Design System import parses a repo's `DESIGN.md` and validates the 9-section schema |
| **BR-24** | Folder import (`POST /api/import/folder`) creates a project rooted at an existing local directory |
| **BR-25** | Folder import requires Desktop Import Token header (HMAC-signed) for security |

---

## Deployment Data Model

```typescript
type DeployProviderId = 'vercel-self' | 'cloudflare-pages';

type DeploymentStatus =
  | 'deploying'
  | 'preparing-link'
  | 'ready'
  | 'link-delayed'
  | 'protected'
  | 'failed';

interface DeploymentInfo {
  id: string;
  projectId: string;
  fileName: string;
  providerId: DeployProviderId;
  url: string;
  deploymentId?: string;
  deploymentCount: number;
  target: 'preview';
  status: DeploymentStatus;
  statusMessage?: string;
  reachableAt?: number;
  cloudflarePages?: CloudflarePagesDeploymentInfo;
  createdAt: number;
  updatedAt: number;
}
```

---

## Acceptance Criteria

**Export:**
- [ ] HTML export < 5MB for standard artifacts
- [ ] CSS, JS, images inlined (offline-capable)
- [ ] PDF: deck mode → each slide = one page
- [ ] Text selectable in PDF
- [ ] PPTX opens in PowerPoint 2019+
- [ ] ZIP includes all project files

**Deploy:**
- [ ] Deploy < 60 seconds for artifact < 1MB
- [ ] URL stable after re-deploy
- [ ] Status tracking: deploying / ready / failed
- [ ] Cloudflare Pages deploy parity with Vercel
- [ ] Preflight check before upload

**Import:**
- [ ] Support Claude Design ZIP format
- [ ] Project history preserved
- [ ] Files accessible in File Workspace
- [ ] Clear error if ZIP invalid
