---
name: ux-spec
description: |
  Generate a UX Spec (the per-screen box-text mockup data) as a JSON file for a
  pipeline project — a FILE-ONLY stage output, synced to the shared
  media-service store alongside the other docs-to-ui deliverables. This skill
  authors S_SCREEN_SPEC-shaped screens (with type/intent/actor),
  DP_UI_COMPONENT-shaped components (the fields/buttons on each screen), and
  optionally UX_PERSONA_PROFILE-shaped personas — the field names are kept
  stable for compatibility with existing consumers of this schema. Activate
  when the user asks to "design a UX spec", "tạo UX spec", "spec màn hình",
  "screen spec", or "wireframe spec" for a given project. For customer-journey
  maps (USER_FLOW + STAGE emotion curves) use the sibling
  `customer-journey-spec` skill instead.
triggers:
  - "ux spec"
  - "ux specification"
  - "screen spec"
  - "screen specification"
  - "wireframe spec"
  - "màn hình spec"
  - "spec màn"
  - "tạo ux spec"
od:
  mode: utility
  category: ux-research
---

# ux-spec — author UX Spec screens

This skill produces a JSON file of UX Spec **screens** (+ their components) as
a normal pipeline stage output — the daemon syncs it (and the wireframes/flow
files from steps 1b/1c) to the shared media-service store alongside every
other docs-to-ui deliverable; no separate push step is needed.

> Sibling skill: `customer-journey-spec` authors the Customer Journey
> (USER_FLOW + STAGE emotion curves) for `/customer-journey`. Use that one for
> journeys; use this one for screen specs. A persona can appear in either.

## When to use
- The user wants to design / generate a UX Spec (screen-by-screen) for a
  pipeline project.

## Workflow (do these in order)

### 0. Read the inputs (docs + the customer journey)
The docs→UI workflow is `docs → cj → ux`: there is NO feature-analysis step and
NO `./features/` folder — do not look for one. Your inputs are:

**Docs layouts.** App-linked projects use `./docs-feature/` as the primary source; read `./docs-app/_index.md` first only for cross-feature context, and never build screens from `./docs-app/`. When authoring flow navigation, also read `./docs-app/_index.md` and relevant pages in `./docs-app/` to establish the documented entry path; this is an exception because navigation is part of the flow deliverable. Legacy projects use `./docs/confluence/`, `./docs/jira/`, and `./docs/context/`.

**Docs (primary input):** the ingested Markdown under `./docs/` (e.g.
`./docs/confluence/**/*.md`, `./docs/jira/**/*.md`, or `./docs-feature/**/*.md`). Read these to understand the
domain and derive the screens — each doc section that needs a UI becomes a
screen. Only when no docs are present at all, take the screens from the user's
request.

> **URD/PRD visual-policy — requirements over illustrations.** Treat the
> written requirements (actors, rules, fields, actions, states, acceptance
> criteria) and any explicitly marked **flow diagram source** as the inputs to
> this UX Spec. Embedded screenshots, mockups, and UI images in URD/PRD are
> illustrative context only: do **not** open them to decide screen layout,
> component choice, visual style, hierarchy, or wireframe structure; never
> copy, trace, or "match" them. Resolve those decisions from the requirements,
> Customer Journey, UX Research, and the selected Design System instead. A
> contradiction between prose and an illustration is a documentation issue to
> flag; the prose wins. This rule does not demote a source `.drawio` flow
> diagram explicitly marked by ingest — it remains evidence for process order
> and branches, not a visual-layout reference.

**Context pages — `./docs/context/` (do NOT build from these):** link-followed
background pages. Read for domain understanding only; NEVER turn them into
screens. Every screen must come from `./docs/confluence/` (or `./docs/jira/`) —
never from `./docs/context/`.

**Customer journey (primary input, produced by the upstream `cj` stage):** the
journey file on disk — `./*-customer-journey.json` / `./*-cj.json` or under
`./customer-journey/`. Read it and let it shape the screens: every USER_FLOW
**STAGE** should be served by at least one screen, the screen ordering should
follow the journey, and each screen's spec should support that stage's intent /
pain points. Keep traceability (a screen serves a journey stage). If, unusually,
no journey file is present, derive the screens from the docs alone — do not block
or fabricate a journey.

### 0b. Target platform → every screen's `layout`
The kickoff message may name a **target platform** for this run:
- **WEBSITE** (`platform: web`) → set `layout: "web"` on EVERY screen, and spec
  web-appropriate patterns: data **tables** instead of card lists where the
  content is tabular, **sidebar or top navigation** instead of bottom tab bars,
  wider **multi-column forms**, hover-revealed row actions.

  Websites are **RESPONSIVE**: give every screen a `responsive_notes` string
  field describing how its layout adapts from desktop (~1440px) down to mobile
  (≤768px) — navigation collapse (sidebar → drawer/hamburger), tables degrading
  to cards or stacked lists, grid column count, which actions move into menus.
  The wireframe stays **desktop-first** (ONE wireframe per screen — never a
  second mobile wireframe); `responsive_notes` is the contract the UI stages
  implement the breakpoints from.
- **MOBILE** (`platform: mobile`) → set `layout: "mobile"` on every screen, with
  mobile patterns (bottom action bars, single-column forms, list rows). The app
  renders in a FIXED phone viewport — no responsive behavior, no
  `responsive_notes`.
- **No platform named** → default to `layout: "mobile"` (the legacy behavior —
  do not guess web from the docs' content).

Downstream UI-Spec stages (`ui-html`, `ui-react`) read each screen's `layout`
and render it as a phone screen or a full web page — so the value you set here
decides what the user ultimately gets.

### 0b0. System map — `./docs/system-map.json` (when present)
The `docs-map` stage classified each document by the app it describes and
recorded where flows hand off between apps. It decides your SCOPE:

- Spec screens only from documents whose `apps` include the app you are building.
- `handoffs[]` marks the seams. A flow leaving your app needs the screen that
  hands it off (a submitted state, a "chờ duyệt" state) and the screen that
  receives the result — but never the other app's own screens.
- `apps[]` with `"external": true` (an identity provider, a partner service) are
  touchpoints: spec the screen that launches or returns from them, not the
  external screens themselves.

Hand-edited by design — take its classification as decided. Absent → work from
the docs as a whole.

### 0b1. Audience (multi-target runs)
The kickoff may name an AUDIENCE alongside the platform — END CUSTOMER or
BACKOFFICE. Two web targets share the same `layout: "web"` AND the same docs
folder, so the audience is the only thing that separates them: spec ONLY the
screens the docs describe for your audience.

- **BACKOFFICE**: internal operators/admins. Dense tables over card lists, bulk
  actions, filters and saved views, audit trail / permission affordances,
  multi-column forms. Never spec end-customer marketing or onboarding screens.
- **END CUSTOMER**: the public-facing product. Never spec internal
  configuration, approval queues, or admin-only tooling.

A doc section belonging to the other audience is not yours to build. No audience
named → single build; cover the docs as a whole.

### 0b2. Read the UX Research criteria (produced by the upstream `ux-research` stage)
The docs→UI workflow runs `ux-research` BEFORE this stage; its report is at
`./ux-research/report.json` (criteria: id, statement, priority, applies_to —
journey stage/flow names, sources). Read it and author AGAINST it:

- Every `must` criterion MUST be satisfiable by the screens you design — when a
  criterion names a flow, the screens serving that flow must carry the
  components/affordances it demands (e.g. inline-validation implies per-field
  error affordances in the spec).
- Cite the criterion id in the screen's `screen_intent` rationale when it drove
  a design choice.
- `should`/`nice` criteria: apply when they don't conflict with docs/journey;
  conflicts resolve in favor of the docs (they are the requirements).

If the report is absent (stage skipped on this machine), continue without it —
do not block.

### 0b3. Read the Design System criteria — `./criteria/rules.md` + `./criteria/components.md` (when present)
When this feature's App has a Design System attached, the daemon stages that
DS's review criteria into the run cwd, as `./criteria/rules.md` and/or
`./criteria/components.md`, before this stage runs. Read whichever of the two
actually exists — **absence of either (or both) is normal, not an error**: no
linked App, an App with no DS, or a DS that hasn't generated `components.md`
yet all mean this section is a no-op. Do not block or ask for them.

- **`./criteria/components.md`** is the DS's **VALID component catalog** — spec
  only components that appear in it. Vietnamese names in the docs match by
  **MEANING**, not literal string equality (e.g. docs saying "Hộp thoại" match
  a catalog entry titled "Dialog").
- **`./criteria/catalog.md`** is the DS's full catalog and the **SOURCE OF KNOWLEDGE
  FOR COMPONENT SELECTION**. Before assigning a component to a screen role, read
  its "Dùng khi", "Khác với <component khác>", and "Không dùng khi" sections,
  plus the `## Screen scaffolding` table mapping screen-frame roles (app bar /
  bottom sheet / card / list item / button / input) to components AVAILABLE in
  this DS, including roles this DS does not provide.
- **`./criteria/examples.md`** is the index of compositions compiled from Figma
  component `_example`s. Read it to understand which components CONTAIN which
  other components — the DS's actual nesting structure.
- **`./criteria/components.md`** remains the **CLOSED** set of valid components;
  `catalog.md` explains that set and does not expand it. On conflict,
  `components.md` wins for validity; `catalog.md` wins for role selection.
- Missing either or both reference files is normal (the DS may be absent or may
  not ship a React bundle). Do not block or ask for them.
- **`./criteria/rules.md`** is **MANDATORY** when authoring screens (step 1) and
  wireframes (step 1b). This file may be hand-authored (uploaded on import) OR
  **auto-generated by the daemon** from the DS's showcase + tokens — so besides
  the UX-decision anchors below it can also carry **color/theme, typography,
  spacing, elevation/radius and component-usage** rules (anchors like
  `R-COLOR-*`, `R-TYPE-*`, `R-SPACING-*`). **Read the actual file and apply
  whatever anchors it contains; do not assume a fixed anchor set.** The anchors
  below are the common hand-authored convention — apply them WHEN PRESENT:
  - **`R-OVERLAY`** — Modal vs. Drawer vs. a dedicated page. A short, single-step
    confirmation is a Modal (`overlay_kind` / wireframe `overlay`: `"dialog"`); a
    longer form or multi-field task is a Drawer (`"drawer"`); a genuinely
    multi-step flow gets its own screen (no overlay at all).
  - **`R-FEEDBACK`** — Dialog vs. Toast vs. Alert for a system response. A
    destructive/irreversible action (delete, cancel, revoke) needs a confirming
    Dialog, never a dismissible Toast.
  - **`R-TABLE`** + **`R-TABLE-ACTION`** — every list/table screen needs a
    toolbar (search / filter / show-hide columns) and a paginated footer;
    per-row actions render inline when there are fewer than 3, and collapse
    into a menu at 3 or more.
  - **`R-BADGE`** — status badges use the 5-level semantic scale, matched to the
    actual meaning of the state (never picked for look alone).
  - **`R-HEURISTIC`** — exactly ONE Primary button per section/screen; any
    dangerous/destructive action gets an explicit warning step before it
    commits.
- When a rule DECIDES a design choice, cite its code in that screen's
  `screen_intent` — same style as citing a `ux-research` criterion id (0b2),
  e.g. "Drawer (R-OVERLAY) vì form có 8 trường." Use the
  **exact anchor as written in this DS's `rules.md`** (e.g. a color/spacing rule
  might be `R-COLOR-BRAND-PRIMARY`), not a guessed one.
- **Conflicts resolve in favor of the docs** (they are the requirements), same
  as 0b2's ux-research criteria. When a rule would push a different design than
  the docs describe, follow the docs and record the deviation in
  `screen_intent` (e.g. "Docs vẽ Modal cho luồng 3 bước — giữ theo tài liệu,
  lệch R-OVERLAY").

### 1. Generate the JSON (content only — no project_id)
Author a UX Spec file following `references/schema.md`. **Do NOT put a
`project_id` in the file** — you are authoring CONTENT only; the file already
lives inside this project's own working directory, so an embedded id would be
redundant (and stale the moment it's copied elsewhere). Key rules:
- One or more **screens** (S_SCREEN_SPEC). Each has `screen_type`,
  `screen_intent`, `primary_actor`, `layout` (see 0b), and an ordered list of
  **components** (DP_UI_COMPONENT) — the inputs/buttons/lists that render the
  box-text mockup.
- **Navigation is EXPLICIT and required**: every component that moves the user
  to another screen (button, link, list row opening a detail, …) MUST carry
  `navigates_to: "<screen-id>"` (+ `nav_type: "back"` for back/cancel/close
  actions). Viewers draw the flow diagram EXCLUSIVELY from these fields — no
  label-based guessing — so a navigating CTA without `navigates_to` shows no
  edge at all. Targets must be ids that exist in `screens`.
- Optional **personas** (UX_PERSONA_PROFILE) — shared UX context, drives the
  actor filter.
- Use stable, human-readable ids (`SCR-…`, `PRSN-…`). The same id re-pushed
  updates the same node.

Write the file under the project (e.g. `./<feature>-ux-spec.json`).
See `assets/example-ux-spec.json` for a complete, valid example.

> **Per-module fan-out.** When the docs are a multi-section tree, the daemon
> runs this skill ONCE PER top-level module and your kickoff names the module +
> its pages + tells you to write your slice to `ux/<module-key>/ux-spec.json`.
> In that case: author screens ONLY for your module, and **prefix EVERY screen
> id with `<module-key>__`** (the kickoff gives the exact prefix) so ids — and
> the `wireframes/<screen-id>.html` files that name them — never collide
> across modules. Still write each screen's wireframe + each flow's flowchart
> into the SHARED `wireframes/` and `flows/` dirs. Do NOT write the root
> `-ux-spec.json` — the daemon merges every module's screens (and reconciles
> personas + cross-module navigation). Follow the kickoff's output path + id
> prefix verbatim.

### 1b. Author one wireframe per screen (HTML)
For EVERY screen, write `./wireframes/<SCREEN-ID>.html` following
`references/wireframe.md`. The file is a self-contained HTML document: its DOM
is the layout, nested blocks preserve the real component composition,
`data-comp` records the component anchor chosen by the agent or reviewer, and
`data-nav` records the explicit destination. Agent điền `data-comp` theo hiểu
biết từ `criteria/catalog.md`; khi sinh lại một màn mà file `.html` cũ đã có
`data-comp` trên block tương ứng, PHẢI giữ nguyên giá trị đó — đó là lựa chọn
người review đã chốt qua UI gán component, agent không được ghi đè.

Read `criteria/catalog.md` for scaffolding and role selection,
`criteria/components.md` for the valid anchor set, and `criteria/examples.md`
for DS nesting examples. A reviewer-assigned `data-comp` is a contract: when
editing an existing file, do not remove it. Keep the wireframe low-fidelity,
gray and structural; do not copy brand colors, imagery, shadows, or visual
polish from the DS.

For web screens, author one desktop-first DOM tree with real `@media` rules at
834px and 390px, guided by `responsive_notes`. For overlays, keep the screen
separate and place `data-overlay` / `data-overlay-of` on `<body>`; include only
the overlay content. Copy `skills/ux-spec/assets/wireframe.css` into each
file's `<style>` and add only minimal screen-specific layout rules.

### 1c. Author one RULE FLOWCHART per user flow (`flows/<FLOW-ID>.flow.json`)
The wireframes are the SCREENS; the user flow is expressed as wireframes + a
**rule flowchart** (decision diamonds with Yes/No branches — like a classic
troubleshooting flowchart). For EVERY journey flow (each cj USER_FLOW that the
screens serve), write `./flows/<FLOW-ID>.flow.json`.

> **The documented diagram outranks your reconstruction.** When the docs embed a
> flow diagram, the ingest saved its SOURCE at
> `./docs/confluence/attachments/<name>.drawio` and marked it in the Markdown
> (`flow-diagram — nguồn sơ đồ …`). That diagram IS the specified flow: read it
> and TRANSCRIBE it. Do not redraw it from the prose, and do not drop a branch
> because the screens you designed have no home for it — a branch with nowhere
> to go is a missing screen, not a branch to delete.
>
> Read it without loading the whole XML (it is mostly geometry):
> ```bash
> grep -o 'value="[^"]*"' docs/confluence/attachments/<name>.drawio          # box + edge labels
> grep -o '<mxCell[^>]*edge="1"[^>]*>' docs/confluence/attachments/<name>.drawio  # arrows
> ```
> It maps onto this file almost one-to-one:
>
> | draw.io | `flow.json` |
> |---|---|
> | box with ≥2 outgoing labelled arrows | `{"kind": "decision"}` node |
> | the arrow's own label ("Từ 2 DN") | that edge's `label` — the CONDITION |
> | box naming a screen (`MH-DN-03`) | the matching `screens[].id` |
> | terminal box ("KẾT THÚC") | `{"kind": "end"}` node |
>
> No diagram for a flow → build it from the prose as before.

```jsonc
{
  "id": "FLOW-TRANSFER",           // stable id, FLOW-…
  "name": "Chuyển tiền nội bộ",
  "entry": "SCR-TRANSFER",          // the screen the flow starts on
  // nodes[] lists ONLY the non-screen nodes. Screens are implicit: any edge
  // endpoint that matches a spec screen id IS that screen (the viewer renders
  // its wireframe thumbnail as the node).
  "nodes": [
    { "id": "D-OTP",  "kind": "decision", "label": "OTP hợp lệ?" },
    { "id": "E-DONE", "kind": "end",      "label": "Giao dịch hoàn tất" }
  ],
  "edges": [
    { "from": "SCR-TRANSFER", "to": "D-OTP",      "label": "Xác nhận chuyển" },
    { "from": "D-OTP",        "to": "E-DONE",      "label": "Yes" },
    { "from": "D-OTP",        "to": "SCR-TRANSFER","label": "No — báo lỗi tại field" }
  ]
}
```

`entry` VẪN là màn đầu tiên của feature (đây là chỗ wireframe bắt đầu). Trước
`entry`, flow PHẢI có các node điều hướng khai tường minh trong `nodes[]` với
`"kind": "nav"` và `label` là tên màn/bước điều hướng thật, ví dụ
`{"id":"NAV-HOME","kind":"nav","label":"Trang chủ"}`, nối bằng edges tới
`entry`. Node `nav` không phải màn của feature nên không có wireframe — đó là
bình thường. Chỉ thêm nav khi có căn cứ trong câu mô tả cách vào của tài liệu
feature hoặc trong `docs-app/_index.md` và các trang liên quan của `docs-app/`;
không suy đoán tên menu, không tự chế bước như "Đăng nhập". Không có căn cứ thì
bỏ hẳn phần nav và flow bắt đầu ở `entry` như cũ.

`kind` hợp lệ giờ là `decision | end | nav` (màn vẫn ngầm định).

**Nhãn không được để mã màn trần.** Người xem sơ đồ không mở tài liệu bên cạnh,
mà mã màn (`SCR-001`, `MH1`…) còn đánh lại từ đầu trong từng tài liệu URD nên
đứng một mình là vô nghĩa. Trong `label` của node `nav`/`decision`/`end` và
trong nhãn cạnh, luôn gọi TÊN màn như tài liệu đặt, mã chỉ đi kèm trong ngoặc:
`"Trên màn Danh sách Khách hàng (SCR-001), nhấn Thêm mới"` — không viết
`"Trên SCR-001, nhấn Thêm mới"`. (`screens[].id` vẫn là mã như bình thường:
khung nhìn tự tra `screens[].name` để hiện tên, nên `name` phải là tên thật của
màn, không phải chép lại mã.)

Rules:
- **Every screen referenced must exist in the spec** (`screens[].id`) — the
  flowchart joins wireframes by id, a dangling id renders as a hole.
- **Every decision node has ≥ 2 labeled outgoing edges** (Yes/No or the actual
  conditions). A decision with one branch is not a decision.
- **Edge labels leaving a SCREEN name the user ACTION** on that screen ("Xác
  nhận chuyển", "Bỏ qua") — the same wording the screen's component
  `navigates_to` action uses. Downstream `ui-react` reuses these labels 1:1 as
  `data-flow-action` values, which is what makes the built app's flow.json,
  the simulator, and the Playwright demo line up with this chart.
- Keep `navigates_to` on components authoritative for plain screen→screen
  navigation; the flow file ADDS the rule layer (conditions, ends) on top —
  don't contradict it.

### 2. Nothing further to do — the stage output syncs automatically
The JSON file (+ `wireframes/` + `flows/`) is a normal stage output: once the
run finishes, the daemon's file sync (manual upload button, or push-all)
carries it to the shared media-service store like every other docs-to-ui
deliverable. There is no separate push step and no project id to fill in.

## Field reference
Field names (`S_SCREEN_SPEC`-shaped screens, `DP_UI_COMPONENT`-shaped
components, `UX_PERSONA_PROFILE`-shaped personas) are kept stable for
compatibility with existing consumers of this schema. Full field reference:
`references/schema.md`.

## Hard rules
- **Docs are the source of truth; a flow diagram is the flow.** Where the ingest
  saved a `.drawio` (§1c), the flowchart transcribes it — screens exist to serve
  the documented flow, not the other way round. Inventing a branch the documents
  never specified, or silently dropping one they do, corrupts every stage built
  on this one.
- **Never put `project_id` in the file.** The file already lives inside this
  project's own working directory; an embedded id would be redundant.
- **Components link to their screen by the `screen_id` PROP**, not a graph edge.
