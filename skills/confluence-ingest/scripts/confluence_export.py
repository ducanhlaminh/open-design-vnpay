#!/usr/bin/env python3
"""Export a Confluence page tree to Markdown — COMPLETELY, no missed nested pages.

The flaky part of the MCP "export to md" flow is the NESTED SCAN: fetching only
direct children (`/child/page`) misses grandchildren, so you sometimes get just
the index page. This script instead uses the CQL `ancestor=<id>` query, which
returns EVERY descendant at ANY depth in one paginated pass, then downloads each
page's rendered body and converts it to Markdown, mirroring the page hierarchy
as folders.

Usage:
  python3 confluence_export.py <page-url-or-id> [--out DIR] [--no-root] [--json]

Credentials: env CONFLUENCE_URL + CONFLUENCE_PERSONAL_TOKEN; if absent, falls
back to `{ base, token }` in the nearest .od/confluence-config.json (Settings
→ Integrations → Confluence — see apps/daemon/src/confluence-config.ts).
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import unquote, urlparse


def find_creds():
    base = os.environ.get("CONFLUENCE_URL")
    token = os.environ.get("CONFLUENCE_PERSONAL_TOKEN")
    if base and token:
        return base.rstrip("/"), token
    here = os.getcwd()
    for _ in range(8):
        cfg = os.path.join(here, ".od", "confluence-config.json")
        if os.path.isfile(cfg):
            try:
                data = json.load(open(cfg, encoding="utf-8"))
                if isinstance(data, dict) and data.get("base") and data.get("token"):
                    return str(data["base"]).rstrip("/"), str(data["token"])
            except Exception:
                pass
        parent = os.path.dirname(here)
        if parent == here:
            break
        here = parent
    sys.exit("Missing CONFLUENCE_URL / CONFLUENCE_PERSONAL_TOKEN (set env or provide .od/confluence-config.json)")


def api(base, token, path, retries=3):
    url = base + path
    for attempt in range(retries):
        req = urllib.request.Request(
            url, headers={"Authorization": "Bearer " + token, "Accept": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 502, 503) and attempt < retries - 1:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise
    raise RuntimeError("unreachable")


def resolve_url(base, src):
    """Resolve a possibly-relative Confluence image src against the API base."""
    if src.startswith("http://") or src.startswith("https://"):
        return src
    if src.startswith("//"):
        return "https:" + src
    if src.startswith("/"):
        return base + src
    return base + "/" + src


def is_same_host(base, url):
    return urlparse(base).netloc == urlparse(url).netloc


def download_binary(token, url, retries=3):
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (429, 502, 503) and attempt < retries - 1:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise
    raise RuntimeError("unreachable")


def filename_from_url(url):
    name = unquote(os.path.basename(urlparse(url).path)) or "image"
    return sanitize(name)


# Match the REAL `src=` attribute, NOT `data-image-src=`. Confluence renders an
# embedded screenshot as `<img … src="/download/attachments/…" data-image-src=
# "/download/attachments/…">` (that shape appears in `body.view`, which this
# script falls back to when `export_view` is empty). A GREEDY `[^>]*` lets
# `\bsrc=` bind to the LAST occurrence — `data-image-src` — so localization
# rewrote the data attribute and left the real src pointing at an
# authenticated Confluence URL: the image downloaded, then rendered nowhere.
# Non-greedy plus a negative lookbehind (`src` not preceded by `-`/word char)
# binds to the real, first `src`.
# The daemon's deterministic path carries the same fix in bas-client.ts's
# IMG_SRC_RE — keep the two in step.
IMG_SRC_RE = re.compile(r'(<img\b[^>]*?(?<![-\w])src=["\'])([^"\']+)(["\'])', re.IGNORECASE)


def localize_images(base, token, html, attachments_dir, rel_prefix, page_label=""):
    """Download every same-host <img src> referenced in html into
    attachments_dir and rewrite src to a path relative to the page's .md
    file, so the exported Markdown carries real images instead of
    Confluence-authenticated URLs that break outside a logged-in session."""
    if not html:
        return html, 0
    downloaded = {}
    count = 0
    seen_tags = 0
    other_host = 0
    data_uri = 0
    failed = 0

    def repl(m):
        nonlocal count, seen_tags, other_host, data_uri, failed
        seen_tags += 1
        prefix, src, suffix = m.group(1), m.group(2), m.group(3)
        if src.startswith("data:"):
            data_uri += 1
            return m.group(0)
        url = resolve_url(base, src)
        if not is_same_host(base, url):
            other_host += 1
            return m.group(0)
        if url in downloaded:
            return f"{prefix}{rel_prefix}/{downloaded[url]}{suffix}"
        try:
            data = download_binary(token, url)
        except Exception as e:
            failed += 1
            print(f"  ! image download failed ({url}): {e}", file=sys.stderr)
            return m.group(0)
        name = filename_from_url(url)
        candidate, n = name, 1
        os.makedirs(attachments_dir, exist_ok=True)
        while os.path.exists(os.path.join(attachments_dir, candidate)):
            with open(os.path.join(attachments_dir, candidate), "rb") as f:
                if f.read() == data:
                    break
            stem, ext = os.path.splitext(name)
            candidate, n = f"{stem}-{n}{ext}", n + 1
        else:
            with open(os.path.join(attachments_dir, candidate), "wb") as f:
                f.write(data)
            count += 1
        downloaded[url] = candidate
        return f"{prefix}{rel_prefix}/{candidate}{suffix}"

    result = IMG_SRC_RE.sub(repl, html)
    # Diagnostics: if a page you know has images comes out with 0 downloads,
    # this line says WHY — no <img src> tags at all (export_view didn't
    # resolve the embed macro to plain HTML) vs tags found but skipped/failed.
    if seen_tags == 0 and ("<ac:image" in html or "ri:attachment" in html):
        print(
            f"  ! {page_label}: body HTML has an unresolved <ac:image>/ri:attachment "
            "macro instead of a plain <img src> — export_view/view did not render "
            "the embedded image; nothing to download.",
            file=sys.stderr,
        )
    elif seen_tags > 0:
        print(
            f"  [images] {page_label}: {seen_tags} <img> tag(s) seen, "
            f"{count} downloaded, {other_host} other-host, {data_uri} data-uri, {failed} failed",
            file=sys.stderr,
        )
    return result, count


def page_id_from_arg(arg):
    if arg.isdigit():
        return arg
    for pat in (r"/pages/(\d+)", r"pageId=(\d+)", r"/(\d+)(?:/|$)"):
        m = re.search(pat, arg)
        if m:
            return m.group(1)
    sys.exit("Could not extract a Confluence page id from: " + arg)


def html_to_md(html):
    if not html:
        return ""
    try:
        import html2text

        h = html2text.HTML2Text()
        h.body_width = 0          # don't hard-wrap
        h.ignore_images = False
        h.ignore_links = False
        h.unicode_snob = True
        return h.handle(html)
    except Exception:
        # stdlib fallback (lower fidelity) if html2text is unavailable. Turn
        # <img> into Markdown image syntax BEFORE the generic tag-strip below
        # (which would otherwise drop the (already-localized) src entirely).
        def img_to_md(m):
            tag = m.group(0)
            src_m = re.search(r'src=["\']([^"\']+)["\']', tag, re.IGNORECASE)
            if not src_m:
                return ""
            alt_m = re.search(r'alt=["\']([^"\']*)["\']', tag, re.IGNORECASE)
            alt = alt_m.group(1) if alt_m else ""
            return f"![{alt}]({src_m.group(1)})"

        text = re.sub(r"<img\b[^>]*>", img_to_md, html, flags=re.IGNORECASE)
        text = re.sub(r"(?s)<(script|style).*?</\1>", "", text)
        text = re.sub(r"(?i)<br\s*/?>", "\n", text)
        text = re.sub(r"(?i)</(p|div|li|tr|h[1-6])>", "\n", text)
        text = re.sub(r"<[^>]+>", "", text)
        text = (
            text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
            .replace("&nbsp;", " ").replace("&quot;", '"')
        )
        return re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"


def sanitize(name):
    name = re.sub(r'[\\/:*?"<>|]', "-", name or "").strip()
    name = re.sub(r"\s+", " ", name)
    return (name[:120] or "untitled")


def fetch_page(base, token, pid):
    # export_view = clean rendered HTML for export; fall back to view.
    return api(base, token, f"/rest/api/content/{pid}?expand=body.export_view,body.view,ancestors,space")


def all_descendants(base, token, root_id):
    out, start, limit = [], 0, 100
    while True:
        d = api(base, token, f"/rest/api/content/search?cql=ancestor={root_id}&limit={limit}&start={start}&expand=ancestors")
        results = d.get("results", [])
        out.extend(results)
        if len(results) < limit:
            break
        start += limit
    return out


def rel_folders(page, root_id):
    """Folder path = ancestor titles AFTER the root page (mirrors the tree)."""
    anc = page.get("ancestors", []) or []
    ids = [str(a.get("id")) for a in anc]
    try:
        i = ids.index(str(root_id))
        after = anc[i + 1:]
    except ValueError:
        after = []
    return [sanitize(a.get("title", "")) for a in after]


def body_html(full):
    body = full.get("body", {}) or {}
    for key in ("export_view", "view"):
        val = (body.get(key) or {}).get("value")
        if val:
            return val
    return ""


def main():
    argv = sys.argv[1:]
    positional = [a for a in argv if not a.startswith("--")]
    if not positional:
        sys.exit("Usage: confluence_export.py <page-url-or-id> [--out DIR] [--no-root] [--json]")
    out_dir = argv[argv.index("--out") + 1] if "--out" in argv else "confluence-docs"
    include_root = "--no-root" not in argv
    as_json = "--json" in argv

    base, token = find_creds()
    root_id = page_id_from_arg(positional[0])

    root = fetch_page(base, token, root_id)
    descendants = all_descendants(base, token, root_id)

    targets = ([root] if include_root else []) + descendants
    os.makedirs(out_dir, exist_ok=True)
    written = []

    total_images = 0
    for meta in targets:
        pid = str(meta["id"])
        full = fetch_page(base, token, pid)  # ensure body present (+ ancestors)
        title = full.get("title", meta.get("title", pid))
        folders = rel_folders(full, root_id)
        target_dir = os.path.join(out_dir, *folders) if folders else out_dir
        os.makedirs(target_dir, exist_ok=True)
        html, img_count = localize_images(
            base, token, body_html(full), os.path.join(target_dir, "attachments"), "attachments",
            page_label=title,
        )
        total_images += img_count
        md = html_to_md(html)
        fp = os.path.join(target_dir, sanitize(title) + ".md")
        url = f"{base}/pages/viewpage.action?pageId={pid}"
        with open(fp, "w", encoding="utf-8") as f:
            f.write(
                "---\n"
                f"page_id: {pid}\n"
                f"title: {json.dumps(title, ensure_ascii=False)}\n"
                f"url: {url}\n"
                f"depth: {len(full.get('ancestors', []))}\n"
                "---\n\n"
                f"# {title}\n\n{md}\n"
            )
        written.append({"id": pid, "title": title, "path": fp, "images": img_count})
        if not as_json:
            suffix = f" (+{img_count} image(s))" if img_count else ""
            print(f"✅ {fp}{suffix}")

    if as_json:
        print(json.dumps(
            {"root": root_id, "count": len(written), "images": total_images, "files": written},
            ensure_ascii=False, indent=2,
        ))
    else:
        print(
            f"\n✅ Exported {len(written)} page(s) into {out_dir}/ "
            f"(root + {len(descendants)} descendant pages, {total_images} image(s), no nesting missed)."
        )


if __name__ == "__main__":
    main()
