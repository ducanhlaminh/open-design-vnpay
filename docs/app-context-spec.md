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

## Phase 2 — App CRUD + link (dual-track: HTTP + CLI + contract)

- Contract `packages/contracts/src/api/apps.ts`: `App`, `AppContextFile`,
  create/list/get/link DTOs.
- Daemon `apps/daemon/src/app-routes.ts`:
  - `POST /api/apps` create · `GET /api/apps` list · `GET /api/apps/:id`.
  - `PUT /api/projects/:id/app { appId }` link a feature (writes `project.json`).
  - `GET/PUT /api/apps/:id/context/*` read/write charter + IA files on media.
- CLI `od app` in `apps/daemon/src/cli.ts` (via `SUBCOMMAND_MAP`): `create`,
  `list`, `link <featureId> <appId>`, `context get|set|edit` — each `--json`.

## Phase 3 — Promote (extend, reviewed)

- `POST /api/apps/:id/promote { featureId }`: read the feature's
  `app-context-delta.md`, show a diff, merge accepted bullets into the app
  charter, snapshot the previous version under `_v/`, clear the consumed delta.
- CLI `od app promote <featureId> [--section ...]`.
- Start human-in-the-loop (explicit promote). A reconcile agent that dedups /
  resolves conflicting deltas is a later optional automation.

## Phase 4 — Studio UI

- pipeline-studio dashboard gains an **App > Feature** grouping (apps as the top
  list; features nested). App detail page = charter/IA editor (markdown +
  JSON) + a "Promote deltas" review panel reading each feature's pending delta.
- A feature's config card gets an **App** selector (writes `project.json.appId`).

## Non-goals / keep simple

Don't build IA inventory auto-extraction, a pattern registry, DS-lift-to-app, or
context auto-refresh until a real pain shows. The MUST/SHOULD/local tiers and the
promote-with-review flow are the load-bearing parts; the rest is additive.
