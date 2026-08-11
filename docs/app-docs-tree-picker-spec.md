# App Confluence Docs Tree — declare once on the App, pick per feature

Status: SPEC (2026-08-07). Implements the flow: App declares its project's
Confluence root folder once; every feature's docs-ingest run then PICKS pages
from that tree (checkbox picker) instead of pasting URLs — with "already used
by feature X" badges so two features don't ingest the same doc twice.

## Problem

Today every docs run (stages running `jira-ingest`: `docs`, `prd-docs`,
`dr-docs`) starts from a hand-pasted Confluence URL/id. The App
(`pipeline_apps`) is only a grouping label. Consequences: repeated manual
paste per feature; no shared anchor to the dự án's doc tree; and nothing
warns when two features of the same App ingest the same page — the
source-level root of the duplicated-screen problem.

## Current structure (verified)

- `pipeline_apps` table: `id, name, created_at` (db.ts ~L244). CRUD:
  `POST/GET /api/pipelines/apps` etc. in `pipeline-routes.ts` (~L439-560);
  App id regex `^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$`.
- Feature → App link: project `metadata.studioConfig.appId`.
- Tree primitive EXISTS: `listDescendantPages(creds, seedPageId, hardCap=500)`
  in `bas/bas-client.ts` — CQL `ancestor=<id>` + `expand=ancestors`, returns
  `DescendantPage { pageId, title, treePath: string[] }` (path below the
  seed, top→down). Creds: `resolveConfluenceCreds(RUNTIME_DATA_DIR)`
  (PAT-only; null when unconfigured).
- Run path ALREADY takes multi-ref: for `jira-ingest` stages, a free-text
  `input` whose EVERY line is a Confluence URL/id goes down the tool-only
  `runDocsDeterministic(refs[])` path (server.ts ~L16167-16179). So the
  picker submits `input` = newline-joined pageIds — the run path is
  UNTOUCHED. `includeDescendants` (subtree ingest of a seed) also exists.
- Per-stage `lastInput`/`lastSource` is persisted on each project's
  `metadata.pipelines[stageId]` — the raw material for "already used by"
  badges.
- FE: App forms `apps/web/src/components/pipelines/NewAppModal.tsx` /
  `EditAppModal.tsx`; run-source modal in
  `apps/web/src/components/pipelines/PipelineModals.tsx` ("Req 4" section,
  `SourceKind = 'confluence' | 'bas'`; BAS side is LOCKED for maintenance).

## Design

### 1. Schema + App CRUD (daemon)

- `pipeline_apps` gains `confluence_root TEXT` (nullable). Forward-compatible
  ALTER via the existing `pragma_table_info` pattern in db.ts.
- Store the **pageId** (normalize: accept a pasted URL or bare id via the
  same ref-parsing used by the docs stage — `extractPageId`; store the id).
  URLs rot when pages move; ids don't.
- `POST /api/pipelines/apps` and the app-update route accept optional
  `confluenceRoot` (string, '' clears). App list/picker payloads include it.

### 2. Browse endpoint (daemon)

`GET /api/pipelines/apps/:appId/docs-tree`

- 404 unknown app (local `pipeline_apps` only — remote/studio apps have no
  root yet); 400 app has no `confluence_root`; 502 creds missing
  (`resolveConfluenceCreds` null) or Confluence fetch failure — body
  `{ error }` per existing route conventions.
- Happy path: `listDescendantPages(creds, root)` → respond

```jsonc
{
  "root": { "pageId": "1000083499", "title": "…" },   // title via fetch of the root page metadata (best-effort; id fallback)
  "pages": [
    { "pageId": "…", "title": "…", "treePath": ["Folder A", "Sub B"],
      "usedBy": [ { "projectId": "Tinh_nang_1", "pipelineId": "dr-docs" } ] }
  ],
  "truncated": false                                    // true when hardCap hit
}
```

- `usedBy`: scan sibling projects (same `metadata.studioConfig.appId`),
  collect each ingest stage's persisted `lastInput`/`lastSource`, extract
  page ids with the same ref-parsing, and mark matches. Cheap (in-memory over
  the projects list), best-effort — a parse failure yields an empty
  `usedBy`, never an error.
- No new caching layer; the picker fetches on open. Trees ≤ 500 pages
  (hardCap) return in one response.

### 3. FE picker (web)

- **App forms**: one optional text field "Confluence root (URL hoặc page id)"
  in NewAppModal + EditAppModal, plumbed through the existing api client
  calls.
- **Run-source modal** (PipelineModals.tsx Req-4 section): when the current
  project's App has a `confluenceRoot`, add source tab **"Tài liệu App"**
  (default-selected) alongside the existing Confluence paste tab:
  - Fetch `docs-tree` on open; render the tree from `treePath` grouping
    (folders = non-leaf path segments) with checkboxes; folder checkbox =
    toggle its subtree's pages.
  - Badge "đã dùng: <projectId>" (existing muted-badge styling) on pages with
    non-empty `usedBy`; the badge is informational — selection stays allowed
    (re-ingest is legitimate), but pre-warned.
  - Submit: newline-join selected pageIds into the modal's existing
    free-text `input` result (SourceResult `{ input }`) — the multi-ref
    deterministic path takes over. Do NOT emit a structured `source` (that
    shape is single-ref).
  - Fallbacks: no App / no root / tree fetch error → the tab is hidden or
    shows the error with a link-style hint, and the existing paste tab works
    exactly as today. BAS tab stays locked/untouched.
- Applies automatically to all three ingest stages (`docs`, `prd-docs`,
  `dr-docs`) because they share the same run-source modal + skillId.

## Non-goals (this change)

- No auto-ingest-on-app-link, no sync/watch of the Confluence tree.
- No studio (`app--slug`) side — `confluence_root` lives on the daemon's
  `pipeline_apps` only; studio can read it via the API later.
- No blocking of double-ingest — badge only.
- Lazy per-level tree loading (only needed past hardCap; `truncated: true`
  tells the user to narrow the root).

## Risks / edge cases

- PAT lacks read on the root → 502 with the fetch error; picker falls back
  to paste tab (fail-soft, matches BAS-picker precedent).
- Root page deleted/moved: id keeps working after moves within the space;
  deletion → 502 → paste fallback; fix by editing the App.
- `usedBy` matches only what a stage recorded (`lastInput`/`lastSource`) —
  a re-run with different pages forgets earlier ones. Acceptable: the badge
  is a hint, not a ledger.
- Two apps pointing at overlapping roots: fine — `usedBy` is scoped to
  sibling features of the SAME app.

## Test plan

- **BE unit** (vitest, `tests/`): schema migration adds the column once;
  POST/PUT normalize URL→pageId and clear on ''; docs-tree route: 404/400/502
  paths (creds stubbed), happy path shape, `usedBy` extraction from stubbed
  sibling projects' pipeline metadata, `truncated` flag.
- **FE**: type-clean build; manual smoke via daemon (picker renders the tree
  of a real App root, selection submits newline ids, run goes deterministic).

## Phases

- **Phase 1 (this change)**: schema + CRUD field + docs-tree endpoint +
  picker tab + badges + tests.
- **Phase 2 (later, when app-workspace lands)**: move/mirror
  `confluence_root` onto the app-workspace config; auto-suggest un-ingested
  pages as "docs mới cho feature tiếp theo".
