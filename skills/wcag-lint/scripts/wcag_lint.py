#!/usr/bin/env python3
"""wcag_lint.py — Gate 2 static WCAG linter for the docs-to-ui terminals.

Reads the self-contained HTML the ui-html / ui-react terminals produce and
MEASURES the statically-decidable WCAG success criteria — no browser needed:

  01/02  contrast   (WCAG 1.4.3 text ≥4.5:1 / large ≥3:1; 1.4.11 non-text ≥3:1)
  04     touch      (WCAG 2.5.8 / Apple 44pt / Material 48dp) — explicit sizes
  03     color-only (WCAG 1.4.1) — heuristic
  05     text-img   (WCAG 1.4.5) — heuristic

Checks that need real layout / zoom (06 reflow, 07 200%, and touch targets with
no declared size) are NOT faked — they are emitted as `manual` items so the
report is honest about what a static pass covers.

The contrast checks are reliable because the prototypes put their palette in a
`:root` token block (`--bg/--surface/--fg/--muted/--border/--accent`) — the
convention lint-artifact.ts already enforces. We resolve those tokens + explicit
inline color pairs; anything we cannot resolve (color-mix(), cascade, inherited
colors) is skipped rather than guessed.

Usage:  python3 wcag_lint.py <ui-output-dir> [<report-path>]
        python3 wcag_lint.py --selftest
"""
import json
import os
import re
import sys

# ── WCAG contrast math (sRGB, WCAG 2.x) ──────────────────────────────────────
NAMED = {"white": (255, 255, 255), "black": (0, 0, 0),
         "transparent": None, "inherit": None, "currentcolor": None}


def parse_color(raw):
    """Return (r,g,b) or None if not a statically-resolvable opaque color."""
    if raw is None:
        return None
    s = raw.strip().lower()
    if s in NAMED:
        return NAMED[s]
    m = re.fullmatch(r"#([0-9a-f]{3})", s)
    if m:
        h = m.group(1)
        return tuple(int(c * 2, 16) for c in h)
    m = re.fullmatch(r"#([0-9a-f]{6})", s)
    if m:
        h = m.group(1)
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    m = re.fullmatch(r"#([0-9a-f]{8})", s)
    if m:  # #rrggbbaa — treat as opaque (alpha handling would need a bg stack)
        h = m.group(1)
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    m = re.fullmatch(r"rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)\s*(?:[,/]\s*([\d.%]+)\s*)?\)", s)
    if m:
        return tuple(int(round(float(m.group(i)))) for i in (1, 2, 3))
    return None  # color-mix(), hsl(), named beyond white/black → unresolved


def _lin(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb):
    r, g, b = (_lin(x) for x in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


# ── CSS token + rule extraction ──────────────────────────────────────────────
def extract_style(html):
    """All CSS text: <style> blocks joined."""
    return "\n".join(re.findall(r"<style[^>]*>(.*?)</style>", html, re.S | re.I))


def root_tokens(css):
    """Parse `:root { --x: val; }` (merge all :root blocks). One-level var()
    resolution so `--fg: var(--ink)` resolves when --ink is a literal."""
    raw = {}
    for block in re.findall(r":root\s*\{(.*?)\}", css, re.S):
        for name, val in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", block):
            raw[name.strip()] = val.strip()
    resolved = {}
    for name, val in raw.items():
        m = re.fullmatch(r"var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)", val)
        resolved[name] = raw.get(m.group(1), val).strip() if m else val
    return resolved


def token_color(tokens, *substrs):
    """First token whose name contains any of substrs and resolves to a color."""
    for name, val in tokens.items():
        low = name.lower()
        if any(s in low for s in substrs):
            c = parse_color(val)
            if c is not None:
                return name, val, c
    return None


# ── Findings ─────────────────────────────────────────────────────────────────
def finding(file, card, wcag, name, severity, **extra):
    f = {"file": file, "card": card, "wcag": wcag, "name": name, "severity": severity}
    f.update(extra)
    return f


def check_palette_contrast(file, tokens):
    out = []
    bg = token_color(tokens, "bg", "background", "surface")
    if not bg:
        return out  # no resolvable background token → cannot measure palette
    bg_name, bg_val, bg_rgb = bg
    # normal text must clear 4.5:1
    for subs, label, req, card, wcag in [
        (("fg", "text", "foreground", "ink"), "text", 4.5, "01", "1.4.3"),
        (("muted", "secondary", "subtle"), "muted text", 4.5, "01", "1.4.3"),
    ]:
        t = token_color(tokens, *subs)
        if not t:
            continue
        name, val, rgb = t
        if name == bg_name:
            continue
        ratio = contrast(rgb, bg_rgb)
        if ratio < req:
            sev = "fail" if ratio < (req - 1.5) else "warn"
            out.append(finding(
                file, card, wcag, f"{label.capitalize()} contrast", sev,
                measured=f"{ratio:.2f}:1", required=f"{req}:1",
                detail=f"{name} ({val}) on {bg_name} ({bg_val})",
                recommendation=f"Darken/lighten {name} until contrast with {bg_name} ≥ {req}:1."))
    # accent / border as non-text component boundary → 3:1
    for subs, label in [(("accent", "primary", "brand"), "accent"),
                        (("border", "outline", "divider"), "border")]:
        t = token_color(tokens, *subs)
        if not t:
            continue
        name, val, rgb = t
        if name == bg_name:
            continue
        ratio = contrast(rgb, bg_rgb)
        if ratio < 3.0:
            # Role is statically ambiguous — accent may be a button FILL (text
            # sits on it, not beside it) and borders are often decorative. Keep
            # `fail` for high-confidence text contrast only: accent → warn,
            # border → info (advisory, never blocks the verdict).
            sev = "info" if label == "border" else "warn"
            out.append(finding(
                file, "02", "1.4.11", f"{label.capitalize()} non-text contrast", sev,
                measured=f"{ratio:.2f}:1", required="3:1",
                detail=f"{name} ({val}) on {bg_name} ({bg_val})",
                recommendation=f"Raise {name} contrast with {bg_name} to ≥ 3:1 so the {label} is perceivable."))
    return out


INLINE_PAIR_RE = re.compile(
    r"color\s*:\s*([^;\"']+).*?background(?:-color)?\s*:\s*([^;\"']+)"
    r"|background(?:-color)?\s*:\s*([^;\"']+).*?color\s*:\s*([^;\"']+)", re.I | re.S)


def check_inline_pairs(file, html):
    """Explicit color+background in the SAME style attribute — no cascade, so
    the contrast is exact."""
    out = []
    for style in re.findall(r'style\s*=\s*"([^"]*)"', html, re.I):
        col = re.search(r"(?:^|;)\s*color\s*:\s*([^;]+)", style, re.I)
        bgc = re.search(r"(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)", style, re.I)
        if not (col and bgc):
            continue
        fg, bg = parse_color(col.group(1)), parse_color(bgc.group(1))
        if fg is None or bg is None:
            continue
        ratio = contrast(fg, bg)
        if ratio < 4.5:
            out.append(finding(
                file, "01", "1.4.3", "Inline text contrast",
                "fail" if ratio < 3.0 else "warn",
                measured=f"{ratio:.2f}:1", required="4.5:1",
                detail=f"color:{col.group(1).strip()} on background:{bgc.group(1).strip()}",
                recommendation="Adjust the inline color pair to ≥ 4.5:1 (or ≥ 3:1 for large text)."))
    return out


SMALL_SIZE_RE = re.compile(r"(?:min-)?(?:height|width)\s*:\s*(\d+(?:\.\d+)?)px", re.I)
INTERACTIVE_TAG_RE = re.compile(
    r"<(button|a|input|select)\b[^>]*style\s*=\s*\"([^\"]*)\"[^>]*>", re.I)


def check_touch_targets(file, html):
    out = []
    for m in INTERACTIVE_TAG_RE.finditer(html):
        tag, style = m.group(1).lower(), m.group(2)
        sizes = [float(x) for x in SMALL_SIZE_RE.findall(style)]
        small = [s for s in sizes if s < 44]
        if small:
            out.append(finding(
                file, "04", "2.5.8", "Touch target size", "warn",
                measured=f"{min(small):g}px", required="44px (iOS) / 48dp (Android)",
                detail=f"<{tag}> declares {min(small):g}px",
                recommendation="Give interactive controls ≥ 44px hit area (size or padding) and ≥ 8px spacing."))
    return out


def heuristic_notes(file, html):
    out = []
    # 05 text-as-image: <img> whose alt looks like a heading/label sentence
    for alt in re.findall(r"<img\b[^>]*\balt\s*=\s*\"([^\"]{12,})\"", html, re.I):
        if re.search(r"[a-z]", alt) and " " in alt.strip():
            out.append(finding(
                file, "05", "1.4.5", "Possible text-as-image", "info",
                detail=f'<img alt="{alt[:40]}…">',
                recommendation="If this image renders body/heading text, use real text so it scales & recolors."))
            break
    # 03 color-only: status words with no icon/aria nearby is unmeasurable here
    out.append(finding(
        file, "03", "1.4.1", "Color-only signalling", "manual",
        recommendation="Verify status/error/success is not conveyed by color alone — add icon/label/shape."))
    # 06/07 reflow + zoom need real rendering
    out.append(finding(
        file, "06", "1.4.12", "Text-spacing reflow", "manual",
        recommendation="Render with line-height 1.5 / letter 0.12em / word 0.16em and confirm no clipping."))
    out.append(finding(
        file, "07", "1.4.10", "Reflow at 200% zoom", "manual",
        recommendation="Zoom to 200% (or 320px wide) and confirm no content is lost or requires 2-D scroll."))
    return out


# ── Driver ───────────────────────────────────────────────────────────────────
def find_html(root):
    hits = []
    for dirpath, _dirs, files in os.walk(root):
        # skip vendored/build noise that isn't the deliverable page set
        if os.sep + "node_modules" in dirpath:
            continue
        for fn in files:
            if fn.endswith(".html"):
                hits.append(os.path.join(dirpath, fn))
    return sorted(hits)


def lint_dir(root):
    findings = []
    files = find_html(root)
    for path in files:
        rel = os.path.relpath(path, root)
        try:
            html = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        css = extract_style(html)
        tokens = root_tokens(css)
        findings += check_palette_contrast(rel, tokens)
        findings += check_inline_pairs(rel, html)
        findings += check_touch_targets(rel, html)
        findings += heuristic_notes(rel, html)
    counts = {k: sum(1 for f in findings if f["severity"] == k)
              for k in ("fail", "warn", "info", "manual")}
    verdict = "fail" if counts["fail"] else "warn" if counts["warn"] else "pass"
    return {
        "schema_version": "1.0",
        "tool": "wcag-lint",
        "scanned": [os.path.relpath(p, root) for p in files],
        "summary": {"files": len(files), "findings": len(findings),
                    "verdict": verdict, **counts},
        "findings": findings,
    }


def selftest():
    assert parse_color("#fff") == (255, 255, 255)
    assert parse_color("#000000") == (0, 0, 0)
    assert parse_color("rgb(255, 255, 255)") == (255, 255, 255)
    assert parse_color("color-mix(in srgb, red, blue)") is None
    assert round(contrast((0, 0, 0), (255, 255, 255)), 1) == 21.0
    assert round(contrast((255, 255, 255), (255, 255, 255)), 1) == 1.0
    # #767676 on white ≈ 4.54:1 (the classic AA threshold gray)
    assert 4.4 < contrast((0x76, 0x76, 0x76), (255, 255, 255)) < 4.7
    # a low-contrast muted token must be flagged
    toks = {"--bg": "#ffffff", "--fg": "#111111", "--muted": "#bbbbbb", "--accent": "#e5e5e5"}
    res = check_palette_contrast("t.html", toks)
    cards = {f["name"]: f["severity"] for f in res}
    assert any("Muted" in n for n in cards), cards
    assert any("Accent" in n for n in cards), cards
    assert not any("Text contrast" == n for n in cards), "fg #111 on #fff should pass"
    print("selftest OK")


def main(argv):
    if argv and argv[0] == "--selftest":
        selftest()
        return 0
    if not argv:
        print("usage: wcag_lint.py <ui-output-dir> [<report-path>]", file=sys.stderr)
        return 2
    root = argv[0]
    out_path = argv[1] if len(argv) > 1 else os.path.join(root, "a11y-report.json")
    report = lint_dir(root)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)
    s = report["summary"]
    print(f"wcag-lint: {s['verdict'].upper()} — {s['files']} file(s), "
          f"{s['fail']} fail / {s['warn']} warn / {s['manual']} manual → {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
