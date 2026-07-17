---
name: docs-mockup-review
description: |
  Terminal stage of the `docs-to-reviews` workflow (pipeline `review-docs`).
  Read the ingested Confluence docs (Markdown + their embedded mockup images
  under `attachments/`), the Customer Journey, and the UX Research report, then
  review EVERY mockup image against the feature text that surrounds it in its
  own doc — does the mockup actually deliver what the text describes, and does
  it hold up against usability heuristics. Produce one review report keyed by
  image (not by a generated screen — there is no UX Spec in this workflow, the
  mockups ARE the design under review). Activate when the user runs the "PRD
  Mockup Review" pipeline or asks to review a PRD's mockups / match doc text
  against its screenshots / audit a Confluence spec's images.
triggers:
  - "review mockup"
  - "review PRD"
  - "docs mockup review"
  - "match feature with mockup"
  - "review ảnh trong tài liệu"
  - "review mockup PRD"
  - "đối chiếu mockup"
od:
  mode: utility
  category: ux-research
  craft:
    requires:
      - laws-of-ux
      - heuristic-eval
---

# docs-mockup-review — review PRD mockups against their own doc text (Gate, `docs-to-reviews`)

You are the **PRD Mockup Review** stage of the `docs-to-reviews` workflow. Upstream,
`docs` ingested Confluence pages (Markdown + a copy of every embedded image under
each page's `attachments/`), `cj` authored the Customer Journey from that text, and
`ux-research` produced evidence-based UX criteria. There is no `ux`/`ux-spec` stage
in this workflow — the mockup IMAGES in the source docs are themselves the design
under review, not something this pipeline generates.

Your job is narrower than a fresh design review: the doc's author already wrote
what a screen must do (prose, right next to the image) and already drew what they
think it looks like (the mockup). You are checking those two things **agree**, and
that what they drew is itself usable.

## Workflow (do these in order)

### 0. Read the inputs (from the project cwd)

- **Docs (primary):** `./docs/confluence/**/*.md`. Each page mixes prose with
  inline `![alt](attachments/<file>)` Markdown image refs — the mockup for the
  feature described in the paragraph(s) immediately around it. A page may have
  zero, one, or several mockups (one per sub-flow/state it documents).
- **Mockup images (primary):** the actual files each `![alt](attachments/...)`
  points at, sitting in an `attachments/` folder beside the `.md` that embeds
  them. Look at the image itself — this is a vision task, not a text task; you
  cannot judge a mockup you did not open.
- **Customer Journey (context):** `./*-customer-journey.json` / `./*-cj.json` or
  under `./customer-journey/` or `./cj/`. Use stage goals and pain points to
  judge whether the mockup actually serves what its journey stage needs.
- **UX Research criteria (context, when present):** `./ux-research/report.json`
  — evidence-based criteria from the upstream stage. A mockup that violates a
  `must` criterion is a finding: name the criterion id + source in the finding's
  prose. Absent report → skip silently, do not fail the run.

If `./docs/confluence/` has no page with at least one embedded image, stop and
report that there is nothing to review — do not fabricate images or findings.

### 1. Pair each mockup with the feature text that owns it

For every embedded image in every doc page, extract the **feature text**: the
heading of the section it sits in, plus the paragraph(s) immediately before and
after the image reference in the Markdown — this is the doc author's own
description of what that screen/flow must do. Keep this excerpt short (a few
sentences) but complete enough that the "match" verdict below is defensible from
it alone.

### 2. Evaluate — adversarial, image by image

For each mockup, answer two separate questions and record both:

**(a) Feature match** — does the mockup actually show what its paired feature
text describes? Walk the text's claims one by one (fields it says must exist,
actions it says must be available, states/flows it names) and check each is
visibly present in the image. A claim the mockup doesn't show is a finding
(`kind: "mismatch"`); a mockup detail the text never mentions is worth a note
but not a violation on its own — the text is the source of truth here.

**(b) Usability heuristics** — walk the injected craft rubric (Nielsen N.1–N.10,
Norman D1–D6) against the mockup AS DRAWN, exactly like a design review: hunt
for each heuristic's failure signal, default to recording a finding when a gate
heuristic (N.5, N.3, D6 on money/data/destructive flows) shows no evidence of
compliance. Findings here are `kind: "heuristic"` and cite one heuristic id —
never an ad-hoc rule. Do not score color contrast / touch-target pixels / font
sizes from a flat mockup image unless the image resolution genuinely lets you
measure them — when unmeasurable, skip rather than guess.

For every finding capture: `kind` (`mismatch`|`heuristic`), `severity`
(`blocker`|`major`|`minor`, using the craft file's definitions for heuristic
findings; for mismatch findings use `blocker` = the mockup omits something the
text calls mandatory/required, `major` = omits something the text implies is
needed, `minor` = a naming/labeling drift), `issue`, `recommendation`, and for
heuristic findings the `heuristic` id + `source` (`nielsen`|`norman`).

Also record notable **passes** so the report is a real evaluation, not just a
bug list.

### 3. Score (apply the craft arithmetic exactly)

Per image: start 100, subtract blocker −25 / major −10 / minor −3, floor 0.
Verdict: **fail** if any blocker or score < 60; **warn** if 60–84; **pass** if
≥ 85. Project score = mean of image scores (rounded); project verdict = worst
image verdict. Show the subtraction so a reader can re-derive it.

### 4. Write the report — FILE-ONLY, under `./review/`

This is a **file-only** stage: produce files only, do **not** push anything to
KGS. Write:

1. **`./review/report.json`** — the machine-readable result, keyed by image so
   the preview can render "mockup on the left, findings on the right" per row.
   Shape:

```json
{
  "schema_version": "1.0",
  "kind": "docs-mockup-review",
  "generated_from": ["<docs md file>", "<cj file>", "<ux-research report>"],
  "summary": { "images": 0, "score": 0, "verdict": "pass|warn|fail",
               "blockers": 0, "majors": 0, "minors": 0 },
  "images": [
    {
      "id": "docs/confluence/<page>/attachments/<file>.png",
      "path": "docs/confluence/<page>/attachments/<file>.png",
      "page": "<doc page title>",
      "feature_text": "<the paired excerpt from step 1, VERBATIM>",
      "score": 0,
      "verdict": "pass|warn|fail",
      "score_math": "100 - 25(blocker) - 10(major) = 65",
      "findings": [
        {
          "kind": "mismatch|heuristic",
          "heuristic": "N.5",
          "source": "nielsen",
          "severity": "blocker|major|minor",
          "issue": "…",
          "recommendation": "…"
        }
      ],
      "passes": ["N.1", "D4"]
    }
  ]
}
```

   `id` and `path` MUST be the image's path exactly as it exists in the project
   cwd (the same string a `GET /api/projects/:id/raw/<path>` call would use) —
   this is how the preview loads the real image and how Export finds every
   file it needs to bundle. Never invent, rename, or re-encode a path.

2. **`./review/summary.md`** — a human-readable digest: the project verdict +
   score at the top, a table of images (page / score / verdict / #blockers /
   #majors), then every blocker and major listed with its recommendation. Lead
   with what must be fixed before the PRD is considered reviewed.

Keep `id` stable across re-runs (same image path → same id) so re-runs diff
cleanly and a user's manual edits to a prior report aren't orphaned by a
cosmetic path change.

## Hard rules

- Every mockup embedded anywhere under `./docs/confluence/` MUST get an entry
  in `images[]` — a review that silently skips an image is incomplete. If an
  image file referenced by the Markdown is missing from disk, still emit an
  entry for it with an empty `findings` array and a `passes` note explaining
  the file was missing (never drop it from the report).
- `feature_text` must be a real excerpt from the doc, not a paraphrase — the
  editable review UI shows it next to the image so a reviewer can verify your
  read of the text themselves.
- Cite one heuristic (N.1–N.10 / D1–D6) per `kind: "heuristic"` finding — never
  an ad-hoc rule. `kind: "mismatch"` findings cite no heuristic.
- Severity + scoring come from the `heuristic-eval` craft file for heuristic
  findings; mismatch severities follow the definitions in step 2(a) above.
- File-only: no KGS push. The pipeline syncs `./review/` like any other stage.
