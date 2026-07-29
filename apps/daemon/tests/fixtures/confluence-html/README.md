# Confluence HTML → Markdown golden fixtures

Each `.html` here models one structure class of a real `wiki.servicehub.vn`
page as Confluence's `body.export_view` ships it. `__golden__/<name>.md` is the
converter's full output for that fixture, pinned so **any** change to **any**
structure surfaces as a reviewable diff — see the header of
`tests/html-to-markdown-golden.test.ts` for why this suite exists.

Fixtures are structurally faithful but content-neutral: no customer document
text belongs in this repo.

| Fixture | Pins |
|---|---|
| `mockup-table.html` | Screenshots laid out in a 2-column table (heading + `<p><span><img></span></p>` inside a `content-wrapper` cell) — the shape a URD page uses for every mockup. The bug this suite was born from: those images vanished, so PRD Mockup Review found nothing to review. |
| `nested-list-toc.html` | The TOC macro's nested `<ul>` (a parent `<li>` holding both its link and the child list) plus an ordered list with a nested bullet list. Outline depth must survive. |
| `inline-formatting.html` | Highlight `<span>`s starting/ending **mid-word**, emphasis tags wrapping only whitespace, Latin-1 + numeric entities (Vietnamese), nested strong/em, `<u>/<s>/<sub>/<sup>`, and text containing `*` / `_`. |
| `table-complex.html` | `<br>` and bullet lists inside a cell, a literal `\|` in cell text, `colspan`/`rowspan`, and a nested table. GFM cells cannot hold a newline, so in-cell breaks travel as `<br>`. |
| `header-styled-table.html` | A header row authored as bold `<td>` (37 of 47 tables on a real URD page do this) next to a table with no header at all. Promoting the wrong row silently deletes it from the body. |
| `images.html` | Localized vs unlocalized `src`, the `data-image-src` twin attribute (binding to it leaves the real image pointing at an authenticated URL), `[`/`]` in alt text, self-closing and alt-less tags. |
| `page-structure.html` | Headings, layout `<div>` scaffolding, cross-page vs external links, blockquote, `<pre>` containing `&lt;angle brackets&gt;`, `<hr>`, and `<script>`/`<style>` that must not leak. |
| `comments-macros.html` | HTML comments and Confluence macro leftovers that carry no reader-facing text. |

## Updating a golden

```
npx vitest run html-to-markdown-golden -u
```

Then **read every line of the diff**. A golden change is a deliberate act: an
unexplained one means the converter silently lost information, which is exactly
the failure mode this suite exists to catch.
