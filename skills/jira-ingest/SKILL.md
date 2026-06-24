---
name: jira-ingest
description: |
  Pipeline P1 (docs → markdown). Pull the requirement documents for the current
  project from Jira (and optionally Confluence) via the configured `mcp-atlassian`
  MCP server, and write each issue/page as a self-contained Markdown file with
  YAML frontmatter under `./docs/jira/`. This is the FIRST step of the docs→UI
  pipeline: its `.md` output is the only input the `feature-analysis` pipeline
  (P2) reads. Activate when the user runs the "Docs → Markdown (JIRA)" pipeline,
  or asks to "pull jira", "kéo tài liệu jira", "ingest docs", "lấy issue về md".
triggers:
  - "jira ingest"
  - "pull jira"
  - "kéo jira"
  - "docs to md"
  - "ingest docs"
  - "lấy tài liệu jira"
  - "pull requirements"
od:
  mode: utility
  category: requirements
---

# jira-ingest — Jira → Markdown (pipeline P1)

First stage of the **docs → UI** pipeline. You pull the raw requirement docs out
of Jira and freeze them as Markdown files in the project, so every later stage
(feature analysis → UX → customer journey → UI) works from a stable, reviewable
text snapshot rather than live Jira calls.

- **Source:** the `mcp-atlassian` MCP server (label "Atlassian (Jira + Confluence
  Data Center)") — already configured in this workspace. Credentials live in the
  daemon; you only call the tools.
- **Output:** one `.md` per issue under `./docs/jira/`, plus an index
  `./docs/jira/_index.md`. These are the ONLY thing P2 (`feature-analysis`) reads.
- **No KGS push here.** This stage only writes local Markdown.

## Confluence page trees — use the export script (do NOT hand-recurse children)

Confluence index pages contain nested child pages, and fetching only direct
children (`/child/page` or the MCP child tool) MISSES grandchildren — you end up
with just the index page. Use the bundled script, which enumerates EVERY
descendant via the CQL `ancestor=<id>` query (one pass, any depth) and writes
each page's content as Markdown mirroring the page hierarchy as folders:

```bash
python3 scripts/confluence_export.py <page-url-or-id> --out ./docs/confluence
# e.g. python3 scripts/confluence_export.py \
#   https://wiki.servicehub.vn/spaces/CONSOC/pages/874352117/... --out ./docs/confluence
```

- **Creds**: reads `CONFLUENCE_URL` + `CONFLUENCE_PERSONAL_TOKEN` from env, else
  from the `mcp-atlassian` entry in the nearest `.od/mcp-config.json` — no setup.
- **Output**: `./docs/confluence/<…nested folders…>/<Page Title>.md`, each with
  frontmatter (`page_id`, `title`, `url`, `depth`). Feeds P2 like the Jira `.md`.
- **Conversion**: uses `html2text` (falls back to a basic tag-strip if absent).
- **Sanity-check the count** it prints ("Exported N page(s)") against the tree you
  expect. If it wrote only 1 file you passed a leaf page, not the index — pass the
  index page id. `--no-root` skips the index page itself; `--json` emits a manifest.

## Workflow (do these in order)

### 1. Discover the Jira scope for this project
- **If the run kickoff says the source docs were "already fetched into
  ./docs/source/…"** (the Pipelines UI's Confluence or BAS source picker), the
  daemon has ALREADY pulled the raw documents from the BAS gateway into
  `./docs/source/confluence/` or `./docs/source/bas/`. Do NOT call any external
  doc API in that case — read every `.md` file under that folder and normalize
  it into the `./docs/jira/` output below (one `.md` per source doc, same
  frontmatter contract). This is the primary path for the docs→UI / docs→HTML
  pipelines.
- **Else if the kickoff includes "Input/source for this run: …"**, use that as the
  source: a Confluence page URL/id → run `scripts/confluence_export.py <it>`
  (see the Confluence section above); a JIRA project key / JQL → use it directly
  in the Jira steps below. This is the link the user typed in the Pipelines UI.
- List the available Atlassian tools first (don't assume names). Typical
  `mcp-atlassian` tools: `jira_search` (JQL), `jira_get_issue`,
  `jira_get_project_issues`, `jira_get_epic_issues`, `jira_get_issue_comments`,
  and the `confluence_*` equivalents.
- Decide the scope. Ask the user for the Jira **project key**, **epic**, or a
  **JQL** if it is not already obvious from the project name / conversation. A
  good default query is `project = <KEY> ORDER BY created ASC`; for an epic use
  `jira_get_epic_issues`.
- Keep the pull bounded (e.g. one project key or one epic). Do not dump an entire
  Jira instance.

### 2. Write one Markdown file per issue
For each issue, write `./docs/jira/<ISSUE-KEY>.md` (e.g. `./docs/jira/VNP-1234.md`)
with this exact frontmatter so P2 can parse it deterministically:

```markdown
---
key: VNP-1234
type: Story            # Epic | Story | Task | Bug | Sub-task
status: In Progress
summary: <one-line issue summary>
priority: High
assignee: <name or empty>
epic: VNP-1000         # parent epic key, or empty
parent: <parent key or empty>
labels: [checkout, payment]
url: https://jr.servicehub.vn/browse/VNP-1234
updated: 2026-06-20
---

## Description
<the issue description, converted to clean Markdown>

## Acceptance Criteria
- <criterion 1>            # extract from the AC field / description if present

## Comments (summary)
- <author>: <key point>   # only decisions/clarifications, skip noise
```

Rules:
- **Frontmatter keys above are the contract with P2 — keep them stable.** Empty is
  fine (`assignee:`), but do not rename keys.
- Convert Jira markup/ADF to readable Markdown. Strip attachments, avatars, and
  raw HTML.
- **Never write secrets** (tokens, Authorization headers, cookies) into any file.
- One file per issue; re-running overwrites the same file (idempotent by key).
- Write under `./docs/jira/` (a visible folder), not the project root.

### 3. Write the index
Write `./docs/jira/_index.md` — a table of every pulled issue
(`key | type | status | summary | epic`) plus a line `Pulled N issues from
<scope> at <timestamp>`. P2 reads this first to know the full set.

## Done criteria
- `./docs/jira/_index.md` exists and lists N issues.
- N matches the number of `<KEY>.md` files written.
- Tell the user how many issues were pulled and from what scope, then stop. The
  next pipeline (`feature-analysis`) becomes available once this run succeeds.

## Hard rules
- Source of truth is `mcp-atlassian`; do not fabricate issues or invent keys.
- Output is Markdown only — no KGS / graph writes in this stage.
- Keep credentials private; never echo the Jira token or URLs with secrets.
