---
name: confluence-ingest
description: |
  Pipeline P1 (docs → markdown). Confluence is the only source: the daemon
  fetches every page DETERMINISTICALLY (no agent, no MCP) as soon as a run
  starts, and writes `./docs/confluence/` (+ `./docs/context/` for pages
  linked from a seed). This skill activates only for the rare case where a
  run is seeded manually in chat rather than through the Pipelines UI, or to
  export a Confluence page tree by hand via the bundled script. Activate when
  the user asks to "pull confluence docs", "kéo tài liệu confluence",
  "ingest docs", "export confluence page tree".
triggers:
  - "confluence ingest"
  - "pull confluence"
  - "kéo confluence"
  - "docs to md"
  - "ingest docs"
  - "lấy tài liệu confluence"
  - "pull requirements"
od:
  mode: utility
  category: requirements
---

# confluence-ingest — Confluence → Markdown (pipeline P1)

> **JIRA is no longer supported.** This pipeline used to also pull JIRA
> issues via the `mcp-atlassian` MCP server; that path was removed. The only
> supported source is a Confluence page URL/id.

> **App-pool source note:** App-pool sources do NOT go through this skill —
> the daemon copies selected pages directly into `./docs-feature/` and loads
> the full pool into `./docs-app/` (no agent is involved).

First stage of the **docs → UI** pipeline. Every later stage (customer
journey → UX → UI) reads a stable, reviewable Markdown snapshot under
`./docs/` — never live Confluence calls of its own.

## The daemon has already fetched it — you almost never need to

A Confluence page URL/id given to the **Docs → Markdown** stage is fetched by
the daemon itself, BEFORE any agent starts (`runDocsDeterministic` in
`server.ts`, no MCP, no agent). By the time you (the agent) would normally
run, `./docs/confluence/` already exists with:

- one `.md` file per page, plus `./docs/confluence/_index.md`;
- real GFM tables, draw.io macros expanded to one image PER PAGE;
- pages the seed LINKS to (depth-1, `./docs/context/`) when "follow links" was on;
- the whole page sub-tree (folder-structured) when "include descendants" was on.

**If `./docs/confluence/` already exists, read it — do not re-fetch.** In the
normal Pipelines UI flow this skill is never actually invoked as an agent
turn at all: every dispatch branch for this stage resolves deterministically
or fails fast (see `server.ts`'s `runPipeline`, the `confluence-ingest`
block). The instructions below only matter if you are asked to seed this
skill manually (chat, not the Pipelines UI).

## Confluence page trees — use the export script (do NOT hand-recurse children)

For a manual/ad-hoc export outside the daemon's own deterministic path (e.g.
exploring a page tree in chat), use the bundled script rather than paging
through `/child/page` by hand — that only returns direct children and MISSES
grandchildren. The script instead uses the CQL `ancestor=<id>` query, which
returns EVERY descendant at ANY depth in one paginated pass, then converts
each page's content to Markdown mirroring the page hierarchy as folders:

```bash
python3 scripts/confluence_export.py <page-url-or-id> --out ./docs/confluence
# e.g. python3 scripts/confluence_export.py \
#   https://wiki.servicehub.vn/spaces/CONSOC/pages/874352117/... --out ./docs/confluence
```

- **Creds**: reads `CONFLUENCE_URL` + `CONFLUENCE_PERSONAL_TOKEN` from env,
  else from `.od/confluence-config.json` (Settings → Integrations →
  Confluence) in the nearest ancestor directory — no setup.
- **Output**: `./docs/confluence/<…nested folders…>/<Page Title>.md`, each with
  frontmatter (`page_id`, `title`, `url`, `depth`). Feeds P2 exactly like the
  daemon's own deterministic fetch.
- **Images**: any `<img>` from the same Confluence host is downloaded (same
  Bearer token) into a sibling `attachments/` folder next to that page's `.md`,
  and the Markdown `![alt](...)` link is rewritten to the local relative path —
  so images survive outside a logged-in Confluence session. Images from other
  hosts (external CDNs, emoji sprites) are left as-is, untouched.
- **Conversion**: uses `html2text` (falls back to a basic tag-strip if absent);
  both paths preserve images.
- **Sanity-check the count** it prints ("Exported N page(s), M image(s)")
  against the tree you expect. If it wrote only 1 file you passed a leaf page,
  not the index — pass the index page id. `--no-root` skips the index page
  itself; `--json` emits a manifest (includes an `images` count per page).

## If you ARE seeded manually (no pre-fetched `./docs/confluence/`)

- **If the run kickoff says the source docs were "already fetched into
  ./docs/source/bas/"** (the Pipelines UI's **BAS document** picker), the
  daemon has ALREADY pulled the raw documents from the BAS KG API into
  `./docs/source/bas/`. Do NOT call any external doc API in that case — read
  every `.md` file under that folder and normalize it into `./docs/confluence/`
  (one `.md` per source doc, same frontmatter contract as above).
- **Else if given a Confluence page URL/id directly**, run
  `scripts/confluence_export.py <it>` (see the section above) rather than
  hand-recursing children.
- **Never write secrets** (tokens, Authorization headers, cookies) into any file.

## Done criteria
- `./docs/confluence/_index.md` exists and lists every pulled page.
- Tell the user how many pages were pulled and from what scope, then stop. The
  next pipeline (`cj`, Customer Journey) becomes available once this run succeeds.

## Hard rules
- Confluence is the only source — do not fabricate pages or invent content.
- Output is Markdown only — no KGS / graph writes in this stage.
- Keep credentials private; never echo the Confluence token or URLs with secrets.
