// Pipeline registry — the static docs→UI DAG. Each pipeline is a fixed skill
// whose SKILL.md body becomes the run's system prompt (via composeSystemPrompt's
// "## Active skill" block). There is no scheduler/executor: pipelines are run
// manually (button / `od pipeline run`). `dependsOn` still drives run ORDER
// (run-all sequencing) and CASCADE clearing (`stageRegenSet`), but it no
// longer GATES a stage's `active` flag — 2026-08 product decision (docs-only
// gate, see `computeActive`): the only prerequisite left is "does this
// workflow's ingest stage have a document yet", read straight off the
// project's files, not off a chain of per-stage run statuses. Mutable run
// state per project lives in projects.metadata_json (see db.ts helpers); this
// module is pure registry + derivation.

import type {
  PipelineStatus,
  PipelineView,
  ProjectPipelineState,
  Workflow,
} from '@open-design/contracts';

export interface PipelineDef {
  id: string;
  name: string;
  /** Skill id whose SKILL.md body drives this pipeline's agent run. */
  skillId: string;
  /**
   * Extra skills whose SKILL.md bodies are appended after the primary skill (one
   * combined block, via startChatRun's `skillIds`) so ONE pipeline can drive
   * several skills in a single run — e.g. a combined Feature Analysis + Customer
   * Journey step that emits both outputs from one "Run".
   */
  extraSkillIds?: string[];
  /** Pipeline ids that must be `succeeded` before this one becomes active. */
  dependsOn: string[];
  /**
   * Output path patterns this stage produces in the project cwd. Used by the
   * MANUAL upload to attribute each file to its stage (and decide B2). Patterns:
   * `dir/` = anything under that dir; `-suffix.json` / `*x` = endsWith; else an
   * exact relative path or basename.
   */
  outputs?: string[];
  /** If set, this pipeline takes a run input. `inputKind` distinguishes a
   * document-source selector from optional guidance for one agent stage. */
  inputPlaceholder?: string;
  inputKind?: 'source' | 'prompt';
  /**
   * When true, this stage generates UI and can apply a design system: the UI
   * shows a design-system picker before running and sends the chosen id as
   * `RunPipelineRequest.designSystemId`, which the daemon forwards to the chat
   * run (overriding the app-config default for that run only). Both UI-Spec
   * terminals (`ui-html`, `ui-react`) set this.
   */
  acceptsDesignSystem?: boolean;
  /**
   * When true, this stage takes review criteria from a design system. The
   * daemon copies criteria files into the workflow before the review runs.
   */
  usesDesignSystemCriteria?: boolean;
  /**
   * When true, this stage decides the target platform of the generated screens
   * — the UX Spec stage, whose per-screen `layout` field (`mobile` | `web`)
   * downstream UI-Spec terminals follow. The UI shows a Mobile/Website picker
   * before running and sends the choice as `RunPipelineRequest.platform`; the
   * daemon folds it into the kickoff. No choice → the skill defaults to mobile.
   */
  acceptsPlatform?: boolean;
  /**
   * When true, this stage accepts a MANUAL file upload from the UI (a
   * secondary "Tải file lên" button, separate from Run) instead of only ever
   * receiving input from an agent run. The daemon does not gate anything on
   * this flag itself — it is purely a client-side affordance flag; the actual
   * write goes through the normal `POST /api/projects/:id/files` route. Today
   * only `dr-docs` sets it: a user drops in a `.md` doc directly, or a
   * `criteria/` file the dr-review stage should judge against.
   */
  acceptsUpload?: boolean;
  /**
   * When true, this stage's outputs stay LOCAL — they are never pushed to the
   * media file store on upload, so they do NOT round-trip to another device
   * via push-all/pull-all. Reserve this for genuinely device-local scratch
   * outputs; a stage's user-facing DELIVERABLE must stay syncable (file-only
   * is fine — that's the default, not localOnly). No stage currently sets this.
   */
  localOnly?: boolean;
  /**
   * A stage the LEAN run-all skips. The chain's job is docs → a UI spec → UI;
   * the stages marked here sharpen that (a journey, research criteria, a
   * heuristic gate) but nothing downstream hard-requires them — `ux-spec`
   * explicitly says to carry on when the journey or the research report is
   * absent. Skipping them trades depth for a much shorter, cheaper run.
   *
   * LEAN IS A docs-to-ui-ONLY CONCEPT (product decision 2026-07): docs-to-prd
   * always runs its full chain — its journey/research ARE the review's
   * evidence, not optional sharpening — so no docs-to-prd stage may set this.
   * A workflow with no flagged stage ignores the lean toggle entirely
   * (resolveRunMode reports `full` regardless of the saved flag).
   */
  skippedInLeanRun?: boolean;
  /**
   * Runs ONCE per project, not once per UI target. Everything after the docs
   * ingest normally runs per target into `<workflow>/<target>/`; a stage marked
   * here describes the PROJECT rather than one product, so a per-target copy
   * would be N conflicting answers to the same question. Shared stages must sit
   * before the per-target ones in the workflow order — the run-all chain runs
   * them all up front, then forks per target.
   */
  sharedAcrossTargets?: boolean;
  /**
   * Path patterns (same syntax as `outputs`, workflow-dir-relative) that are
   * NEVER synced to the media file store — in BOTH directions. Push skips
   * (and prunes previously-pushed copies of) them; pull ignores them even
   * when an older store still carries them. Use for derived build artifacts
   * (`react/dist/` is rebuilt from source via the Build button) and
   * template-owned scaffold that the builder reseeds — syncing those would
   * pin a stale template over a newer toolkit on the pulling device.
   */
  syncExclude?: string[];
  /**
   * 2026-08 product decision (web-first): this stage cannot be RUN from any
   * surface (UI, API, CLI, run-all) while the flag is set — everything else
   * about it stays untouched (registry entry, `outputs`, `syncExclude`,
   * `stagesForOutput` attribution, `relClearedByRegen`, history). A held
   * stage's PAST output is still a real, syncable, attributable deliverable;
   * only NEW runs are refused. Derived from `HELD_STAGE_IDS` below — never set
   * this by hand on a `PipelineDef` literal, so the hold list has exactly one
   * place that names ids. Reopen a stage by removing its id from
   * `HELD_STAGE_IDS`; nothing else in this file needs to change.
   */
  heldFromRun?: true;
}

// The SINGLE list that decides which stage ids are held from running (see
// `PipelineDef.heldFromRun`'s docblock). Every consumer — `selectRunStages`
// below, `pipeline-routes.ts`'s run/run-all routes, `cli.ts`'s pipeline
// subcommands, and the web UI (via the `held` field `listPipelineStatus`
// derives from this) — reads the hold state off `PipelineDef.heldFromRun`
// (or, for `cli.ts`, off this exported constant directly), never off a second
// hand-copied id array. Un-hold a stage by deleting its id here.
export const HELD_STAGE_IDS = ['ui-html', 'ui-react', 'ui-react-ds'] as const;
const HELD_STAGE_ID_SET: ReadonlySet<string> = new Set(HELD_STAGE_IDS);

// ONE docs→UI-Spec workflow: three shared upstream stages (confluence-ingest →
// customer-journey-spec → ux-spec) feeding TWO terminal OPTIONS — generate the
// UI-Spec as an interactive HTML prototype (`ui-html`) or as a real React app
// (`ui-react`). Both terminals depend on the shared `ux` stage; a project may
// run either or both. (History: merged 2026-07 from the twin docs-to-html +
// docs-to-react workflows, whose upstream stages duplicated the same skills
// under workflow-scoped ids. The former Workflow A "docs → UI" — react-shadcn
// screen.json, KGS graph projection — was removed earlier.)
// Raw registry literal. `PIPELINE_DEFS` below derives `heldFromRun` from
// `HELD_STAGE_IDS` for the ids that list names, so a stage's hold state is
// never hand-duplicated onto its own literal entry here.
const PIPELINE_DEFS_BASE: readonly PipelineDef[] = [
  // There is NO feature-analysis step: the Customer Journey is authored
  // DIRECTLY from the step-1 docs MD, and UX Spec is derived from those docs +
  // the journey.
  //   docs → cj (customer journey from docs) → ux-research → ux → ux-review → ui-html | ui-react
  // Confluence sources run DETERMINISTICALLY (daemon fetches via the BAS
  // gateway — no agent, see runDocsDeterministic in server.ts). WP8 (2026-08)
  // removed the legacy JIRA agent path entirely — non-Confluence input now
  // fails fast instead of falling through to an agent. BAS source: locked (maintenance).
  // `docs/context/` holds the LINK-FOLLOWED pages (bas-client.ts): background
  // reading the ux stage is told to understand but never to build screens from.
  // They are a real output of this stage and must be declared as one — the same
  // list drives Quick result's file rail, the stage-scoped push, and the
  // stage-scoped pull, so leaving it out hid them from the rail AND kept them
  // off the media store, which left a second machine's ux run with none of the
  // domain background it is told to read.
  { id: 'docs',             name: 'Tài liệu (nạp)',                skillId: 'confluence-ingest',     dependsOn: [],                                       outputs: ['docs/jira/', 'docs/confluence/', 'docs/context/', 'docs-feature/'], inputPlaceholder: 'Confluence page URL/id', inputKind: 'source' },
  // Customer Journey built straight from the ingested docs MD (no feature-analysis
  // upstream). Each STAGE carries `sources[]` — the key text excerpts from the
  // source MD — which the SpecPreview surfaces under each stage card.
  // FILE-ONLY: every stage produces local file deliverables synced to the
  // media store; there is no graph store anymore (that was the removed
  // react-shadcn workflow's job).
  // ── System map: which APPS the docs describe, and where they hand off ─────
  // Multi-app projects (a customer web app + a backoffice, say) are ONE system:
  // the docs describe flows that cross between them. Everything downstream runs
  // per target from a SHARED docs folder, so without this each target guesses
  // which material is its own — and the hand-off points, the part that makes it
  // one system rather than two products, get lost on both sides.
  // Runs once (sharedAcrossTargets); the file lands INSIDE docs/ so the existing
  // per-target docs copy carries it into every target's cwd for free.
  // Hand-editable by design: a wrong classification is corrected in the file,
  // and only a re-run of THIS stage overwrites it.
  { id: 'docs-map',         name: 'Bản đồ hệ thống',           skillId: 'docs-system-map',       dependsOn: ['docs'], outputs: ['docs/system-map.json'], sharedAcrossTargets: true },
  { id: 'cj',               name: 'Customer Journey',          skillId: 'customer-journey-spec', dependsOn: ['docs-map'], outputs: ['-customer-journey.json', '-journey.json', '-cj.json', 'customer-journey/', 'cj/'], skippedInLeanRun: true },
  // ── UX Research (desk research from the local UX knowledge base) ───────────
  // BETWEEN cj and ux: reads the docs + customer journey to know the domain and
  // key flows, searches the local UX knowledge base (Growth.Design / NN/g /
  // Baymard — env UX_KB_DIR, default ~/ux-knowledge-base), and emits an
  // evidence-based criteria report (`ux-research/report.json` + report.md):
  // the UX criteria this app must meet, each traced to cited sources and
  // illustrated with hotlinked Growth.Design images. The ux stage depends on
  // this report so the UX Spec is authored AGAINST those criteria; the
  // heuristic gate may also cite them. FILE-ONLY, synced like other outputs.
  // When the knowledge base is absent on this machine the skill emits a
  // minimal report from its built-in fundamentals instead of failing the gate.
  { id: 'ux-research',      name: 'UX Research',               skillId: 'ux-research',           dependsOn: ['cj'], outputs: ['ux-research/'], skippedInLeanRun: true },
  // The UX stage decides each screen's target platform (`layout: mobile|web`),
  // which both UI-Spec terminals follow — so the platform picker lives here.
  // Besides the spec JSON it emits one free-layout wireframe per screen
  // (`wireframes/<SCREEN-ID>.wire.json`, wiretext schema) AND one rule
  // flowchart per user flow (`flows/<FLOW-ID>.flow.json`: decision/end nodes +
  // labeled edges between screens — the wireframe+flowchart pair IS the user
  // flow deliverable; viewers render it instead of the retired Mermaid view).
  // File-only deliverables, synced like other outputs.
  // Depends on ux-research (not cj directly): the spec must be authored against
  // the researched criteria.
  { id: 'ux',               name: 'UX Spec',                   skillId: 'ux-spec',               dependsOn: ['ux-research'], outputs: ['-ux-spec.json', 'ux/', 'wireframes/', 'flows/'], acceptsPlatform: true, usesDesignSystemCriteria: true },
  // ── GATE 1: UX Heuristic Review (Nielsen + Norman, judged on the wireframe) ─
  // Shift-left quality gate BETWEEN the UX Spec and the UI-Spec terminals: a
  // separate run (not the ux-spec generator grading its own work) reads the
  // authored screens and evaluates them against usability heuristics, emitting
  // a review report under `./heuristic-review/`. Both terminals depend on THIS
  // stage (not `ux` directly), so the review must run once before any UI is
  // built — one gate protects both html + react. FILE-ONLY: the report is a
  // local deliverable synced to the media store. WCAG pixel gates are judged
  // later, post-render.
  { id: 'ux-review',        name: 'UX Heuristic Review',       skillId: 'heuristic-eval',        dependsOn: ['ux'], outputs: ['heuristic-review/'], skippedInLeanRun: true, usesDesignSystemCriteria: true },
  // ── Terminal option A: UI-Spec (HTML prototype) ────────────────────────────
  // ui-html also activates `frontend-design` (UI/UX craft) so the agent designs
  // boldly + well, not just structurally. The prototype skill additionally opts
  // into craft rules (anti-ai-slop, laws-of-ux, typography, color, animation).
  // The `prototype/` HTML output IS the deliverable, so it syncs to the
  // media file store like every other stage (push-all/pull-all cross-device
  // handoff). It is file-only (not graph data).
  // GATE 2 (post-render WCAG) rides along as `wcag-lint`: after the prototype is
  // produced, the agent runs the bundled static linter and writes
  // ./prototype/a11y-report.json (measured contrast / touch / manual notes).
  // Baked into the terminal (not a separate stage) because the WCAG gate is
  // deterministic and the two terminals are OPTIONAL — a shared post-terminal
  // stage couldn't gate "either one". The report lives inside prototype/ so it
  // syncs + attributes to this stage with no extra output pattern.
  { id: 'ui-html',          name: 'UI-Spec (HTML)',            skillId: 'html-interactive-prototype', extraSkillIds: ['frontend-design', 'web-design-guidelines', 'taste-skill', 'wcag-lint'], dependsOn: ['ux-review'], outputs: ['prototype/'], acceptsDesignSystem: true, usesDesignSystemCriteria: true },

  // ── Terminal option B: UI-Spec (React app) ─────────────────────────────────
  // The `ui-react` skill emits a REAL, buildable Vite + React 19 + Tailwind v4
  // shadcn app (built in an isolated Docker container) rather than static HTML.
  // FILE-ONLY like ui-html: the react/ deliverable syncs to the media store.
  // Terminal ui-react activates the same design/craft skills as ui-html so the
  // app is genuinely designed; the built `react/` (source + dist) IS the
  // deliverable and syncs to the media store (file-only).
  // Sync policy for the react/ tree: what the agent authored (src/screens,
  // App.tsx, main.tsx, index.css, flow.json) AND the built `dist/` travel.
  // dist/ syncs because remote consumers (pipeline-studio) preview the app
  // from the store — dist/screens/*.html + shared dist/assets/* chunks — and
  // have no Docker builder to reconstruct it (~1MB/project, multi-entry build,
  // no singlefile). It can still be rebuilt locally on demand (Build button →
  // POST /api/pipelines/react-build). Generated entries (react/screens/) and
  // template-owned scaffold stay excluded — pulling those would pin a stale
  // template over a newer toolkit. `*.artifact.json` are daemon-side render
  // metadata written next to each html — noise for remote consumers.
  // GATE 2 (post-render WCAG) also rides along here as `wcag-lint`: after the
  // Vite build, the agent lints ./react/dist and writes ./react/a11y-report.json
  // (react/a11y-report.json is not in syncExclude, so it round-trips).
  { id: 'ui-react',         name: 'UI-Spec (React)',           skillId: 'ui-react',              extraSkillIds: ['frontend-design', 'web-design-guidelines', 'taste-skill', 'wcag-lint'], dependsOn: ['ux-review'], outputs: ['react/'], acceptsDesignSystem: true, usesDesignSystemCriteria: true,
    syncExclude: [
      'react/screens/',
      'react/package.json',
      'react/vite.config.ts',
      'react/tsconfig.json',
      'react/components.json',
      'react/index.html',
      'react/src/components/ui/',
      'react/src/lib/',
      '*.artifact.json',
    ] },

  // ── Terminal option C: UI-Spec (React DS) ──────────────────────────────────
  // Like ui-react, but the component vocabulary IS the imported design system:
  // before the run the daemon stages the selected system's compiled react
  // bundle (a Figma IR import — components/ui + lib/runtime + tk-* token
  // classes) into <workflow>/react-ds/src/ds/ (Phase C of the design-system
  // import spec), and the skill composes screens exclusively from it — no
  // Tailwind, no shadcn. Requires a design system that ships a react bundle
  // (hasReactBundle); the daemon refuses the run otherwise. The staged src/ds/
  // and public/ (icon SVGs) are excluded from sync — they are re-staged from
  // the design system on every run, and the assets tree is far too heavy for
  // the media store.
  { id: 'ui-react-ds',      name: 'UI-Spec (React DS)',        skillId: 'ui-react-ds',           extraSkillIds: ['frontend-design', 'web-design-guidelines', 'taste-skill', 'wcag-lint'], dependsOn: ['ux-review'], outputs: ['react-ds/'], acceptsDesignSystem: true, usesDesignSystemCriteria: true,
    syncExclude: [
      'react-ds/screens/',
      'react-ds/package.json',
      'react-ds/vite.config.ts',
      'react-ds/tsconfig.json',
      'react-ds/index.html',
      'react-ds/src/ds/',
      'react-ds/public/',
      '*.artifact.json',
    ] },

  // ── `docs-to-prd` workflow — fully INDEPENDENT of docs-to-ui ───────────────
  // Same three ingredient skills as docs-to-ui's docs/cj/ux-research
  // (confluence-ingest, customer-journey-spec, ux-research — identical
  // skills, so identical behavior), but under THEIR OWN pipeline ids and
  // folder namespace. This is
  // deliberate: docs-to-ui's output must never be usable as docs-to-prd's
  // input (or vice versa) — a project reviewing a PRD re-ingests its own docs
  // independently of whatever it separately ran for UI generation. Keep every
  // field here in sync with the `docs`/`cj`/`ux-research` defs above by hand;
  // there is no shared base def to factor out because `PipelineDef.dependsOn`
  // and `outputs` must each point at THIS workflow's own sibling ids.
  { id: 'prd-docs',         name: 'Tài liệu (nạp)',                skillId: 'confluence-ingest',     dependsOn: [],              outputs: ['docs/jira/', 'docs/confluence/', 'docs/context/', 'docs-feature/'], inputPlaceholder: 'Confluence page URL/id', inputKind: 'source' },
  // NO skippedInLeanRun anywhere in docs-to-prd: lean is a docs-to-ui-only
  // concept. The journey + research here are the requirements review's evidence
  // base. The Run-all lean toggle is therefore inert for this
  // workflow (and the UI hides it).
  { id: 'prd-cj',           name: 'Customer Journey',          skillId: 'customer-journey-spec', dependsOn: ['prd-docs'],    outputs: ['-customer-journey.json', '-journey.json', '-cj.json', 'customer-journey/', 'cj/'] },
  { id: 'prd-ux-research',  name: 'UX Research',               skillId: 'ux-research',           dependsOn: ['prd-cj'],      outputs: ['ux-research/'] },
  // PRD Requirements Review: assesses the written URD/PRD against its Customer
  // Journey + UX research criteria. Embedded mockups are illustrative only:
  // they must never become visual direction, a wireframe source, or a basis for
  // adding/removing a textual requirement. The current report remains keyed by
  // attachment for preview compatibility, but its conclusions are text-first.
  { id: 'prd-review',       name: 'PRD Requirements Review',  skillId: 'docs-mockup-review',    dependsOn: ['prd-ux-research'], outputs: ['review/'], usesDesignSystemCriteria: true },

  // ── `docs-review` workflow — fully INDEPENDENT of docs-to-ui AND docs-to-prd ─
  // Three stages: ingest (same confluence-ingest skill, its own dr-docs id/folder —
  // the independence rule above applies here too, so a docs-to-ui or
  // docs-to-prd ingest never counts as "already done" for this workflow), then
  // a review stage that clones every ingested page into `review/docs/` and edits
  // the CLONE against an optional `criteria/` folder the user drops in via
  // `od files upload --as docs-review/criteria/<name>.md` (criteria/ is not a
  // stage output of anything — see stagesForOutput — so it survives every
  // re-run of dr-review untouched). skillId MUST stay 'confluence-ingest' for
  // dr-docs: runDocsDeterministic (server.ts) only takes the tool-only
  // Confluence path for that exact skillId.
  { id: 'dr-docs',          name: 'Tài liệu (nạp)',                   skillId: 'confluence-ingest',     dependsOn: [],                   outputs: ['docs/', 'docs-feature/'], inputPlaceholder: 'Confluence page URL/id', inputKind: 'source', acceptsUpload: true },
  // Rút SƠ ĐỒ LUỒNG MÀN HÌNH từ tài liệu GỐC (`docs/`): mỗi luồng nghiệp vụ
  // thành một `flows/<FLOW-ID>.flowchart.json` (node start/end/action/decision
  // + edge có nhãn, node action có thể gắn `screen` = SCREEN-KEY của màn) để
  // viewer vẽ lại. Chạy TRƯỚC dr-comp (2026-08-17): dr-comp đọc `flows/` để
  // biết màn nào nối sang màn nào khi vẽ wireframe (`data-nav`), nên flow phải
  // có trước; và trước dr-review — review là bước chốt cuối của workflow.
  // `flows/` nằm ở GỐC workflow-dir, KHÔNG lồng trong `review/`: `review/` là
  // output của dr-review, nên lồng vào đó thì (a) mỗi lần re-run dr-review sẽ
  // xoá sạch sơ đồ vừa dựng và (b) stagesForOutput chấm CẢ HAI stage cho cùng
  // một file, làm dr-review hiện xanh chỉ vì dr-flow đã chạy. Trùng tên với
  // `flows/` của stage `ux` bên docs-to-ui là vô hại: attribution có namespace
  // theo workflow nên `docs-review/flows/…` chỉ khớp stage của workflow này.
  // 2026-08-27: bước này KHÔNG còn review sơ đồ ("Đánh giá luồng UX", skill
  // docs-flow-ux) — nó SINH luồng màn hình của tính năng cho designer. Daemon
  // vẫn giải nén sơ đồ GỐC vào `flows/<FLOW-ID>/as-is.*` trước khi agent chạy
  // (prepareFlowUxInputs) nhưng giờ chỉ làm SEED; agent chưng cất tài liệu +
  // seed thành một sơ đồ màn duy nhất `flows/SCREEN-FLOW/screen-flow.cells.xml`
  // (mxCell trần, conventions next-ai-draw-io) + `screens.json` (schema cũ).
  // Daemon wrap + validate + dịch thành flow drawio bình thường
  // (finalizeScreenFlowXml, seed dời sang flows/_seeds/) rồi finalizeFlowUx
  // dựng `flowchart.json`/`index.json` như cũ — contract cho dr-comp/dr-review
  // giữ nguyên, index chỉ còn đúng một flow SCREEN-FLOW.
  // WP dr-screens-merge (2026-08-27): bước này SỞ HỮU LUÔN danh sách màn —
  // `screens.json` v2 (`screens[]` key/code/name/anchorText/cell/why/blocks)
  // được daemon dẫn xuất thành `screens-discovered.json` + `.md` +
  // `comp/_screens.json` (ĐÚNG contract dr-screens cũ, persistScreenDiscovery)
  // nên dr-comp / ScreensDiscoveredPreview / ScreenListManager không đổi.
  // Ba output đó khai ở đây để re-run dr-flow dọn chúng (generic theo outputs);
  // `comp/_screens.json` nay có hai chủ (dr-flow + dr-comp qua `comp/`) —
  // stagesForOutput chấm cả hai, stageForOutput ưu tiên dr-flow (đứng trước).
  // `screens-overrides.json` KHÔNG nằm trong outputs → sống sót (bất biến WP14).
  { id: 'dr-flow',          name: 'Luồng màn hình',            skillId: 'docs-screen-flow',      dependsOn: ['dr-docs'],          outputs: ['flows/', 'screens-discovered.json', 'screens-discovered.md', 'comp/_screens.json'] },
  // WP dr-flow-improve (2026-08-27): "Cải thiện luồng" — bước RIÊNG chạy SAU
  // dr-flow, TRƯỚC dr-comp. Agent (skill docs-screen-flow-improve, tập con
  // lean của docs-flow-ux cũ) review `flows/SCREEN-FLOW` theo heuristics UX và
  // ghi `patch.json` (ops relabel/mark/addNode/addEdge/redirectEdge —
  // `addNode.screen` = node mới LÀ một màn) + `ux-review.json` (finding có
  // reason/evidence/cells). Daemon tái dùng cơ chế "Đề xuất" cũ: finalizeFlowUx
  // áp patch → `proposed.drawio` 2 trang (Nguyên bản | Cải thiện) tô màu
  // Thêm/Sửa/Bỏ; sinh thêm `screens.improved.json` (màn của bản cải thiện).
  // `selection.json` (bản đang dùng để chạy tiếp) KHÔNG nằm trong outputs →
  // re-run bước này không xoá lựa chọn của người dùng; re-run dr-flow (cascade)
  // xoá cả thư mục flows/ kể cả bước này — đúng ý (luồng mới → đề xuất cũ vô
  // nghĩa). `proposed.edited.json` = người dùng sửa tay trang Cải thiện.
  // dr-comp KHÔNG dependsOn bước này (tuỳ chọn khi chạy lẻ); run-all có nó.
  // Bước này XOÁ `ux-review.json` tối thiểu do dr-flow ghi khi re-run — chấp
  // nhận (finalizeFlowUx chịu được review vắng: chỉ warning "thiếu/hỏng").
  // docs-review không có cơ chế lean (docs-to-ui-only) nên không gắn cờ.
  { id: 'dr-flow-improve',  name: 'Cải thiện luồng',           skillId: 'docs-screen-flow-improve', dependsOn: ['dr-flow'], outputs: ['flows/SCREEN-FLOW/patch.json', 'flows/SCREEN-FLOW/ux-review.json', 'flows/SCREEN-FLOW/proposed.drawio', 'flows/SCREEN-FLOW/proposed.edited.json', 'flows/SCREEN-FLOW/screens.improved.json'] },
  // Bước GIỮA: đối chiếu component + wireframe. Đọc `docs/` (bản GỐC, chưa
  // review) và với MỖI màn hình trong tài liệu, liệt kê phần tử nào dùng
  // component nào rồi đối chiếu với danh mục hợp lệ `criteria/components.md`,
  // ghi ra `comp/<page-slug>.components.json`; đồng thời vẽ mỗi màn một
  // wireframe khối xám ghi tên component `wireframes/<SCREEN-KEY>.html`.
  //
  // Vì sao tách thành một bước riêng thay vì để dr-review tự làm: component
  // được map một lần từ khai báo chữ trong URD/PRD tới danh mục hợp lệ. Ảnh
  // mockup chỉ là minh hoạ, không được dùng để suy component/variant/layout;
  // nhờ vậy các section không thể tạo kết luận mâu thuẫn từ cùng một ảnh.
  //
  // dependsOn dr-flow (2026-08-17): wireframe lấy `data-nav` từ cạnh của
  // `flows/*.flowchart.json`, nên run-all chạy flow trước và re-run dr-flow có
  // cascade sẽ xoá comp/ + wireframes/ để vẽ lại.
  //
  // `comp/` và `wireframes/` nằm ở GỐC workflow-dir, KHÔNG lồng trong
  // `review/` — cùng lý do đã ghi cho `flows/` bên trên: lồng vào đó thì mỗi
  // lần re-run dr-review sẽ xoá sạch kết quả, và stagesForOutput sẽ chấm hai
  // stage cho cùng một file. Trùng tên `wireframes/` với stage `ux` là vô hại
  // (namespace theo workflow).
  // Phát hiện màn hình (WP1, 2026-08-25): bước MỚI trước dr-comp. Với PRD tự
  // do (heading kiểu "2.1 Mua SIM"), quét tất định `scanDocScreens` (lớp 1
  // của dr-comp) đôi khi nâng một heading CON chỉ mô tả MỘT PHẦN của màn (vd
  // "Voucher" là một khối trong màn "Mua SIM") thành một màn RIÊNG. Bước này
  // để agent đọc TOÀN BỘ tài liệu + flows/ rồi tự lập danh sách màn THẬT, ghi
  // `docs-review/screens-discovered.json` (đặt ở GỐC workflow-dir, NGOÀI
  // comp/, để sống sót qua mọi lần re-run/clear của dr-comp — xem contract ở
  // `screen-components.ts`'s `parseScreensDiscovered`) + bản người-đọc
  // `screens-discovered.md`. dr-comp (`prepareScreenComponentInputs`) đọc file
  // này làm nguồn TIÊU THỤ có thẩm quyền, thay cho quét regex, khi file tồn
  // tại và hợp lệ; không có file thì dr-comp lùi về hành vi cũ (tương thích
  // ngược tuyệt đối). `comp/_screens.json` là gợi ý daemon tự quét cho agent
  // tham khảo (không phải nguồn sự thật).
  // WP dr-screens-merge (2026-08-27): ẨN — GỘP vào dr-flow (docs-screen-flow
  // ghi screens.json v2, daemon sinh cùng 3 output). Def GIỮ như `dr-confirm`
  // (không nằm trong `pipelineIds` của docs-review) để chạy TAY khi tài liệu
  // không có luồng để vẽ; runScreenDiscovery (server.ts) vẫn dispatch theo
  // skillId. dependsOn giữ nguyên.
  { id: 'dr-screens',       name: 'Phát hiện màn hình',        skillId: 'docs-screen-discovery',   dependsOn: ['dr-docs', 'dr-flow'], outputs: ['screens-discovered.json', 'screens-discovered.md', 'comp/_screens.json'] },
  // WP dr-mockup (2026-08-27): dr-comp RÚT KHỎI workflow docs-review — dựng màn
  // theo Design System tạm dừng (người dùng: tạo App / chạy workflow không cần
  // DS). Def GIỮ như `dr-screens`/`dr-confirm` (không trong `pipelineIds`) để
  // chạy TAY khi App có DS; runDocsComponentAuditFanout (server.ts) vẫn dispatch
  // theo skillId với fallback wfDir 'docs-review'. Hệ quả attribution (giống
  // dr-screens): `docs-review/comp/**` + `wireframes/**` không còn stage nào
  // trong workflow khai → stagesForOutput trả rỗng, không "Xong" ké, re-run
  // clear generic không đụng — fan-out tự dọn output của nó.
  { id: 'dr-comp',          name: 'Màn hình → Component',      skillId: 'docs-screen-components',  dependsOn: ['dr-docs', 'dr-flow'], outputs: ['comp/', 'wireframes/'], usesDesignSystemCriteria: true },
  // WP dr-mockup (2026-08-27): "Mockup màn" — THAY chỗ dr-comp trong workflow,
  // đứng SAU dr-flow-improve. Agent (skill docs-screen-mockup) dựng mỗi màn
  // của BẢN ĐÃ CHỌN (selection.json Nguyên bản/Cải thiện — danh sách màn
  // daemon soạn vào `mockups/_inputs.json` bằng prepareScreenComponentInputs
  // với outFile) một mockup HTML mức CONCEPT LAYOUT: vùng bố cục xám + nhãn
  // nội dung thật, `data-nav` chuyển màn, KHÔNG map Design System, KHÔNG
  // element-level như wireframe của dr-comp. Daemon copy `_mockup.css` từ
  // skill assets một lần / stage, validate tất định sau agent
  // (screen-mockups.ts: thiếu file/script/link → chặn; nav sai → xoá + warning;
  // index.json hỏng → dựng lại). KHÔNG `usesDesignSystemCriteria` — bước này
  // cô lập khỏi DS. dependsOn dr-flow → re-run dr-flow (cascade) xoá mockups/.
  { id: 'dr-mockup',        name: 'Mockup màn',                skillId: 'docs-screen-mockup',    dependsOn: ['dr-docs', 'dr-flow'], outputs: ['mockups/'] },
  // dr-review dependsOn (WP dr-mockup): bỏ dr-comp — review không còn chờ dựng
  // màn theo DS; nhóm `component` của review đọc comp/ khi có, vắng thì bỏ qua.
  { id: 'dr-review',        name: 'Review tài liệu',           skillId: 'docs-spec-review',      dependsOn: ['dr-docs', 'dr-flow'], outputs: ['review/'], usesDesignSystemCriteria: true },
  { id: 'dr-confirm',       name: 'Xác nhận hoàn tất',         skillId: 'docs-review-confirm',   dependsOn: ['dr-review'], outputs: ['confirmation/'] },

  // ── `ds-lab` workflow — fully INDEPENDENT of docs-to-ui/docs-to-prd/docs-review ─
  // 2026-08-22 product decision (.tmp/pipeline/wp-lab.yaml): DS thực tế chỉ có
  // comp base (chưa có screen mẫu) — thay vì "trung thành tài liệu" như
  // docs-review, workflow này để agent TỰ SÁNG TÁC màn từ comp base + tokens;
  // URD chỉ cho biết màn LÀM GÌ (chức năng + nội dung thật), KHÔNG phải TRÔNG
  // THẾ NÀO — mockup nhúng trong docs chỉ là ngữ cảnh hiểu tính năng.
  // `lab-docs` dùng đúng skill `confluence-ingest` (tiền lệ docs/prd-docs/
  // dr-docs) nhưng id/folder RIÊNG — độc lập tuyệt đối, không gì được chia
  // sẻ qua lại với ba workflow trên (cùng bất biến "mỗi pipeline id thuộc
  // đúng 1 workflow").
  { id: 'lab-docs',         name: 'Tài liệu (nạp)',            skillId: 'confluence-ingest',     dependsOn: [],                   outputs: ['docs/', 'docs-feature/'], inputPlaceholder: 'Confluence page URL/id', inputKind: 'source', acceptsUpload: true },
  // `lab-map` (WP-lab-map, 2026-08-23 — .tmp/pipeline/wp-lab-map.yaml): stage
  // MỚI, CHỈ ĐỌC, đứng NGAY SAU lab-docs và TRƯỚC lab-compose (WP-lab-reorder
  // — xem ngay dưới — đổi thứ tự này) — agent đọc artifact docs-review của
  // cùng dự án (nếu có, staging fail-soft vào `map-src/`, xem runLabMap trong
  // server.ts) ưu tiên hơn tự đọc docs, biên ra `screen-map.json`/
  // `screen-map.md`: CÁI GÌ (màn nào, mục đích, mustHave role+content, trạng
  // thái, nav, luồng chính) — KHÔNG nói LÀM THẾ NÀO (không toạ độ/thứ tự/bố
  // cục). Mục đích: key màn ỔN ĐỊNH giữa các lần chạy (dùng NGUYÊN VĂN key
  // docs-review khi có) để lab-compose bám đúng thay vì tự đặt key mới mỗi
  // lần (SCR-01 ≠ 6.1.1). Cùng bất biến DAEMON-ORCHESTRATED như lab-kit-plan/
  // lab-kit/lab-compose — server.ts nhận diện skillId này và tự chạy
  // runLabMap (rút gọn từ runLabKitPlan, KHÔNG Figma MCP nào — Symbol
  // INTERNAL_MCP_SERVER_IDS rỗng). Không có docs-review cho dự án này → agent
  // tự phân tích từ docs (fallback, ghi `generatedFrom: "docs"`), KHÔNG fail.
  {
    id: 'lab-map',
    name: 'Bản đồ màn',
    skillId: 'lab-map',
    dependsOn: ['lab-docs'],
    outputs: ['screen-map.json', 'screen-map.md'],
    inputPlaceholder: 'Luồng/màn cần ưu tiên (tuỳ chọn)',
    inputKind: 'prompt',
  },
  // `lab-compose` KHÔNG chạy qua đường agent-pipeline thường — run profile
  // 'pipeline' bị `computeEnabledMcp` (figma-build.ts) cắt sạch MCP ngoài
  // (0.8.52 quyết định, KHÔNG nới luật đó ở đây). Thay vào đó server.ts nhận
  // diện đúng skillId này và tự chạy stage DAEMON-ORCHESTRATED (tiền lệ
  // runDocsDeterministic): preflight (file preview + MCP Figma + App/DS
  // source) → staging criteria/ → spawn MỘT run THƯỜNG mang Figma MCP qua
  // Symbol allow-list (nguyên khuôn figma-build) → chờ run xong → đọc
  // lab-result.json → capture PNG từng màn (fetchNodeImages) → screens/.
  // `patterns/<slug>.json` (pattern agent tự chế, đọc lại ở lần chạy sau) CỐ
  // Ý không nằm trong `outputs` — không phải sản phẩm của MỘT lần chạy nên
  // phải sống sót "Chạy lại" (stagesForOutput không chấm nó cho stage nào →
  // relClearedByRegen không bao giờ xoá nó). `dependsOn` CỐ Ý chỉ có
  // `lab-docs`, KHÔNG có `lab-kit`: kit là ƯU TIÊN khi có (buildComposeBrief's
  // `hasKit`), không phải điều kiện cứng — một dự án chưa chạy lab-kit vẫn
  // sáng tác màn được thẳng từ comp base, đúng tinh thần "re-run độc lập".
  // WP-lab-reorder (2026-08-23 — .tmp/pipeline/wp-lab-reorder.yaml): `lab-
  // compose` nay đứng NGAY SAU `lab-map`, TRƯỚC `lab-kit-plan`/`lab-kit`
  // trong thứ tự workflow (`dependsOn` KHÔNG đổi — vẫn chỉ `lab-docs`, map là
  // ƯU TIÊN khi có, không phải điều kiện cứng, cùng tinh thần cũ) — "Sáng tác
  // màn" chạy NGAY sau "Bản đồ màn" để "Đề xuất kit" có màn thật làm bằng
  // chứng thay vì đoán từ docs. Lần chạy ĐẦU chưa có kit là bình thường (dựng
  // từ comp base); lần "Chạy lại" SAU "Đóng gói comp" (lab-kit) → ưu tiên kit
  // như cũ (hành vi buildComposeBrief's `hasKit` không đổi).
  { id: 'lab-compose',      name: 'Sáng tác màn',              skillId: 'lab-screen-compose',    dependsOn: ['lab-docs'],         outputs: ['screens/', 'lab-result.json'], inputPlaceholder: 'Phạm vi màn / định hướng thị giác (tuỳ chọn)', inputKind: 'prompt' },
  // `lab-kit-plan` (WP-kit-plan, 2026-08-22 — .tmp/pipeline/wp-kit-plan.yaml):
  // stage CỔNG DUYỆT CỦA NGƯỜI trước "Đóng gói comp" — agent CHỈ ĐỌC (docs +
  // criteria), KHÔNG có tool Figma trong phiên, xuất kit-plan.json (máy đọc)
  // + kit-plan.md (người đọc/duyệt) theo PHÉP THỬ HAI TẦNG (mặc định KHÔNG
  // sinh — chỉ sinh khi override trên base không đạt, và gap phải nêu đích
  // danh). Cổng duyệt = thao tác bấm-tay từng stage sẵn có (run-all KHÔNG
  // dừng chờ — chấp nhận, không chế cơ chế approve mới). Cùng bất biến
  // DAEMON-ORCHESTRATED như `lab-kit`/`lab-compose` — server.ts nhận diện
  // skillId này và tự chạy runLabKitPlan (rút gọn từ runLabKit, KHÔNG Figma
  // MCP nào — Symbol INTERNAL_MCP_SERVER_IDS rỗng).
  // WP-lab-reorder (2026-08-23 — .tmp/pipeline/wp-lab-reorder.yaml): `lab-
  // kit-plan` nay đứng SAU `lab-compose` — vai trò đổi từ "đoán từ docs" (màn
  // chưa tồn tại) sang "QUÉT MÀN ĐÃ DUYỆT" (`lab-result.json` + PNG `screens/`
  // + tiền-quét `kit-candidates.json`/`kit-candidates/` của daemon, xem
  // runLabKitPlan). `dependsOn` THÊM `lab-compose` (map vẫn ưu tiên qua
  // `lab-docs` gián tiếp — xem comment lab-map) để runLabKitPlan fail-fast
  // đúng lúc khi chưa có `lab-result.json`. `outputs` THÊM
  // `kit-candidates.json`/`kit-candidates/` (tiền-quét daemon, KHÔNG phải sản
  // phẩm của agent — vẫn khai trong `outputs` vì server.ts tự ghi/dọn nó mỗi
  // lần chạy stage này, cùng cơ chế re-run-clear generic).
  {
    id: 'lab-kit-plan',
    name: 'Đề xuất kit',
    skillId: 'lab-kit-plan',
    dependsOn: ['lab-docs', 'lab-compose'],
    outputs: ['kit-plan.json', 'kit-plan.md', 'kit-candidates.json', 'kit-candidates/'],
    inputPlaceholder: 'Định hướng đề xuất (tuỳ chọn)',
    inputKind: 'prompt',
  },
  // `lab-kit` (WP-kit, 2026-08-22 — .tmp/pipeline/wp-kit.yaml): stage cuối
  // cùng của ds-lab — agent TỰ TẠO bộ component phái sinh thẩm mỹ cao hơn (từ
  // comp base + tokens.md), để designer xem được kit + re-run độc lập. Cùng
  // bất biến DAEMON-ORCHESTRATED như `lab-compose` (agent-pipeline thường bị
  // `computeEnabledMcp` cắt MCP ngoài) — server.ts nhận diện skillId này và
  // tự chạy runLabKit (nguyên khuôn runLabCompose).
  // WP-kit-regen (2026-08-22 — .tmp/pipeline/wp-kit-regen.yaml): TỪ WP NÀY
  // `kit/kit.json` là output BÌNH THƯỜNG của lab-kit, không còn "bền ngoài
  // outputs" — Chạy lại lab-kit nghĩa là GEN LẠI TỪ ĐẦU (registry cũ bị dọn
  // trước khi build brief, agent xoá sạch children trang kit rồi dựng bộ mới
  // toàn bộ), theo yêu cầu user. `patterns/` của lab-compose bên trên VẪN bền
  // ngoài outputs — ngữ nghĩa đó không đổi.
  // WP-kit-plan (2026-08-22 — .tmp/pipeline/wp-kit-plan.yaml): `dependsOn`
  // THÊM `lab-kit-plan` — lab-kit KHÔNG còn tự phân tích chọn lọc, nó DỰNG
  // ĐÚNG danh sách 'derive' đã được NGƯỜI duyệt ở kit-plan.json (fail-fast
  // nếu thiếu, xem runLabKit trong server.ts).
  // WP-lab-reorder (2026-08-23 — .tmp/pipeline/wp-lab-reorder.yaml): tên hiển
  // thị đổi "Nâng bộ comp" → "Đóng gói comp" — vai trò đổi từ "dựng comp mới
  // từ base" sang "ĐÓNG GÓI comp từ node nguồn TRONG MÀN đã duyệt
  // (componentize-in-place) + SWAP ngược instance vào màn" (id/skillId/file
  // output giữ NGUYÊN — chỉ đổi tên hiển thị + hành vi bên trong, xem
  // buildKitBrief/skills/lab-kit-compose). `dependsOn` KHÔNG đổi.
  { id: 'lab-kit',          name: 'Đóng gói comp',              skillId: 'lab-kit-compose',       dependsOn: ['lab-docs', 'lab-kit-plan'], outputs: ['kit-shots/', 'kit-result.json', 'kit/kit.json'], inputPlaceholder: 'Định hướng thẩm mỹ (tuỳ chọn)', inputKind: 'prompt' },
];

// The registry every consumer imports. Identical to `PIPELINE_DEFS_BASE`
// except each `HELD_STAGE_IDS` entry additionally carries `heldFromRun: true`
// — see `PipelineDef.heldFromRun`'s docblock for what that flag does and how
// to reopen a stage.
export const PIPELINE_DEFS: readonly PipelineDef[] = PIPELINE_DEFS_BASE.map((d) =>
  HELD_STAGE_ID_SET.has(d.id) ? { ...d, heldFromRun: true } : d,
);

// Named docs→output flows. Each is an ordered subset of PIPELINE_DEFS. The
// UI's workflow tab bar auto-hides when there is only one entry.
//
// Each pipeline id belongs to EXACTLY one workflow — `docs-to-ui` and
// `docs-to-prd` are fully independent even though `prd-docs`/`prd-cj`/
// `prd-ux-research` run the identical skills as `docs`/`cj`/`ux-research`
// (confluence-ingest / customer-journey-spec / ux-research): a project ingesting
// docs for the PRD review must not see docs-to-ui's UI-generation run as
// "already done", and vice versa — no folder, no state, no output crosses
// between them. If you add a new workflow that genuinely wants a stage's
// output reused across workflows, that is a DIFFERENT, deliberate case (like
// the retired `docs-html`/`docs-react` folder merge) — this repo has decided
// against it here on purpose, keep it that way.
// Static workflow definitions WITHOUT `stages` — `WORKFLOWS` below derives it
// from each entry's own `pipelineIds` so the two lists can never drift apart
// (no hand-duplicated id array to keep in sync).
const WORKFLOW_DEFS: ReadonlyArray<Omit<Workflow, 'stages'>> = [
  {
    id: 'docs-to-ui',
    name: 'URD/PRD → UI-Spec',
    description:
      'Product docs → UX Research (evidence-based criteria) → UX Spec → a heuristic review gate → UI-Spec: an interactive HTML prototype or a real Vite + React 19 app — pick either (or both) at the final stage.',
    pipelineIds: ['docs', 'docs-map', 'cj', 'ux-research', 'ux', 'ux-review', 'ui-html', 'ui-react', 'ui-react-ds'],
  },
  {
    id: 'docs-to-prd',
    name: 'URD/PRD → Rà soát yêu cầu',
    description:
      'Product docs → Customer Journey → UX Research → text-first PRD requirements coverage review. Any embedded mockup is illustrative only; requirements, UX research, and the Design System drive downstream design rather than copied screens. Independent of Docs → UI-Spec: its own docs/journey/research run.',
    pipelineIds: ['prd-docs', 'prd-cj', 'prd-ux-research', 'prd-review'],
  },
  {
    id: 'docs-review',
    name: 'URD/PRD → Rà soát tài liệu',
    description:
      'Độc lập hoàn toàn với Docs → UI-Spec và Docs → PRD Requirements Review: nạp tài liệu (Confluence hoặc file .md) riêng cho workflow này, đối chiếu component được khai báo trong chữ với danh mục hợp lệ, review theo bộ tiêu chí của bạn (đặt trong criteria/, tuỳ chọn — thiếu thì dùng bộ mặc định của skill) và trả về bản sao đã sửa kèm chú giải từng chỗ sửa, cùng luồng màn hình của tính năng sinh từ tài liệu (một sơ đồ SCREEN-FLOW cho designer, kèm danh sách màn hình thật sinh cùng luồng), một bản cải thiện luồng do agent đề xuất theo heuristics UX (chọn được bản nào chạy tiếp) và mockup HTML mức concept layout cho từng màn của bản đã chọn (vùng bố cục + nhãn nội dung thật, bấm chuyển màn — không map Design System). Ảnh mockup nhúng chỉ để minh hoạ, không phải hướng thiết kế.',
    // `dr-confirm` is an internal deterministic action, not a processing
    // stage. The UI exposes it as a dedicated completion CTA after every real
    // stage succeeds, so it must not appear in the stepper or Run All.
    // `dr-screens` (2026-08-27) is hidden the same way: merged into dr-flow,
    // kept as a def for manual runs when a document has no flow to draw.
    // `dr-flow-improve` (WP dr-flow-improve, 2026-08-27): optional UX pass on
    // the screen flow — in run-all.
    // WP dr-mockup (2026-08-27): `dr-comp` ("Màn hình → Component", dựng theo
    // Design System) is hidden like dr-screens — def kept for manual runs;
    // `dr-mockup` ("Mockup màn", concept-layout HTML, no DS) takes its slot.
    pipelineIds: ['dr-docs', 'dr-flow', 'dr-flow-improve', 'dr-mockup', 'dr-review'],
  },
  {
    id: 'ds-lab',
    name: 'DS → Màn hình sáng tạo (Lab)',
    description:
      // WP-lab-reorder (2026-08-23 — .tmp/pipeline/wp-lab-reorder.yaml): thứ tự
      // đảo thành lab-docs → lab-map → lab-compose → lab-kit-plan → lab-kit —
      // "Sáng tác màn" chạy NGAY sau "Bản đồ màn" (từ comp base, chưa cần
      // kit) để có màn THẬT làm bằng chứng; "Đề xuất kit" đổi vai thành QUÉT
      // MÀN ĐÃ DUYỆT (không còn đoán từ docs); "Đóng gói comp" (tên cũ "Nâng
      // bộ comp") đóng gói ĐÚNG những gì đã duyệt trên màn (componentize-in-
      // place từ node nguồn) rồi SWAP ngược instance vào màn — màn tự "chuẩn
      // hoá" thành instance kit, không phải sáng tác lại lần hai.
      'Độc lập hoàn toàn với Docs → UI-Spec, Docs → PRD Requirements Review và Docs → Rà soát tài liệu: nạp tài liệu riêng cho workflow này (lab-docs), rồi để agent CHỈ ĐỌC biên một bản đồ màn ổn định (lab-map — screen-map.json/screen-map.md, ưu tiên artifact docs-review của cùng dự án nếu có), rồi để agent Figma TOÀN QUYỀN sáng tác màn hình mới trong file Figma preview từ comp base + tokens của Design System theo đúng bản đồ (lab-compose), rồi (tuỳ chọn) để agent CHỈ ĐỌC quét màn ĐÃ DUYỆT và đề xuất comp cần đóng gói cho NGƯỜI duyệt (lab-kit-plan — kit-plan.json/kit-plan.md + kit-candidates.json daemon tự quét, không tool Figma), rồi để agent đóng gói ĐÚNG danh sách đã duyệt đó từ node nguồn trong màn + swap ngược instance vào màn (lab-kit — CHỈ trong file preview). URD chỉ cho biết màn LÀM GÌ (chức năng + nội dung thật) — ảnh mockup nhúng trong tài liệu chỉ để hiểu tính năng, không phải hướng bố cục. Kết quả của mỗi lần chạy là ảnh chụp (PNG) của từng màn (hoặc từng comp kit) agent vừa dựng trong Figma.',
    pipelineIds: ['lab-docs', 'lab-map', 'lab-compose', 'lab-kit-plan', 'lab-kit'],
  },
];

// Workflow.stages — the per-stage display-name carrier — is derived HERE from
// each workflow's OWN pipelineIds, resolving each id's human name against
// PIPELINE_DEFS (the single source of truth for a stage's name; never a
// second hand-mirrored list). An id missing from PIPELINE_DEFS falls back to
// itself so a registry typo surfaces as a raw id in the UI rather than a
// crash.
export const WORKFLOWS: readonly Workflow[] = WORKFLOW_DEFS.map((w) => ({
  ...w,
  stages: w.pipelineIds.map((id) => ({ id, name: PIPELINE_DEFS.find((d) => d.id === id)?.name ?? id })),
}));

// Folder heads of the RETIRED twin workflows (merged into docs-to-ui 2026-07).
// Old projects' outputs keep these prefixes on disk and on the media store;
// mapping them onto the merged workflow keeps their stages lighting and their
// syncExclude rules applying without any data migration.
const LEGACY_WORKFLOW_DIRS: Record<string, string> = {
  'docs-to-html': 'docs-to-ui',
  'docs-to-react': 'docs-to-ui',
};

export const DEFAULT_WORKFLOW_ID = WORKFLOWS[0]!.id;

export function getWorkflow(id: string): Workflow | undefined {
  return WORKFLOWS.find((w) => w.id === id);
}

export function getPipelineDef(id: string): PipelineDef | undefined {
  return PIPELINE_DEFS.find((p) => p.id === id);
}

function outputMatches(rel: string, pattern: string): boolean {
  if (pattern.endsWith('/')) return rel === pattern.slice(0, -1) || rel.startsWith(pattern);
  if (pattern.startsWith('*') || pattern.startsWith('-')) {
    return rel.endsWith(pattern.startsWith('*') ? pattern.slice(1) : pattern);
  }
  return rel === pattern || rel.endsWith('/' + pattern);
}

// The workflow a pipeline belongs to. Each pipeline id is in exactly one
// workflow, so this is unambiguous. Drives the per-workflow output namespace:
// a pipeline run writes under the project cwd subdirectory named after its
// workflow id (workflowDirForPipeline). Undefined for an unknown id.
export function workflowForPipeline(pipelineId: string): Workflow | undefined {
  return WORKFLOWS.find((w) => w.pipelineIds.includes(pipelineId));
}

// The cwd subdirectory a pipeline's run + outputs live under (== its workflow
// id). Pipelines outside any workflow fall back to the cwd root (null).
export function workflowDirForPipeline(pipelineId: string): string | null {
  return workflowForPipeline(pipelineId)?.id ?? null;
}

// Multi-target build subfolders (must match packages/contracts UI_TARGETS[].dir).
// Hardcoded to keep this pure registry dependency-free; a mismatch would only
// mean a target's outputs stop attributing to their stage, which the
// per-target-attribution test catches.
const UI_TARGET_DIRS = new Set(['mobile', 'web-user', 'web-backoffice']);

// Split a cwd-relative output path into [workflow, rest] when it is namespaced
// under a workflow folder (`<workflowId>/...`) — including the retired twin
// workflows' folders, which resolve to the merged workflow. A multi-target
// build nests the post-docs outputs one level deeper (`<workflowId>/<target>/…`);
// that target segment is stripped here so `<workflow>/mobile/cj/…` attributes
// to the same stage as `<workflow>/cj/…` (status, sync, and exclude all key off
// this split). Returns [undefined, rel] for a legacy unprefixed path.
function splitWorkflowPath(rel: string): [Workflow | undefined, string] {
  const slash = rel.indexOf('/');
  if (slash > 0) {
    const head = rel.slice(0, slash);
    const wf =
      WORKFLOWS.find((w) => w.id === head) ??
      (LEGACY_WORKFLOW_DIRS[head] ? getWorkflow(LEGACY_WORKFLOW_DIRS[head]!) : undefined);
    if (wf) {
      let sub = rel.slice(slash + 1);
      const nextSlash = sub.indexOf('/');
      if (nextSlash > 0 && UI_TARGET_DIRS.has(sub.slice(0, nextSlash))) {
        sub = sub.slice(nextSlash + 1);
      }
      return [wf, sub];
    }
  }
  return [undefined, rel];
}

// STORE METADATA (not pipeline outputs): published version snapshots + their
// changelog index, `project.json` — the project config Pipeline Studio writes
// at create/config time (dự án khai sinh ở studio: link Confluence + design
// system) — and `request.json`, the approval ticket a staged push leaves in
// its `pending--…` folder (kg-sync/staging.ts). None of these may light a
// stage, sync, or pull as an output. Mirrors kg-sync/published-versions.ts
// isHistoryPath (kept local here so the pure registry stays dependency-free).
export function isHistoryArtifact(rel: string): boolean {
  return (
    rel === 'changelog.json' ||
    rel === 'project.json' ||
    rel === 'request.json' ||
    rel.startsWith('_v/')
  );
}

// DOWNLOAD-READY MD EXPORTS (`exports/…`): regenerated from the local outputs
// on EVERY push (pipeline-exports.ts) and streamed as-is by Pipeline Studio.
// They are derived artifacts, not stage outputs: they must never light a
// stage, never gate, and never pull back down (each machine regenerates its
// own on push) — but unlike history metadata they DO push, bypassing any
// stage filter.
export function isExportArtifact(rel: string): boolean {
  return rel === 'exports' || rel.startsWith('exports/');
}

// EVERY pipeline whose declared outputs match this file (cwd-relative path).
// Workflow-namespaced files (`<workflowId>/...` — current or retired folder
// names) are attributed to that workflow's stages. A legacy unprefixed path
// (pre-namespacing) still matches across all stages so old projects' status
// keeps deriving.
export function stagesForOutput(rel: string): PipelineDef[] {
  // `_v/v3/docs-to-react/x-cj.json` would otherwise match the endsWith
  // patterns and mark stages done from a frozen SNAPSHOT.
  if (isHistoryArtifact(rel)) return [];
  // Derived MD exports repeat output-ish names (customer-journey.md, …) —
  // they must never attribute to (or light) a stage.
  if (isExportArtifact(rel)) return [];
  const [wf, sub] = splitWorkflowPath(rel);
  if (wf) {
    const ids = new Set(wf.pipelineIds);
    return stagesMatchingOutput(sub, (d) => ids.has(d.id));
  }
  return stagesMatchingOutput(rel, () => true);
}

// A pattern that names a FILE (exact name, `*.ext`, `-suffix`) rather than a
// folder (`comp/`, `flows/`, …). See stagesMatchingOutput.
function isExplicitOutputPattern(pattern: string): boolean {
  return !pattern.endsWith('/');
}

// WP dr-flow-result-split (2026-08-27): "khai tường minh THẮNG khai thư mục".
// Among the candidate stages (`keep` = workflow filter), a stage whose FILE
// pattern matches `rel` owns it outright; stages that only reach `rel` through
// a FOLDER pattern are dropped whenever such an explicit owner exists. This is
// what stops a stage from lighting "Xong" — or being skipped by run-all
// `skipSucceeded`, or clearing on re-run — off a sibling's file that merely
// lives inside its folder: `comp/_screens.json` is dr-flow's (dr-comp only
// declares `comp/`), `flows/SCREEN-FLOW/ux-review.json` is dr-flow-improve's
// (dr-flow only declares `flows/`). Without any explicit owner the folder
// owners are returned exactly as before, registry order preserved.
function stagesMatchingOutput(rel: string, keep: (d: PipelineDef) => boolean): PipelineDef[] {
  const explicit: PipelineDef[] = [];
  const byFolder: PipelineDef[] = [];
  for (const d of PIPELINE_DEFS) {
    if (!keep(d)) continue;
    const outputs = d.outputs ?? [];
    if (outputs.some((p) => isExplicitOutputPattern(p) && outputMatches(rel, p))) explicit.push(d);
    else if (outputs.some((p) => outputMatches(rel, p))) byFolder.push(d);
  }
  return explicit.length ? explicit : byFolder;
}

// Which pipeline owns a produced file, for manual upload stage-attribution
// (`stage` tag). First match — workflow-scoped when the path is namespaced,
// else first across all stages. Undefined → not a declared stage output.
export function stageForOutput(rel: string): PipelineDef | undefined {
  return stagesForOutput(rel)[0];
}

/** A stage that owns document-source selection. Do not infer this from the
 * presence of an input box: Lab stages also accept optional user guidance. */
export function isDocumentInputStage(def: Pick<PipelineDef, 'inputKind'> | undefined): boolean {
  return def?.inputKind === 'source';
}

/**
 * Whether at least one file in `relPaths` is a declared output of a doc-
 * INGEST stage — a `PipelineDef` with `inputKind: source`.
 * This is the single predicate the 2026-08 docs-only gate reads (see
 * `computeActive`): a workflow's other stages no longer wait on any
 * intermediate stage's run status, only on "has a document arrived".
 *
 * Reuses `stagesForOutput`'s own workflow-scoped path matching instead of
 * re-deriving an outputs allowlist a second time, so each workflow's ingest
 * outputs (`docs`'s `docs/jira/`, `docs/confluence/`, …; `dr-docs`'s `docs/`;
 * `prd-docs`'s own copies) are read LIVE off `PIPELINE_DEFS` — never
 * hardcoded here, so the check never drifts when the registry changes.
 *
 * `wfDir`, when given, additionally confines the check to files under
 * `<wfDir>/`. This matters for `stagesForOutput`'s legacy fallback: an
 * UNPREFIXED path (one under no known workflow folder) matches across every
 * workflow's stages, which would otherwise let a `docs-review/…` file "prove"
 * `docs-to-ui` is ready. Callers that already know which workflow they are
 * gating (every real caller does — see `pipeline-routes.ts`'s
 * `loadMergedState`) must pass that workflow's own directory here.
 */
export function docsReadyFromFiles(relPaths: Iterable<string>, wfDir: string | null): boolean {
  for (const rel of relPaths) {
    if (wfDir && !rel.startsWith(`${wfDir}/`)) continue;
    if (stagesForOutput(rel).some((d) => isDocumentInputStage(d))) return true;
  }
  return false;
}

/**
 * Which configured target a SINGLE-stage run builds (multi-target projects,
 * contract: RunPipelineRequest.target). Pure decision half of the daemon's
 * resolveRunTargetDir — kept here so the rules are unit-testable:
 *   no targets configured + no request  → null (single build, legacy);
 *   no targets configured + a request   → error (not a multi-target project);
 *   one target configured + no request  → that target (auto);
 *   several configured + no request     → error (caller must pick);
 *   requested not in the configured set → error.
 */
export function pickRunTarget<T extends string>(configured: readonly T[], requested: T | undefined): T | null {
  if (configured.length === 0) {
    if (requested) {
      throw new Error(
        `target "${requested}" chỉ dùng được trên dự án multi-target — dự án này chưa có targets.json (chạy bước docs với lựa chọn target trước).`,
      );
    }
    return null;
  }
  const target = requested ?? (configured.length === 1 ? configured[0]! : null);
  if (!target) {
    throw new Error(
      `Dự án này build ${configured.length} target (${configured.join(', ')}) — chỉ định target cho lần chạy stage này (CLI: --target <id>).`,
    );
  }
  if (!configured.includes(target)) {
    throw new Error(`target "${target}" không nằm trong targets.json (${configured.join(', ')}).`);
  }
  return target;
}

/** Whether a run cwd (`wfDir`, project-relative) is scoped to one multi-target
 *  subfolder (`<workflow>/<target>`), as opposed to the shared workflow root. */
export function isTargetScopedWfDir(wfDir: string | null | undefined): boolean {
  if (!wfDir) return false;
  const segments = wfDir.split('/');
  return segments.length >= 2 && UI_TARGET_DIRS.has(segments[1]!);
}

/**
 * The RE-RUN clear predicate every runner shares: should `rel` (project-cwd-
 * relative) be deleted before re-running the stages in `regenIds`?
 *
 * Ownership is path-derived (stagesForOutput) so the clear matches the
 * workflow-namespaced tree exactly and never touches upstream inputs. TARGET
 * FENCE: stagesForOutput deliberately STRIPS the multi-target segment for
 * attribution (`<wf>/mobile/ux/…` and `<wf>/web-user/ux/…` both attribute to
 * `ux`), so a target-scoped run (wfDir = `<workflow>/<target>`) must
 * additionally confine deletions to its own subtree — without the fence,
 * re-running a stage for ONE target would wipe the same stage's outputs of
 * EVERY other target.
 */
export function relClearedByRegen(
  rel: string,
  regenIds: ReadonlySet<string>,
  wfDir: string | null | undefined,
): boolean {
  if (isHistoryArtifact(rel)) return false;
  if (isTargetScopedWfDir(wfDir) && !rel.startsWith(`${wfDir}/`)) return false;
  return stagesForOutput(rel).some((d) => regenIds.has(d.id));
}

/**
 * The cwd subdirectory a stage's run + outputs live under, given the optional
 * multi-target subfolder segment (contract: RunPipelineRequest.targetDir):
 * `<workflow>` for a shared/single-build run, `<workflow>/<targetDir>` for a
 * per-target one. SINGLE SOURCE OF TRUTH for this nesting rule — `runPipeline`
 * (one stage) and `runWorkflowAll`'s clear-on-launch scope (server.ts) both
 * resolve `wfDir` THROUGH this instead of re-deriving it from
 * `workflowDirForPipeline` + `targetDir` a second time, so "this stage's
 * directory" can never drift between the two call sites.
 */
export function wfDirForStage(
  pipelineId: string,
  targetDir: string | null | undefined,
): { baseWfDir: string | null; wfDir: string | null } {
  const baseWfDir = workflowDirForPipeline(pipelineId);
  const wfDir = targetDir ? `${baseWfDir ?? ''}${baseWfDir ? '/' : ''}${targetDir}` : baseWfDir;
  return { baseWfDir, wfDir };
}

/**
 * The RUN-ALL LAUNCH clear predicate: should `rel` be deleted the instant a
 * full-workflow run starts, before its first stage runs (server.ts
 * `runWorkflowAll`)? Built on TOP of `relClearedByRegen` — same history-
 * artifact skip and same per-target fence, unchanged — plus ONE more,
 * EXPLICIT fence: when `baseWfDir` is given, `rel` must sit under
 * `${baseWfDir}/`.
 *
 * Why this extra fence can't be inferred from `relClearedByRegen` alone:
 * `stagesForOutput` (pipelines.ts) attributes a workflow-namespaced path
 * (`<workflowId>/...`) to ONLY that workflow's stages, but a path that is
 * NOT namespaced under any known workflow folder falls through to its legacy
 * branch and matches across EVERY `PIPELINE_DEFS` entry regardless of
 * workflow (kept for pre-namespacing projects — see `stagesForOutput`'s own
 * comment). `relClearedByRegen` alone has no way to tell "legitimately
 * unprefixed" apart from "prefixed under a DIFFERENT workflow's folder"; a
 * project with several parallel workflow trees (`docs-to-ui/`,
 * `docs-review/`, …) needs that distinction, because a run-all launch of one
 * workflow must never delete another workflow's tree. `baseWfDir` makes the
 * boundary explicit instead of leaning on how rarely the legacy branch is hit.
 *
 * `baseWfDir` null/empty (no workflow namespace at all — legacy project)
 * keeps `relClearedByRegen`'s own behavior unchanged.
 */
export function relClearedByRunAllLaunch(
  rel: string,
  regenIds: ReadonlySet<string>,
  wfDir: string | null | undefined,
  baseWfDir: string | null | undefined,
): boolean {
  if (!relClearedByRegen(rel, regenIds, wfDir)) return false;
  if (!baseWfDir) return true;
  return rel.startsWith(`${baseWfDir}/`);
}

/**
 * Whether a project-cwd-relative path is barred from media-store sync by its
 * stage's `syncExclude` patterns (both directions: push skip/prune AND pull
 * ignore). Workflow-namespaced paths are matched against the workflow-relative
 * remainder, mirroring stagesForOutput.
 */
export function isSyncExcluded(rel: string): boolean {
  const [wf, sub] = splitWorkflowPath(rel);
  const candidate = wf ? sub : rel;
  const defs = wf
    ? PIPELINE_DEFS.filter((d) => new Set(wf.pipelineIds).has(d.id))
    : PIPELINE_DEFS;
  return defs.some((d) => (d.syncExclude ?? []).some((p) => outputMatches(candidate, p)));
}

function statusOf(state: ProjectPipelineState, id: string): PipelineStatus {
  return state[id]?.status ?? 'idle';
}

/** Which stages a project's chain actually runs: `lean` drops every stage
 *  marked `skippedInLeanRun`, `full` runs them all. */
export type PipelineRunMode = 'full' | 'lean';

/** Whether `mode` drops this stage from the chain entirely. */
export function isStageSkipped(def: PipelineDef, mode: PipelineRunMode): boolean {
  return mode === 'lean' && def.skippedInLeanRun === true;
}

/**
 * The dependencies `mode` would have gated `def` on, back when a stage's
 * `active` flag was computed from its `dependsOn` chain. Since the 2026-08
 * docs-only gate (see `computeActive`), NOTHING reads this for gating anymore
 * — its only remaining call-site is `listPipelineStatus`, which still surfaces
 * it as an INFORMATIONAL `effectiveDependsOn` field on `PipelineView` (a lean
 * run's stepper UI uses it to explain what a skipped stage's neighbors used to
 * wait on). Kept for that display purpose and because it is still a genuinely
 * useful "what would `lean` collapse this chain to" computation; do not wire
 * it back into gating without re-reading the docs-only-gate decision this
 * module's header comment records.
 *
 * A lean run NEVER runs the `skippedInLeanRun` stages, so a naive walk of
 * `def.dependsOn` would name one of them; each skipped dependency is replaced
 * by ITS OWN dependencies, transitively, so the result never names a stage
 * that mode will never run. `full` returns the static list unchanged.
 */
export function effectiveDependsOn(def: PipelineDef, mode: PipelineRunMode = 'full'): string[] {
  if (mode === 'full') return [...def.dependsOn];
  const gates: string[] = [];
  const seen = new Set<string>([def.id]);
  const walk = (ids: readonly string[]): void => {
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const dep = PIPELINE_DEFS.find((p) => p.id === id);
      // Unknown ids stay as-is: an id we cannot resolve is not one we can prove
      // the mode skips, so it keeps gating.
      if (dep && isStageSkipped(dep, mode)) walk(dep.dependsOn);
      else gates.push(id);
    }
  };
  walk(def.dependsOn);
  return gates;
}

/**
 * The doc-ingest stage of `workflow` — the def with `inputKind: source`
 * (see `PipelineDef`; today `docs` for `docs-to-ui`, `prd-docs` for
 * `docs-to-prd`, `dr-docs` for `docs-review`). Every OTHER stage in the
 * workflow reads ITS readiness off this one stage (see `computeActive`), so
 * this lookup — never a hardcoded id table — is what lets a new workflow's
 * own ingest stage participate without a second place to update. Undefined
 * only for a malformed workflow that declares no ingest stage at all.
 */
export function ingestDefOfWorkflow(workflow: Pick<Workflow, 'pipelineIds'>): PipelineDef | undefined {
  for (const id of workflow.pipelineIds) {
    const d = getPipelineDef(id);
    if (isDocumentInputStage(d)) return d;
  }
  return undefined;
}

/**
 * Whether `def` can be run right now.
 *
 * 2026-08 product decision — THE DOCS-ONLY GATE (see this file's header
 * comment): the by-step `dependsOn` chain used to gate `active` (walk every
 * ancestor, require each `succeeded`) is GONE. The only prerequisite left is
 * "has this workflow's ingest stage produced a document" — a status-chain
 * gate blocked a user for hours on a case the chain could never see: files
 * present with no matching run record (pasted in by hand, pulled from the
 * media store onto a fresh device, or a local run record lost while its
 * output survived on disk). The source-input stage itself
 * is ALWAYS active — it is the bootstrap step, nothing gates it. Every other
 * stage in the same workflow is active the instant `ingestDefOfWorkflow`'s
 * status reads `succeeded` in `state` — OR `docsReady` says its files are on
 * disk (see below).
 *
 * `state` is trusted as given: this pure function has no file-system access,
 * so it is the CALLER's job to keep `state` true to this device's actual run
 * history — see `pipeline-routes.ts`'s `loadMergedState`, the one place that
 * builds `state` for every route calling this function.
 *
 * `docsReady` (optional, keyed by ingest `PipelineDef.id`) carries the OTHER
 * fact this gate needs: "has this workflow's ingest stage produced a
 * document on disk", straight from `docsReadyFromFiles` — see
 * `pipeline-routes.ts`'s `loadMergedState`. This is deliberately NOT folded
 * into `state[ingestId].status`: that field is also the ingest stage's
 * user-visible run status (rail / stepper), and a running or failed ingest
 * run must keep showing as running/failed there even while its OLD output
 * files (from an earlier run) already satisfy this gate for downstream
 * stages. Absent/false at a key → falls back to `state`-only, i.e. the
 * pre-`docsReady` behavior.
 *
 * `mode` and `explicitSelection` stay in the signature ONLY so every existing
 * call-site (`listPipelineStatus`, both `pipeline-routes.ts` gate checks,
 * every test importing this) keeps compiling unchanged — NEITHER parameter
 * affects the result anymore. This is not an oversight: the mode-derived /
 * explicit-selection-derived dependency chains they used to select between
 * (`effectiveDependsOn` / the now-deleted `explicitSelectionDependsOn`)
 * governed a by-step gate this function no longer computes at all.
 */
export function computeActive(
  state: ProjectPipelineState,
  def: PipelineDef,
  mode: PipelineRunMode = 'full',
  explicitSelection?: readonly string[],
  docsReady?: Readonly<Record<string, boolean>>,
): boolean {
  if (isDocumentInputStage(def)) return true;
  const wf = workflowForPipeline(def.id);
  // Hidden stage (def kept but outside every workflow's pipelineIds —
  // dr-screens, dr-comp since WP dr-mockup 2026-08-27 — for MANUAL runs):
  // no workflow to read the ingest stage from, so gate on the ingest stage
  // among its own transitive `dependsOn` (dr-comp → dr-flow → dr-docs).
  // Before this fallback a hidden stage was never active → POST /run 409.
  const ingest = wf
    ? ingestDefOfWorkflow(wf)
    : upstreamStages(def.id).map((id) => getPipelineDef(id)).find((d) => isDocumentInputStage(d));
  if (!ingest) return false;
  if (docsReady?.[ingest.id]) return true;
  return statusOf(state, ingest.id) === 'succeeded';
}

/**
 * Lựa chọn phạm vi chạy của MỘT lần run-all: từ danh sách bước ứng viên của
 * workflow (đã bỏ các terminal UI không chọn) ra danh sách bước sẽ chạy thật.
 *
 * Hai NHÁNH loại trừ nhau, và đó là toàn bộ ý nghĩa của hàm này:
 *  - `stageIds` có mặt và không rỗng → người dùng đã tick tay từng bước, nên
 *    chạy ĐÚNG các bước đó. `lean` và `skipSucceeded` bị bỏ qua: cả hai là cách
 *    SUY RA phạm vi, còn đây là phạm vi được nêu thẳng — suy tiếp trên một lựa
 *    chọn đã tường minh chỉ có thể làm nó khác đi ngoài ý muốn (tick lại một
 *    bước đã `succeeded` nghĩa là muốn CHẠY LẠI nó, không phải muốn bỏ qua nó).
 *  - vắng mặt → hành vi cũ y nguyên: `lean` bỏ các bước `skippedInLeanRun`,
 *    rồi `skipSucceeded` bỏ các bước đã xong.
 *
 * `docsFromUpload` áp cho CẢ HAI nhánh (kể cả khi người dùng tự tick đúng bước
 * ingest): output khai báo của bước ingest CHÍNH LÀ `<workflow>/docs/`, nên
 * chạy lại nó sẽ xoá sạch tài liệu người dùng vừa tải lên rồi fetch về rỗng.
 *
 * Thứ tự trả về LUÔN là thứ tự của workflow (`all`), không phải thứ tự người
 * dùng gửi — chuỗi run-all chạy tuần tự nên một thứ tự khác sẽ cho bước sau
 * chạy trước input của nó.
 */
export function selectRunStages(
  all: readonly string[],
  opts: {
    /** Bước người dùng tick tay (thứ tự gửi lên không quan trọng). */
    stageIds?: readonly string[];
    lean?: boolean;
    skipSucceeded?: boolean;
    docsFromUpload?: boolean;
    /** State đã merge — chỉ dùng cho `skipSucceeded`. */
    state?: ProjectPipelineState;
  },
): string[] {
  let stages = [...all];
  if (opts.stageIds && opts.stageIds.length > 0) {
    const picked = new Set(opts.stageIds);
    stages = stages.filter((id) => picked.has(id));
  } else {
    if (opts.lean) stages = stages.filter((id) => !getPipelineDef(id)?.skippedInLeanRun);
    if (opts.skipSucceeded) {
      const state = opts.state ?? {};
      stages = stages.filter((id) => state[id]?.status !== 'succeeded');
    }
  }
  if (opts.docsFromUpload) stages = stages.filter((id) => !getPipelineDef(id)?.acceptsUpload);
  // HELD stages never make it into a run-all plan — manual (`stageIds`) and
  // automatic (`lean`/`skipSucceeded`) branches both funnel through here, so
  // this one filter is what keeps every run-all caller (route, CLI, the
  // no-selection default) from ever spawning one. Ticking a held id by hand is
  // a route-level 400 (`pipeline-routes.ts`) BEFORE this function is even
  // called; this filter is the belt-and-suspenders guarantee that holds even
  // if a caller skips that check.
  stages = stages.filter((id) => !getPipelineDef(id)?.heldFromRun);
  return stages;
}

/** Một bước được chọn mà thiếu phụ thuộc: `stage` thiếu các bước trong `missing`. */
export interface MissingStageDependency {
  stage: string;
  missing: string[];
}

/**
 * Các bước được chọn mà TÀI LIỆU của workflow đó CHƯA sẵn sàng. Rỗng = lựa
 * chọn hợp lệ.
 *
 * Vì sao luật này phải tồn tại: run-all gọi thẳng `runPipeline`, KHÔNG hỏi
 * gating (xem `runWorkflowAll` trong server.ts), nên một bước thiếu tài liệu
 * sẽ không bị chặn — nó chạy thật, đọc thư mục input rỗng, và cho ra một kết
 * quả trông như thành công. Chặn ngay lúc nhận yêu cầu rẻ hơn nhiều so với
 * một bản spec rác mà người dùng chỉ phát hiện ở bước cuối.
 *
 * 2026-08 product decision — THE DOCS-ONLY GATE (xem `computeActive`): "thiếu
 * phụ thuộc" không còn nghĩa là "một bước TRUNG GIAN trong `dependsOn` chưa
 * `succeeded`". Với mỗi id được chọn (trừ chính bước ingest — nó không bao
 * giờ thiếu gì): nếu bước INGEST của workflow đó (`ingestDefOfWorkflow`)
 * KHÔNG nằm trong `selected`, VÀ chưa `succeeded` trong `state`, VÀ
 * `opts.docsReady` không xác nhận tài liệu đã có trên đĩa cho bước ingest đó,
 * `id` thiếu ĐÚNG MỘT phụ thuộc — bước ingest, không phải bước liền trước nó
 * trong `dependsOn`.
 *
 * `opts.docsReady` (keyed theo ingest `PipelineDef.id`) là sự thật RIÊNG "tài
 * liệu có trên đĩa" — xem `docsReadyFromFiles`, nạp trong `pipeline-routes.ts`'s
 * `loadMergedState`. Nó KHÔNG được gộp vào `state[ingestId].status`: field đó
 * còn là trạng thái chạy hiển thị trên rail của chính bước ingest, nên một lượt
 * chạy ingest đang `running`/`failed` phải vẫn hiện đúng như vậy dù file cũ
 * (từ một lượt chạy trước) đã đủ để mở cổng cho các bước sau. Hàm THUẦN này chỉ
 * đọc `state`/`opts.docsReady` đã cho, giữ chúng đúng với đĩa là việc của caller.
 *
 * `mode` và `opts.explicitSelection` giữ trong chữ ký để
 * `validateRunStageSelection` và mọi test/caller hiện có không phải đổi cách
 * gọi, nhưng không còn ảnh hưởng kết quả — cùng lý do đã ghi ở `computeActive`.
 */
export function missingDependencies(
  selected: readonly string[],
  state: ProjectPipelineState,
  mode: PipelineRunMode = 'full',
  opts?: { explicitSelection?: boolean; docsReady?: Readonly<Record<string, boolean>> },
): MissingStageDependency[] {
  const picked = new Set(selected);
  const out: MissingStageDependency[] = [];
  for (const id of selected) {
    const def = getPipelineDef(id);
    if (!def) continue; // id lạ là việc của validateRunStageSelection
    if (isDocumentInputStage(def)) continue; // bước ingest không bao giờ thiếu gì.
    const wf = workflowForPipeline(id);
    const ingest = wf && ingestDefOfWorkflow(wf);
    if (!ingest) continue; // ngoài mọi workflow — không có gì để gate ở đây.
    const ready = opts?.docsReady?.[ingest.id] === true || statusOf(state, ingest.id) === 'succeeded';
    if (!picked.has(ingest.id) && !ready) {
      out.push({ stage: id, missing: [ingest.id] });
    }
  }
  return out;
}

/** Tên hiển thị của một bước (id trần khi id không có trong registry). */
function stageName(id: string): string {
  return getPipelineDef(id)?.name ?? id;
}

/**
 * Kiểm tra trọn vẹn một lựa chọn bước thủ công trước khi chạy: id phải thuộc
 * workflow đang chạy, và (2026-08 docs-only gate, xem `computeActive`) bước
 * ingest của workflow đó phải được chọn cùng hoặc tài liệu đã sẵn sàng — xem
 * `missingDependencies`. Trả về câu tiếng Việt nêu đích danh chỗ sai để route
 * trả 400 nguyên văn; lỗi luôn trỏ về bước INGEST (vd. "Tài liệu (nạp)"),
 * không bao giờ về một bước trung gian — KHÔNG còn câu "cần bước X chạy xong
 * trước" cho bước trung gian.
 *
 * `opts.mode`/`opts.explicitSelection` giữ trong chữ ký để call-site không
 * phải đổi, nhưng không còn ảnh hưởng kết quả — cùng lý do đã ghi ở
 * `computeActive`/`missingDependencies`.
 *
 * `opts.docsReady` (tuỳ chọn, keyed theo ingest `PipelineDef.id`) chuyển
 * thẳng xuống `missingDependencies` — xem hàm đó về vì sao đây là một sự thật
 * RIÊNG với `state[ingestId].status`, không phải thay thế cho nó.
 */
export function validateRunStageSelection(
  stageIds: readonly string[],
  workflowStageIds: readonly string[],
  state: ProjectPipelineState,
  opts?: {
    workflowName?: string;
    mode?: PipelineRunMode;
    explicitSelection?: boolean;
    docsReady?: Readonly<Record<string, boolean>>;
  },
): { ok: true } | { ok: false; error: string } {
  const known = new Set(workflowStageIds);
  const unknown = stageIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    const wf = opts?.workflowName ? ` "${opts.workflowName}"` : '';
    return {
      ok: false,
      error: `Các bước sau không thuộc workflow${wf}: ${unknown.map((id) => `"${id}"`).join(', ')}.`,
    };
  }
  const missing = missingDependencies(stageIds, state, opts?.mode ?? 'full', {
    ...(opts?.explicitSelection ? { explicitSelection: true } : {}),
    ...(opts?.docsReady ? { docsReady: opts.docsReady } : {}),
  });
  if (missing.length > 0) {
    return {
      ok: false,
      // `m.missing` luôn là bước INGEST của workflow (xem `missingDependencies`
      // 2026-08 docs-only gate) — không bao giờ là một bước trung gian.
      error: missing
        .map(
          (m) =>
            `Bước "${stageName(m.stage)}" cần tài liệu — chạy bước ${m.missing
              .map((dep) => `"${stageName(dep)}"`)
              .join(', ')} trước.`,
        )
        .join(' '),
    };
  }
  return { ok: true };
}

// The set of stages to CLEAR + regenerate when `pipelineId` is re-run. Without
// cascade it's just the stage itself. With cascade it also includes every stage
// that (transitively) dependsOn it — those become stale once its output changes,
// so a re-run wipes them too and they must be re-run. Returns [pipelineId, …]
// (order not significant); an unknown id yields just [pipelineId].
export function stageRegenSet(pipelineId: string, cascade: boolean): string[] {
  const set = new Set<string>([pipelineId]);
  if (cascade) {
    for (;;) {
      let grew = false;
      for (const d of PIPELINE_DEFS) {
        if (set.has(d.id)) continue;
        if (d.dependsOn.some((dep) => set.has(dep))) {
          set.add(d.id);
          grew = true;
        }
      }
      if (!grew) break;
    }
  }
  return [...set];
}

// Whether any stage (transitively) dependsOn `pipelineId` — i.e. re-running it
// can leave downstream stages stale, so the "reset downstream too" choice is
// meaningful. Terminals (ui-html / ui-react) have none.
export function hasDownstream(pipelineId: string): boolean {
  return stageRegenSet(pipelineId, true).length > 1;
}

// Every stage `pipelineId` (transitively) dependsOn — the UPSTREAM inputs it
// needs present before it runs. Excludes pipelineId itself and all downstream.
// The pre-run pull scopes to this so running a middle stage (e.g. ux-review)
// pulls only its inputs (docs/cj/ux) — never resurrects downstream UI outputs.
export function upstreamStages(pipelineId: string): string[] {
  const set = new Set<string>();
  const walk = (id: string) => {
    const d = PIPELINE_DEFS.find((p) => p.id === id);
    if (!d) return;
    for (const dep of d.dependsOn) {
      if (!set.has(dep)) {
        set.add(dep);
        walk(dep);
      }
    }
  };
  walk(pipelineId);
  return [...set];
}

// Cross-device gating: derive "done" stages from the media file store. A stage
// whose declared output file(s) exist in the store is treated as succeeded — its
// output is pullable on any device — independent of this device's local run
// metadata. We re-derive the owning stage(s) from each file's PATH (via
// stagesForOutput) rather than trusting the single `stage` tag stamped at
// upload: old stores carry tags from retired stage ids (html-docs, react-cj,
// jira-ingest, …) that no longer exist in the registry.
export function deriveStateFromKgsFiles(files: Array<Record<string, unknown>>): ProjectPipelineState {
  const state: ProjectPipelineState = {};
  for (const f of files) {
    const rel = typeof f.path === 'string' ? f.path : '';
    if (!rel) continue;
    for (const def of stagesForOutput(rel)) state[def.id] = { status: 'succeeded' };
  }
  return state;
}

// Local equivalent of deriveStateFromKgsFiles: a stage whose declared output
// file(s) exist in the project cwd is treated as succeeded. This makes the
// stepper reflect on-disk outputs directly — offline-safe (no KGS round-trip)
// and covering outputs produced/pulled locally but not yet on KGS. Paths are
// cwd-relative; `stagesForOutput` maps each to its owning stage(s) (unmatched →
// ignored, so stray files don't mark a stage done).
export function deriveStateFromLocalFiles(relPaths: string[]): ProjectPipelineState {
  const state: ProjectPipelineState = {};
  for (const rel of relPaths) {
    for (const def of stagesForOutput(rel)) state[def.id] = { status: 'succeeded' };
  }
  return state;
}

// Merge file-derived preview availability with this device's local run state.
// Files are only a compatibility signal for pulled/legacy results; they must
// never turn the current attempt green. A failed run can leave a partial file,
// and a re-run can still have preview files from an older successful attempt.
// In both cases the latest explicit run state is authoritative until that run
// itself reaches `succeeded`.
/**
 * Stages a finished run-all launch left stranded on `queued`.
 *
 * run-all marks EVERY stage it plans to run `queued` up front (clear-on-launch
 * in server.ts deletes their outputs, so "Xong" would be a lie), then runs
 * them one at a time and aborts the chain on the first failure. The stages it
 * never reached keep the `queued` row forever: no timeout reaps them (nothing
 * is running), and the web card renders `queued` with a spinner and no Run
 * button — steps that look busy, cannot be started, never move.
 *
 * Returns the planned ids still sitting on `queued`, in the planned order and
 * without duplicates, for the caller to reset to `idle`. Deliberately narrow:
 *
 *   - a stage the chain actually started (`running`) is NOT stranded — it is
 *     still going, and a single-stage trigger outside this run-all can put a
 *     stage there too;
 *   - `succeeded` / `failed` / `idle` already tell the truth;
 *   - a `queued` stage OUTSIDE `plannedStageIds` belongs to someone else's
 *     launch and is never touched.
 *
 * Pure — no db, no clock — so the decision is unit-testable without driving a
 * real workflow chain.
 */
export function strandedQueuedStages(
  state: Record<string, { status?: string } | undefined>,
  plannedStageIds: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of plannedStageIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (state[id]?.status === 'queued') out.push(id);
  }
  return out;
}

export function mergePipelineState(
  local: ProjectPipelineState,
  kgs: ProjectPipelineState,
): ProjectPipelineState {
  const merged: ProjectPipelineState = {};
  for (const def of PIPELINE_DEFS) {
    const l = local[def.id];
    const k = kgs[def.id];
    const currentAttemptIsNotSuccessful =
      l?.status === 'queued' ||
      l?.status === 'running' ||
      l?.status === 'failed' ||
      (l?.status === 'idle' && typeof l.lastRunId === 'string' && l.lastRunId.length > 0);
    if (k && currentAttemptIsNotSuccessful) {
      merged[def.id] = l;
    } else if (k) {
      merged[def.id] = { ...(l ?? {}), ...k };
    } else if (l) {
      merged[def.id] = l;
    }
  }
  return merged;
}

/**
 * The project's run mode. `savedLean` is `RunAllConfig.lean` persisted by the
 * last run-all trigger; when it is absent (legacy: runs before the mode was
 * persisted never wrote it) the mode is INFERRED from the state shape only a
 * lean chain can produce — a non-skipped stage succeeded while a lean-skipped
 * stage it (transitively) depends on never ran. Nothing but a lean run-all can
 * reach that state: the single-stage route 409s on unmet gates, and a full
 * chain runs the analysis stages before anything downstream of them.
 */
export function resolveRunMode(
  savedLean: boolean | undefined,
  state: ProjectPipelineState,
  pipelineIds: readonly string[],
): PipelineRunMode {
  // A workflow with no lean-skippable stage has no lean concept at all — the
  // saved flag is a PROJECT-level record written by whichever workflow ran
  // last, so checking it first would leak a docs-to-ui lean run into the
  // docs-to-prd tab (its analysis stages suddenly reading "Bỏ qua").
  const skipped = pipelineIds.filter((id) => getPipelineDef(id)?.skippedInLeanRun);
  if (skipped.length === 0) return 'full';
  if (savedLean !== undefined) return savedLean ? 'lean' : 'full';
  // Any analysis stage with a recorded run (running/failed/succeeded — anything
  // but untouched-idle) means the chain included it: that is a full run.
  if (skipped.some((id) => state[id] && state[id]!.status !== 'idle')) return 'full';
  const skippedSet = new Set(skipped);
  for (const id of pipelineIds) {
    if (skippedSet.has(id)) continue;
    if (state[id]?.status !== 'succeeded') continue;
    if (upstreamStages(id).some((up) => skippedSet.has(up))) return 'lean';
  }
  return 'full';
}

// Merge the static registry with this project's persisted run state into the
// client-facing view list. When `pipelineIds` is given (a workflow's ids), only
// those pipelines are returned, in the order listed (so the stepper follows the
// workflow). Otherwise every pipeline is returned in registry order.
//
// `mode` is the project's run mode (resolveRunMode): under `lean` the stages it
// drops are flagged `skipped` and the mode's gate is reported in
// `effectiveDependsOn`, so a client can never render a lock naming a stage the
// mode will never run. `dependsOn` itself stays the STATIC registry list —
// clients use its identity as structure (the stepper fuses consecutive
// pipelines sharing one list into a single option-group step), so rewriting it
// per mode fused unrelated stages into phantom "UI-Spec" groups.
//
// `explicitSelection`, when given and NON-EMPTY, is the project's saved
// `runAllConfig.stageIds` (already filtered to THIS workflow by the caller —
// see `pipeline-routes.ts`'s `GET /api/pipelines`). Historically it overrode
// `mode` for the `active` field too (via `computeActive`); since the 2026-08
// docs-only gate `computeActive` no longer reads `mode`/`explicitSelection`
// AT ALL (see its docblock) — `active` is now purely "this workflow's ingest
// stage has a document". `explicitSelection` still does ONE thing here:
//  - `skipped: true` for every stage NOT in the selection (mode-derived
//    `isStageSkipped` is bypassed entirely — the selection is a stronger,
//    more specific signal than "does this mode ever run it").
// Absent/empty → `skipped` falls back to the mode-derived `isStageSkipped`.
//
// `docsReady` (optional, keyed by ingest `PipelineDef.id`) is forwarded
// verbatim to `computeActive` for the `active` field — see that function's
// docblock for why it stays a fact SEPARATE from `state`. `status` below
// keeps reading `state[def.id].status` directly and is NEVER influenced by
// `docsReady`, so an ingest stage's own rail entry always reflects its real
// running/failed/succeeded/idle run history.
export function listPipelineStatus(
  state: ProjectPipelineState,
  pipelineIds?: readonly string[],
  mode: PipelineRunMode = 'full',
  explicitSelection?: readonly string[],
  docsReady?: Readonly<Record<string, boolean>>,
): PipelineView[] {
  const defs = pipelineIds
    ? pipelineIds.map((id) => PIPELINE_DEFS.find((p) => p.id === id)).filter((d): d is PipelineDef => !!d)
    : PIPELINE_DEFS;
  const picked =
    explicitSelection && explicitSelection.length > 0 ? new Set(explicitSelection) : undefined;
  return defs.map((def) => {
    const run = state[def.id];
    const effective = effectiveDependsOn(def, mode);
    const gateDiffers =
      effective.length !== def.dependsOn.length || effective.some((id, i) => id !== def.dependsOn[i]);
    return {
      id: def.id,
      name: def.name,
      dependsOn: [...def.dependsOn],
      ...(gateDiffers ? { effectiveDependsOn: effective } : {}),
      status: run?.status ?? 'idle',
      active: computeActive(state, def, mode, explicitSelection, docsReady),
      ...((picked ? !picked.has(def.id) : isStageSkipped(def, mode)) ? { skipped: true as const } : {}),
      // Orthogonal to `active`/`skipped`: a held stage can still be `active`
      // (docs-only gate) and still show its past `status` — `held` only tells
      // a client "don't offer Run for this one" (route also fail-closes it).
      ...(def.heldFromRun ? { held: true as const } : {}),
      ...(def.inputPlaceholder ? { inputPlaceholder: def.inputPlaceholder } : {}),
      ...(def.inputKind ? { inputKind: def.inputKind } : {}),
      ...(def.acceptsDesignSystem ? { acceptsDesignSystem: true } : {}),
      ...(def.acceptsPlatform ? { acceptsPlatform: true } : {}),
      ...(def.acceptsUpload ? { acceptsUpload: true } : {}),
      ...(def.outputs && def.outputs.length ? { outputs: [...def.outputs] } : {}),
      ...(run?.lastRunId ? { lastRunId: run.lastRunId } : {}),
      ...(run?.lastConversationId ? { lastConversationId: run.lastConversationId } : {}),
      ...(Array.isArray((run as { subConversations?: unknown })?.subConversations) &&
      (run as { subConversations: unknown[] }).subConversations.length
        ? {
            subConversations: (run as { subConversations: import('@open-design/contracts').PipelineSubConversation[] })
              .subConversations,
          }
        : {}),
      ...(run?.updatedAt ? { updatedAt: run.updatedAt } : {}),
      ...(run?.lastInput ? { lastInput: run.lastInput } : {}),
      ...(run?.lastSource ? { lastSource: run.lastSource } : {}),
      ...(run?.lastPlatform ? { lastPlatform: run.lastPlatform } : {}),
      // Only meaningful alongside a 'failed' status — setProjectPipelineStatus
      // (db.ts) clears it on any other status transition, so a stale error
      // from an earlier failed run never survives onto a later succeeded run.
      ...(run?.status === 'failed' && run.error ? { error: run.error } : {}),
      ...(run?.status === 'failed' && run.errorReportId ? { errorReportId: run.errorReportId } : {}),
      ...(run?.recovery ? { recovery: run.recovery } : {}),
    };
  });
}
