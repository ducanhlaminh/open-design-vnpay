---
name: docs-system-map
description: |
  Read the ingested product docs and map the SYSTEM they describe: which apps
  exist (including third-party ones the product depends on), which document
  belongs to which app, and — the part that matters most — where a flow HANDS
  OFF from one app to another. Writes `docs/system-map.json`, which the
  downstream customer-journey and ux-spec stages read so each product is built
  from its own material without losing the seams between them. Activate for
  "phân loại tài liệu", "bản đồ hệ thống", "system map", "docs classification",
  or when a docs→UI project builds more than one product from one docs folder.
triggers:
  - "system map"
  - "bản đồ hệ thống"
  - "phân loại tài liệu"
  - "docs classification"
  - "phân loại docs theo app"
od:
  mode: utility
  category: ux-research
---

# docs-system-map — one system, several apps

A docs→UI project can build several products from ONE docs folder: a customer
web app, a backoffice, a mobile app. Every stage after the ingest runs once per
product, and every one of them reads that same shared folder.

Without a map, each product's run has to guess which material is its own — and
the guesses disagree. Worse, the parts where a flow **crosses between products**
(the customer submits, an operator approves, the customer sees the result) get
dropped by both sides, because neither run owns the whole thing.

Your job is to write that map down. **You classify; you do not design.** No
screens, no journeys, no recommendations.

## The thing to get right

This is ONE system whose parts cooperate — not a pile of separate apps. A map
that only sorts documents into buckets has failed, however accurate the sorting.

Two things carry the "one system" meaning, and both are required:

1. **`apps` includes the systems you do NOT build** — the identity provider, the
   core banking service, the partner API. A flow that reaches outside the
   product is still one flow.
2. **`handoffs`** — every point where responsibility passes from one app to
   another. These are the seams. Miss them and each product reads as a closed
   world.

## Workflow

### 0. Read the inputs

**Docs layouts.** App-linked projects (app-pool source): work from `./docs-feature/` — the Confluence pages selected for THIS feature (original markdown, tree mirrors Confluence, images in `./docs-feature/attachments/`). This is your source of truth. `./docs-app/` holds the App's FULL document pool read-only for whole-App context: read `./docs-app/_index.md` first to know what exists, open individual pages only when you need cross-feature reference — never audit, fan out over, or produce deliverables from `./docs-app/`. Legacy projects instead use `./docs/confluence/`, `./docs/jira/`, `./docs/context/` as described below. Treat every `.md` under the active working folder (excluding `_index.md` and `attachments/`) as a source page.

- **Docs (source of truth):** every Markdown file under `./docs/confluence/`, `./docs/jira/`, or `./docs-feature/` is authoritative. In the legacy layout, every Markdown file under `./docs/confluence/`,
  `./docs/jira/`. Read `./docs/context/` for background only — a context page
  never becomes a document entry in the map.
- **Flow diagrams (best evidence for the seams):** the ingest saved each draw.io
  diagram's SOURCE next to its page —
  `./docs/confluence/attachments/<pageId>-<name>.drawio` or `./docs-feature/attachments/<pageId>-<name>.drawio`. A sequence diagram's
  LIFELINES are the apps, and every arrow crossing between two lifelines is a
  hand-off. Read them before inferring anything from prose:
  ```bash
  grep -o 'value="[^"]*"' docs/confluence/attachments/<file>.drawio          # box + arrow labels
  grep -o '<mxCell[^>]*edge="1"[^>]*>' docs/confluence/attachments/<file>.drawio  # arrows
  ```
- **`./targets.json`** (when present): the products this project intends to
  build. Use the ids there for apps you build (`mobile`, `web-user`,
  `web-backoffice`) so downstream stages match on them. Apps you do NOT build get
  a descriptive id and `"external": true`.

### 1. Write `./docs/system-map.json`

Full field reference: `references/schema.md`. Shape:

```jsonc
{
  "system": {
    "name": "PMKT",
    "summary": "Phần mềm kế toán cho doanh nghiệp nhỏ, đăng nhập qua ID Safe."
  },
  "apps": [
    { "id": "web-user", "name": "PMKT Portal", "audience": "user",
      "responsibility": "Đăng nhập, khai báo doanh nghiệp, không gian làm việc kế toán" },
    { "id": "web-backoffice", "name": "PMKT Admin", "audience": "backoffice",
      "responsibility": "Duyệt hồ sơ doanh nghiệp, cấu hình gói dịch vụ" },
    { "id": "idsafe", "name": "ID Safe", "external": true,
      "responsibility": "Xác thực tài khoản dùng chung hệ sinh thái VNPAY" }
  ],
  "documents": [
    { "file": "docs/confluence/2.-Dang-nhap.md", "apps": ["web-user"],
      "why": "Toàn bộ nội dung mô tả màn đăng nhập và khai báo của người dùng cuối",
      "confidence": "high" }
  ],
  "handoffs": [
    { "from": "web-user", "to": "web-backoffice",
      "trigger": "Người dùng bấm \"Lưu & Tiếp tục\" ở màn Khai báo doanh nghiệp",
      "data": "Hồ sơ doanh nghiệp chờ duyệt",
      "back": "Kết quả duyệt hiện lại ở không gian làm việc của người dùng",
      "sources": ["docs/confluence/2.-Dang-nhap.md"] }
  ]
}
```

### 2. Rules that decide whether the map is any good

- **`file` must be the on-disk path**, copied verbatim from what you read. A
  path that does not exist silently drops that document from every product.
- **A document may belong to SEVERAL apps.** `apps: ["web-user",
  "web-backoffice"]` is the right answer for a doc describing an end-to-end
  flow — do not force a single owner. Forcing one is how a seam disappears.
- **Every app named in `documents` or `handoffs` must exist in `apps`.**
- **`confidence: "low"` is a real answer.** Say so rather than guessing
  confidently; a human reads this file and fixes it.
- **Cover every document.** A doc you cannot place gets `apps: []` with a `why`
  explaining what is unclear — never omit it, or nobody will notice it was
  skipped.
- **Do not invent apps.** Only what the docs and diagrams actually name.
- **`handoffs` array order IS the business sequence.** The viewer draws a
  sequence/swimlane diagram straight from the array (arrow per entry, top to
  bottom), so list the hand-offs in the order the use case actually flows
  (e.g. mobile gửi yêu cầu → backoffice duyệt → mobile nhận kết quả), not in
  discovery order.
- Diagrams outrank prose for the ORDER and the SEAMS; prose outranks diagrams
  for rules and detail. When they disagree, say so in the `why`.

### 3. This file is meant to be edited by hand

Downstream stages read it as given. A human who disagrees with a classification
edits `docs/system-map.json` and re-runs the next stage — nothing regenerates it
until THIS stage is re-run. So: write it to be read. Keep `why` to one clear
sentence, and never leave a field as a placeholder.

## Hard rules

- **File-only.** Produce `./docs/system-map.json` and nothing else. No push, no
  KGS, no other files.
- **One map per project**, not per product — this stage runs once even when the
  project builds several.
- **Classify, do not design.** No screens, no journeys, no UX opinions. The
  stages after this one do that, and they use your map as their brief.
