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
back to the mcp-atlassian server entry in the nearest .od/mcp-config.json.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request


def find_creds():
    base = os.environ.get("CONFLUENCE_URL")
    token = os.environ.get("CONFLUENCE_PERSONAL_TOKEN")
    if base and token:
        return base.rstrip("/"), token
    here = os.getcwd()
    for _ in range(8):
        cfg = os.path.join(here, ".od", "mcp-config.json")
        if os.path.isfile(cfg):
            try:
                data = json.load(open(cfg, encoding="utf-8"))
                for s in data.get("servers", []):
                    env = s.get("env", {}) or {}
                    if env.get("CONFLUENCE_URL") and env.get("CONFLUENCE_PERSONAL_TOKEN"):
                        return env["CONFLUENCE_URL"].rstrip("/"), env["CONFLUENCE_PERSONAL_TOKEN"]
            except Exception:
                pass
        parent = os.path.dirname(here)
        if parent == here:
            break
        here = parent
    sys.exit("Missing CONFLUENCE_URL / CONFLUENCE_PERSONAL_TOKEN (set env or provide .od/mcp-config.json)")


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
        # stdlib fallback (lower fidelity) if html2text is unavailable
        text = re.sub(r"(?s)<(script|style).*?</\1>", "", html)
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

    for meta in targets:
        pid = str(meta["id"])
        full = fetch_page(base, token, pid)  # ensure body present (+ ancestors)
        title = full.get("title", meta.get("title", pid))
        md = html_to_md(body_html(full))
        folders = rel_folders(full, root_id)
        target_dir = os.path.join(out_dir, *folders) if folders else out_dir
        os.makedirs(target_dir, exist_ok=True)
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
        written.append({"id": pid, "title": title, "path": fp})
        if not as_json:
            print(f"✅ {fp}")

    if as_json:
        print(json.dumps({"root": root_id, "count": len(written), "files": written}, ensure_ascii=False, indent=2))
    else:
        print(f"\n✅ Exported {len(written)} page(s) into {out_dir}/ (root + {len(descendants)} descendant pages, no nesting missed).")


if __name__ == "__main__":
    main()
