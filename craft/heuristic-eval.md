# Heuristic evaluation craft rules

The **evaluation** rubric a reviewer applies to a UX Spec / wireframe before
any pixels exist. Sibling craft files decide what a UI *emits* (`laws-of-ux.md`
— composition; `accessibility-baseline.md` — the WCAG legal floor). This file
decides how to *judge* an already-authored screen set against usability
heuristics, and hands the judgment a fixed severity + scoring model so two
reviewers grade the same spec the same way.

> Curated from the VBSP Heuristic-eval board (Phase 1): Jakob Nielsen's 10
> Usability Heuristics (NN/g, 1994/2020) and Don Norman's fundamentals from
> *The Design of Everyday Things* (1988, rev. 2013). The board's third source —
> WCAG 2.2 measurable success criteria (contrast, touch target, reflow) — is a
> RENDER-time gate and lives in `accessibility-baseline.md`; it cannot be judged
> on a wireframe (no color/pixels/DOM yet), so it is deliberately out of scope
> here. See the two-gate split: this file is **Gate 1** (judgment, wireframe);
> WCAG is **Gate 2** (measured, post-render).

## Scope and how it differs from `laws-of-ux.md`

`laws-of-ux.md` is a *generative* directive set: each law ends with a move the
code-emitting agent should make. This file is *evaluative*: each heuristic ends
with a **failure signal** — the concrete thing that, if present in the spec,
counts as a violation — plus a severity. An evaluator reads the spec, looks for
each failure signal, and records findings. It does not rewrite the UI; it
reports.

## Severity model (fixed — do not invent new levels)

| Severity | Meaning | Examples |
|---|---|---|
| **blocker** | Screen cannot ship; user is blocked, loses money/data, or cannot recover | Destructive action with no confirm; irreversible transfer with no review step; a dead-end error with no way forward |
| **major** | User can proceed but is likely to err, get lost, or distrust the app | No visible loading/progress on a slow action; primary action ambiguous; recall forced where recognition was possible |
| **minor** | Polish / friction; does not block the task | Redundant heading; slightly inconsistent label; missing shortcut for experts |

`gate` heuristics (below) escalate: an unmet gate is at least **major**, and a
gate unmet on a money/data/destructive flow is a **blocker**.

## Scoring (deterministic — apply exactly)

Per screen, start at **100** and subtract per finding: **blocker −25, major
−10, minor −3**; floor at 0. Screen verdict: **fail** if any blocker OR score <
60; **warn** if 60–84; **pass** if ≥ 85. Project verdict is the *worst* screen
verdict, and the project score is the mean of screen scores (rounded). Report
the arithmetic so a reader can re-derive it.

## Nielsen's 10 — judgment heuristics (N.1–N.10)

Each: what to check on the UX Spec / wireframe → the **failure signal** → default severity if the signal is present.

- **N.1 Visibility of system status** — every async or slow action (submit,
  fetch balance, transfer, upload) must have a defined loading / progress /
  result state. *Failure signal:* a stage whose action has no `loading`/`pending`
  state and no success/failure feedback in the spec. *Default: major.*
- **N.2 Match between system & the real world** — labels use the user's words,
  not backend/technical terms or raw error codes. *Failure signal:* a
  component label or message that surfaces a system term (`null`, `txn_id`,
  `ERR_402`, enum constant) or jargon a lay user wouldn't say. *Default: minor
  (major if it appears on an error/result screen).*
- **N.3 User control & freedom** — every screen past the entry has a visible
  way out (back / cancel / close), and any multi-step or destructive flow has an
  explicit exit before commit. *Failure signal:* a screen with no back/cancel
  affordance, or a commit step with no cancel. *Default: major.*
- **N.4 Consistency & standards** — the same concept uses the same label,
  icon, and position across screens; platform idioms are respected (iOS/Android
  nav). *Failure signal:* the same action named/placed differently on two
  screens, or a control that fights the platform idiom. *Default: minor.*
- **N.5 Error prevention** — destructive or irreversible actions are confirmed;
  inputs that can be wrong are constrained/validated before submit rather than
  after. *Failure signal:* a delete/transfer/overwrite with no confirm, or a
  free-text field for data that has a fixed set (account, amount, date) with no
  picker/validation. *Default: blocker for destructive-no-confirm, else major.*
- **N.6 Recognition rather than recall** — show choices (recent, contacts,
  saved) instead of making the user remember and retype. *Failure signal:* a
  flow that requires typing an identifier the app already knows (account no.,
  payee) with no recent/saved list offered. *Default: major.*
- **N.7 Flexibility & efficiency of use** — frequent/expert paths have a
  shortcut (autofill, saved templates, repeat-last, skip steps) without breaking
  the novice path. *Failure signal:* a high-frequency task with only the long
  linear path and no accelerator. *Default: minor.*
- **N.8 Aesthetic & minimalist design** — each screen shows only what the task
  needs; competing CTAs and decorative noise are cut. *Failure signal:* a screen
  with two+ primary CTAs of equal weight, or information/controls unrelated to
  the stage's goal. *Default: minor (major if it obscures the primary action).*
- **N.9 Help users recognise, diagnose & recover from errors** — error states
  are specified, in plain language, and each says how to recover. *Failure
  signal:* an error/failure outcome with no message, or a message that states
  the problem but not the next action. *Default: major.*
- **N.10 Help & documentation** — where a task is non-obvious, contextual help
  is reachable (tooltip, inline hint, help entry). *Failure signal:* a
  non-trivial or first-time flow with no help affordance anywhere. *Default:
  minor.*

## Norman's fundamentals — conceptual heuristics (D1–D6)

These judge the *model and flow*, which is exactly what a wireframe carries.

- **D1 Affordance** — interactive elements must be perceivably interactive
  (a control that looks like a control). *Failure signal:* a spec element that
  is tappable/actionable but typed/styled as static text or decoration.
  *Default: major.*
- **D2 Signifier** — the signal of *where* the action is must be present:
  icon + label, an obvious tap zone, a visible entry point. *Failure signal:* an
  action with no label and a non-obvious icon, or a gesture-only affordance with
  no visible signifier. *Default: major.*
- **D3 Mapping** — the relationship between a control and its effect is natural
  (order, direction, grouping match the outcome). *Failure signal:* controls
  ordered against the mental model (e.g. confirm before review), or a layout
  whose grouping implies the wrong relationship. *Default: major.*
- **D4 Feedback** — every user action produces immediate, meaningful response
  (state change, haptic, confirmation). Overlaps N.1 but is per-*action*, not
  per-*status*. *Failure signal:* a tap/submit with no defined immediate
  response in the spec. *Default: major.*
- **D5 Constraint** — the design limits wrong actions by construction (pickers
  over free text, disabled-until-valid, ranges). *Failure signal:* an input that
  permits obviously invalid entry the flow can't accept (past date, over-balance
  amount) with no constraint. *Default: major.*
- **D6 Conceptual model** — the screen sequence matches how the user thinks the
  task works (e.g. transfer = choose recipient → amount → review → done).
  *Failure signal:* a flow whose step order or grouping contradicts the
  domain's natural model, forcing the user to re-learn it. *Default: blocker if
  it derails task completion, else major.*

## Gate heuristics (escalate severity)

On money / data / destructive flows, these must hold or the finding escalates:
**N.5** (confirm destructive), **N.3** (exit before commit), **D6** (review
step before an irreversible commit). A banking transfer with no review/confirm
before send is the canonical **blocker**.

## What the evaluator must NOT do

- Do not judge color contrast, touch-target pixels, font sizes, or 200% reflow
  here — those are unmeasurable pre-render and belong to Gate 2
  (`accessibility-baseline.md`). Note them as "deferred to WCAG gate" if the
  spec hints at a risk, but do not score them.
- Do not rewrite screens or emit UI. Report findings + recommendations only.
- Do not invent heuristics outside N.1–N.10 / D1–D6. Every finding cites one.
