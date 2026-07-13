# App Context — shared cross-feature UX/IA charter

## Problem

The docs→UI pipeline runs per **feature** (one `docs→cj→ux-research→ux→ux-review→ui`
run = one feature). Nothing sits above features, so each feature researches and
specs its UX independently and the same app drifts: divergent navigation, empty/
error/loading conventions, form patterns, terminology, and duplicated screens.
Design-system tokens already give app-wide *visual* consistency; there is no
equivalent shared source of truth for *behavioral / structural* UX.

## Model

Two tiers, mapped onto the existing 3-part project plumbing (identity + media
folder + KGS node) so no new primitive is introduced:

- **App (Project)** — the container. A media project keyed by its `appId` whose
  shared context lives under `app-context/**` (markdown for the charter/domain,
  JSON for IA/inventory). Media is the home because "media = where config lives"
  (KGS has no node-update API).
- **Feature** — one pipeline run (today's studio "project"). Its `project.json`
  gains an optional `appId` pointing at its app.

Context flows **inherit → extend**:

- **Inherit (read, automatic):** before each design stage the daemon stages the
  app's `app-context/**` into the run cwd as `./.app-context` (a dot-folder,
  invisible to snapshot/push/re-run-clear), mirroring how the UX knowledge base
  is staged as `./.ux-kb`. The kickoff tells the agent to treat it as the app-
  wide source of truth.
- **Extend (write, reviewed):** a feature never edits `./.app-context`. It only
  *proposes* additions by appending to an `app-context-delta.md` output file. A
  human **promotes** deltas into the app context — versioned via the existing
  `_v/<verId>` + `changelog.json` output-versioning.

Governance tiers inside the charter: `MUST` (app-wide, inherited, non-negotiable)
· `SHOULD` (default, a feature may override *with a recorded reason*) ·
feature-local (never touches app context).

## Phase 1 — DONE (this change)

Daemon "inherit" core, self-contained and unit-tested. No new HTTP/CLI/UI yet, so
it is dormant until a feature is linked and an app has context.

- `apps/daemon/src/app-context.ts`
  - `resolveAppId(featureProjectId)` — reads `project.json.appId` from media (null
    when unlinked; best-effort, never throws into a run).
  - `stageAppContext(appId, runCwd)` — copies `<appId>` media project's
    `app-context/**` → `<runCwd>/.app-context`; returns staged relative paths.
  - `appContextDirective(stagedFiles)` — pure kickoff text ('' when unstaged).
- `apps/daemon/src/server.ts` run-seed — for every stage except `docs`, resolve
  the app id, stage the context, and append `appCtxDirective` to the kickoff.
  Unlinked features / media errors keep the kickoff byte-identical to before.
- `ui/pipeline-studio/server/projects.ts` — `ProjectConfig.appId?: string`.

## Where the App layer lives — pipeline-studio, not the daemon

Projects/features are born and configured in **pipeline-studio** (it owns
`project.json` on the media store); the daemon only *consumes* `appId` at run
time (Phase 1). So App CRUD, linking, and charter authoring live in
pipeline-studio's server + FE — there is no `od app` CLI (studio is a proxy app
with no CLI track). The daemon side is finished at Phase 1.

## Phase 2 — App CRUD + link + charter API — DONE (pipeline-studio server)

`ui/pipeline-studio/server/apps.ts` (`registerApps`), wired in `index.ts`. An App
is a media folder `app--<slug>` with `app.json` (marker + name) and
`app-context/**`.

- `GET /api/apps` list · `POST /api/apps { name }` create · `GET /api/apps/:id`.
- `PUT /api/projects/:id/app { appId }` link/unlink a feature (empty = unlink).
- `GET /api/apps/:id/charter` · `PUT /api/apps/:id/charter { markdown }` read/write
  `app-context/ux-charter.md`.
- Gated on `projects:manage` (or admin), mirroring project create/config.

## Phase 3 — Promote (extend, reviewed) — DONE (pipeline-studio server)

- `GET /api/projects/:id/app-delta` — a feature's pending proposal.
- `POST /api/apps/:id/promote { featureId, markdown? }` — snapshot the current
  charter under `app-context/_history/`, then set it to the FE-reviewed `markdown`
  (or append the raw delta under a provenance heading), and clear the consumed
  delta. Human-in-the-loop; an auto-reconcile agent is later/optional.

## Phase 4 — Studio UI — DONE (functional core)

`AppLinkCard` on the project-detail page (`src/components/app-link-card.tsx`):
- **App selector** — link/unlink the feature to an app, or create one inline
  (`api.apps` / `createApp` / `linkFeatureApp`).
- **Charter editor** modal — read/write the shared `ux-charter.md`.
- **Promote** — when the feature's last run left a delta, review it and promote
  the merged markdown into the charter.
Adapter surfaces `config.appId`; `ProjectConfig`/`api` carry the app methods.

Deferred (additive, do when a real need shows): a dashboard **App > Feature**
tree grouping and a standalone app-detail route — the per-feature card already
covers link → charter → inherit → promote end to end.

## Non-goals / keep simple

Don't build IA inventory auto-extraction, a pattern registry, DS-lift-to-app, or
context auto-refresh until a real pain shows. The MUST/SHOULD/local tiers and the
promote-with-review flow are the load-bearing parts; the rest is additive.
