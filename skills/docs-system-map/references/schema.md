# `docs/system-map.json` — field reference

One file per project, written by the `docs-map` stage and read by every stage
after it. Hand-editable: a human correcting a classification edits this file, and
only a re-run of `docs-map` overwrites it.

```jsonc
{
  "system": System,
  "apps": [ App, … ],
  "documents": [ Document, … ],
  "handoffs": [ Handoff, … ]
}
```

## System
```jsonc
{
  "name":    "PMKT",                    // what the docs call the whole thing
  "summary": "…"                        // 1–2 sentences, what it is and who uses it
}
```

## App
One entry per participant in the system — **including the ones this project does
not build**. An identity provider or a core banking service is part of the
system; leaving it out is what turns a map into a list of silos.

```jsonc
{
  "id":       "web-user",               // for apps THIS project builds, use the
                                        // targets.json id (mobile | web-user |
                                        // web-backoffice) so downstream stages
                                        // match on it. Otherwise a stable slug.
  "name":     "PMKT Portal",            // the name the docs use
  "audience": "user",                   // "user" | "backoffice" — omit when external
  "external": true,                     // omit/false when this project builds it
  "responsibility": "…"                 // one sentence: what this app is answerable for
}
```

## Document
Source-page entries may use paths such as `docs-feature/<branch>/…/<page>.md`; in the legacy layout, use one entry per file under `docs/confluence/` and `docs/jira/`. Context pages
(`docs/context/`) are background and never appear here.

```jsonc
{
  "file": "docs/<branch>/…/<page>.md",           // or docs-feature/<branch>/…; on-disk path, verbatim
  "apps": ["web-user"],                        // MAY list several — a doc describing an
                                               // end-to-end flow belongs to each app it
                                               // covers. `[]` = could not place it.
  "why":  "…",                                 // one sentence of evidence
  "confidence": "high"                         // "high" | "medium" | "low"
}
```

## Handoff
Where responsibility passes from one app to another. **This is the part that
makes the map describe a system rather than a set of products** — each downstream
run builds one app, and these are the only places it can see the others.

```jsonc
{
  "from":    "web-user",
  "to":      "web-backoffice",
  "trigger": "…",        // the action or event that causes the hand-off
  "data":    "…",        // what travels across
  "back":    "…",        // optional: how the result returns to `from`
      "sources": ["docs-feature/<branch>/…/<page>.md"]  // example app-linked path
}
```

A sequence diagram states these directly: its lifelines are apps and every arrow
crossing between two of them is a hand-off. Read
`docs/confluence/attachments/*.drawio` or `docs-feature/attachments/*.drawio` before inferring hand-offs from prose.

## Validation the downstream stages rely on

- every `documents[].file` exists on disk
- every app id in `documents[].apps` / `handoffs[].from|to` exists in `apps[]`
- every document under `docs/confluence/` and `docs/jira/` appears exactly once
