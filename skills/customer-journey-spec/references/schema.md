# Customer Journey — JSON schema

The agent writes a JSON document of this shape. The docs→UI pipeline reads this
**FILE directly** — the open-design Customer Journey preview (`/customer-journey`)
renders it. It is NOT pushed to KGS and carries no `project_id`.

> For per-screen UX specs (screens + components on `/ux-spec`) use the sibling
> `ux-spec` skill.

## Top-level
```jsonc
{
  "journeys":  [ Journey, ... ],   // the customer journeys (required to be useful)
  "personas":  [ Persona, ... ]    // optional — shared UX context / actor filter
}
```

## Journey
```jsonc
{
  "id":           "UFLW-OWNER-REFUND",   // stable, unique
  "name":         "Hoàn tiền đơn hàng",  // shown as the journey title
  "actor_id":     "actor-owner",         // who performs it (drives the actor filter)
  "journey_mode": "to_be",               // "to_be" | "as_is"
  "goal":         "…",                   // optional
  "flow_type":    "primary",             // "primary" | "alternative" | …
  "stages":       [ Stage, ... ]         // ordered steps (nested here, not flattened)
}
```

## Stage
```jsonc
{
  "id":          "STG-REFUND-1",
  "name":        "Tìm đơn hàng cần hoàn",
  "order":       1,                    // 1-based position in the journey
  "stage_type":  "action",            // action | decision | confirmation | error | …
  "goal":        "…",
  "emotion":     "neutral",           // frustrated | anxious | neutral | satisfied | delighted
  "user_actions":     ["…"],          // what the user does
  "system_responses": ["…"],          // what the system does
  "touchpoints":      ["…"],          // screens / channels
  "pain_points":      ["…"],          // surfaced as pain markers
  "thoughts":         ["…"],          // optional inner monologue
  // BRANCHES — omit for a plain "next stage in order" step. Fill it when the
  // documented flow forks, which is what a `stage_type: "decision"` means: one
  // entry per outgoing branch, `condition` copied from the flow diagram's arrow
  // label. This is what the Flow tab draws, and what stops a downstream stage
  // from flattening three documented outcomes into one happy path.
  "next": [
    { "to": "STG-CHON-DN", "condition": "Từ 2 DN" },
    { "to": "STG-KHAI-BAO", "condition": "Chưa có DN" },
    { "to": "STG-HOME",     "condition": "Đúng 1 DN" }
  ],
  "sources": [                        // key source-text excerpts (from docs MD)
  // In the distilled layout, `file` may be `docs/<branch>/…/<page>.md`; copy the exact on-disk path.
    {
      "file":    "docs/<branch>/…/<page>.md",           // exact on-disk path; legacy may use docs/confluence/...
      "heading": "Onboarding",                         // optional section heading
      "quote":   "…short verbatim snippet from the MD…" // copied, not paraphrased
    }
  ]
}
```
- **`next[]`** is optional. Without it a journey reads as a straight line
  (stage 1 → 2 → 3 by `order`), which is right for a linear flow. With it the
  Flow tab shows the real shape: a `decision` stage fanning out to its branches,
  each labelled with the condition. `to` must be a stage id inside the SAME
  journey. When the docs embed a flow diagram, the arrows' labels ARE these
  conditions — copy them, do not invent wording.

- **`sources[]`** carries the verbatim doc text that justifies the stage. The
  Customer Journey preview reads it straight from the JSON and renders a "key
  text from MD" panel under each stage card. Keep quotes short (1–3 sentences)
  and `file` cwd-relative. Strongly recommended for every stage — it is what makes
  the journey traceable to its source docs, and it powers "Mở tài liệu nguồn".
- **`file` MUST be the SLUGIFIED path of the file as it exists on disk**, not the
  human page title. The docs ingest writes each page to a kebab-cased, deaccented
  filename (`slug(title)` — e.g. page "Đăng nhập SSO" → `docs/confluence/Dang-nhap-SSO.md`).
  Copy the path from the actual file you read under `./docs/`, verbatim — do NOT
  reconstruct it from the title. A title-cased path (spaces/diacritics) makes the
  preview's "Mở tài liệu nguồn" fail to locate the doc.
- `emotion` maps to a numeric score (1..5) automatically so the emotion curve renders.

## Persona
```jsonc
{
  "id":   "PRSN-OWNER",        // optional — auto-generated if omitted
  "name": "Chủ cửa hàng",
  "tech_savviness": "medium",  // any extra fields are kept as metadata
  "device_primary": "mobile",
  "market": "VN"
}
```
Required: `name`. Everything else is optional metadata.

## Pipeline recap
```
this JSON file  → open-design Customer Journey preview (/customer-journey) reads it directly
                → ux-spec stage reads the journeys/personas to derive screens
```
No KGS push, no Pull All — the pipeline consumes the file on disk.
