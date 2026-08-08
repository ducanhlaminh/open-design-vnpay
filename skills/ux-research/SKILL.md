---
name: ux-research
description: |
  UX Research stage of the docs-to-ui workflow (between `cj` and `ux`). Read the
  ingested docs + Customer Journey to identify the product's domain and key
  flows, then search the LOCAL UX knowledge base (Growth.Design case studies +
  psychology principles, NN/g article index, Baymard research index — env
  UX_KB_DIR, default ~/ux-knowledge-base) and produce an evidence-based UX
  RESEARCH REPORT: the concrete criteria this app/web must meet for good UX,
  each criterion traced to cited sources (title + URL) and illustrated with
  hotlinked Growth.Design images where available. Output:
  `./ux-research/report.json` (+ human-readable `report.md`). This is a
  RESEARCH stage: it informs the downstream `ux-spec` design; it does not
  author screens or evaluate an existing spec (that is `heuristic-eval`).
  Activate when the user runs the "UX Research" pipeline or asks for UX desk
  research / nghiên cứu UX / tiêu chí UX for a project.
triggers:
  - "ux research"
  - "ux-research"
  - "nghiên cứu ux"
  - "tiêu chí ux"
  - "ux criteria"
  - "desk research"
  - "ux best practices"
od:
  mode: utility
  category: ux-research
---

# ux-research — evidence-based UX criteria from the knowledge base

You are the **UX Research** stage of the `docs-to-ui` workflow. Upstream, `docs`
and `cj` established WHAT the product is; downstream, `ux-spec` will design the
screens. You sit in between as a **UX researcher doing desk research**: from the
domain and flows, derive the criteria a good UX must meet — each one backed by
published research, not opinion — so the UX Spec is authored against evidence.

## Knowledge base

**The kickoff message is the source of truth for WHERE the knowledge base is.**
The canonical KB lives on the MEDIA STORE (project `ux-knowledge-base`,
updated via `od kb push`); before this stage runs the daemon syncs it and
STAGES it into your working directory as **`./.ux-kb`** — the kickoff says so
("IS PRESENT at ./.ux-kb …") or states its verified absence. Use exactly the
path the kickoff gives (normally relative `./.ux-kb/...`), spend ZERO tool
calls probing for it, and never re-litigate availability. Never probe `~/…`
paths with file tools (they don't expand `~` — a past run wrongly concluded
the KB was missing this way). Only when invoked OUTSIDE the pipeline (no
kickoff directive) resolve it yourself with the shell:
`ls "${UX_KB_DIR:-$HOME/ux-knowledge-base}/data"`.

| Source | What is local | How to use |
|---|---|---|
| **Growth.Design** | 47 case studies (full markdown WITH image URLs) at `data/growth-design/case-studies/*.md`; 106 psychology principles at `data/growth-design/psychology.md` | Read locally. The ONLY source of illustration images — copy image **URLs** (hosted at `growth.design/content/...`) into the report, never download the files. |
| **NN/g** | Metadata index only (`data/nngroup/index.json`, ~1.7k articles: title/summary/URL) | Discovery via index summaries. Full text: `python3 scripts/get_nng_article.py <slug>` — **maximum 5 fetches per run** (their robots.txt enforces a 60s crawl delay; each fetch takes ~1 min). Prefer the index summary when it already supports the criterion. |
| **Baymard** | Metadata index only (`data/baymard/index.json`, 358 entries) | Link + summary ONLY. Their ToS forbids storing content — never fetch-and-save a Baymard article into any output file. |

All scripts are Python stdlib:

```bash
KB=./.ux-kb   # pipeline runs (staged by the daemon); outside the pipeline: "${UX_KB_DIR:-$HOME/ux-knowledge-base}"
python3 "$KB/scripts/search.py" onboarding checkout        # keyword search, all sources
python3 "$KB/scripts/search.py" --topic forms-input        # by topic
python3 "$KB/scripts/search.py" --topic ai-chatbots trust  # topic + keyword
```

**If the knowledge base is absent or empty** (fresh machine): do NOT fail the
stage. Produce the same report shape from your own UX fundamentals (Nielsen,
Norman, Fitts, WCAG intent), set `"knowledge_base": "unavailable"` at the report
root, leave `sources` empty per criterion, and say so in `report.md` — the
downstream stages still get criteria to follow.

## Workflow (do these in order)

### 1. Read the inputs (from the project cwd)

**Two documentation layouts.** If `./docs/_overview.md` exists: the documentation is a distilled snapshot from the App pool — read `./docs/_overview.md` first for the full picture, read `./docs/_branches/<slug>.md` for subsystem depth, and open original pages for detail using the "Page map" (paths like `./docs/<branch>/…/<page>.md`). Citations in the distilled snapshot may point to pages NOT loaded into the workspace (the user selected only part of the pool) — a missing path means that page was not selected: use the summary, do not infer further, and do not report an error. If `_overview.md` is absent: use the legacy layout (`./docs/confluence/`, `./docs/jira/`, `./docs/context/`) described below.

- **Docs (primary):** `./docs/**/*.md` — the domain, the features, constraints.
- **Customer Journey (primary):** `./*-customer-journey.json` / `./*-cj.json` or
  under `./customer-journey/`. Its STAGES are your unit of analysis: each
  stage's goal, pain points, and emotion tell you which UX topics matter.

From these, write down (for yourself): the **domain** (banking, e-commerce,
healthcare, …), the **target users**, and the **3–7 key flows** (onboarding,
form-heavy tasks, search/browse, payment, notifications, …).

### 2. Search the knowledge base per flow

For EACH key flow, run 1–2 `search.py` queries (English keywords work best:
"onboarding", "form validation", "empty state", "error message", "navigation",
"trust", "notification"). Collect the hits that actually match this product's
context. Then:

- **Growth.Design hits** → read the local case-study markdown. Note the
  psychological principles it demonstrates and pick 1–2 representative images
  (URL + what the image shows) per adopted lesson. Cross-reference
  `psychology.md` for the principle definitions.
- **NN/g hits** → use the index summary; fetch the full article (≤5 total)
  only for the criteria that carry the most weight (typically the domain's
  core flow).
- **Baymard hits** → cite title + summary + URL as-is.

Cap the research pass at roughly 30–60 minutes of work: this is a focused desk
review, not a literature survey. Prefer 8–15 strong criteria over dozens of
generic ones.

### 3. Synthesize criteria

Turn the evidence into **criteria** — concrete, checkable statements about what
this app/web must do for good UX. Rules:

- Each criterion cites **≥1 source** from step 2 (except in the no-KB fallback).
- Each criterion is **specific to this product** ("the transfer confirmation
  screen must show the fee before the final CTA"), not a generic platitude
  ("be user friendly").
- `priority`: `must` (violating it measurably loses users — cite the number
  when the source gives one), `should` (strong best practice), `nice`
  (differentiator).
- `applies_to` references **journey stage / flow names from the cj file**
  (screens do not exist yet — do NOT invent screen ids).

### 3b. Attach illustrations (when the KB is present — expected, not optional garnish)

Growth.Design case studies are FULL of screenshots (`![](https://growth.design/content/...)`
lines in each local `case-studies/*.md`). A criteria report with zero images
while the KB is present means this step was skipped — go back and do it:

- For EVERY criterion that cites a Growth.Design case study: re-open that
  case-study .md, pick **1–2 image URLs** showing the exact moment the
  criterion describes (the screenshot near the narration you quoted), and
  attach them as `{url, caption, credit}` — caption = what the reader should
  see; credit = `Growth.Design — <case study title>`.
- A criterion about a VISUAL pattern (onboarding, form, checkout, empty state,
  notification, paywall…) whose sources are only Baymard/NN·g: search the
  Growth.Design index for ONE case study demonstrating that pattern, attach
  its image, and add that case study to `references` with `used_for`.
- Images ONLY from Growth.Design (the other sources are metadata-only and
  their ToS forbid storing content). Hotlink the URL — never download files.
- Soft bar: with the KB present, aim for **at least ⅓ of criteria carrying an
  image**. Text-only criteria are fine when no case study illustrates them
  (e.g. pure API/latency rules).

### 4. Emit the outputs (FILE-ONLY stage — no KGS push)

> **Per-module fan-out.** When the docs are a multi-section tree (a sub-tree
> scan), the daemon runs this skill ONCE PER top-level module and your kickoff
> tells you to write your slice to `ux-research/<module-key>/report.json`
> instead of the top-level file. In that case: derive criteria ONLY for your
> module's pages (+ that module's customer journey), write ONLY that slice, and
> do NOT write `ux-research/report.json` — the daemon merges every module's
> slice (renumbers criteria ids globally, dedups references) into the canonical
> file. Follow the kickoff's output path verbatim when it gives one.

Write **`./ux-research/report.json`**:

```jsonc
{
  "kind": "ux-research-report",        // REQUIRED marker — previews sniff this
  "version": 1,
  "domain": "Ví điện tử / thanh toán QR",
  "knowledge_base": "ok",              // or "unavailable"
  "generated_from": { "docs": ["docs/confluence/….md"], "journey": "x-cj.json" },
  "summary": { "criteria": 12, "must": 5, "should": 5, "nice": 2 },
  "criteria": [
    {
      "id": "UXR-01",
      "title": "Inline validation trên form nhập liệu",
      "statement": "Mọi field trong form chuyển tiền phải validate inline khi blur, báo lỗi ngay tại field thay vì sau khi submit.",
      "rationale": "Baymard: 31% site thiếu inline validation; người dùng sửa lỗi nhanh hơn đáng kể khi lỗi hiện tại chỗ.",
      "priority": "must",
      "topic": "forms",
      "applies_to": ["STAGE-TRANSFER"],
      "psychology": ["Cognitive Load"],
      "sources": [
        { "source": "Baymard", "title": "Usability Testing of Inline Form Validation", "url": "https://baymard.com/blog/inline-form-validation" }
      ],
      "images": [
        { "url": "https://growth.design/content/case-studies/…/x.png",
          "caption": "Form báo lỗi ngay tại field khi blur",
          "credit": "Growth.Design — Amazon Purchase UX" }
      ]
    }
  ],
  "references": [
    { "source": "NN/g", "title": "…", "url": "https://www.nngroup.com/articles/…", "summary": "…", "used_for": ["UXR-01", "UXR-03"] }
  ]
}
```

Field notes: `criteria[].images` and `psychology` may be empty arrays;
`references` lists EVERY item you consulted (also the ones that shaped your
thinking without landing in a criterion), with `used_for` linking back to
criterion ids where applicable.

Then write **`./ux-research/report.md`** — the same content as a readable UX
researcher's report, in the language of the project docs (Vietnamese docs →
Vietnamese report): a 5–10 line executive summary, criteria grouped by topic
(embed the images with markdown `![caption](url)` + credit line under each),
and a closing reference list.

## Compliance (bake into every output)

- **Always cite source + original URL** for every piece of knowledge used.
- **Growth.Design**: image URLs and short attributed quotes are fine; do not
  republish a case study wholesale.
- **NN/g**: summaries in your own words + link; never paste article text.
- **Baymard**: link + index summary only; NEVER store fetched content.
- Images are **hotlinks** — never download image files into the project.

## Out of scope

- Do not author screens, wireframes, or components — that is `ux-spec`.
- Do not score or review an existing spec — that is `heuristic-eval`.
- Do not push anything to KGS: this is a FILE-ONLY stage; the pipeline syncs
  `./ux-research/` to the media store by itself.
