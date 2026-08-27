// dr-mockup ("Mockup màn", WP dr-mockup 2026-08-27) — daemon side of the
// `docs-screen-mockup` skill: deterministic validation of the concept-layout
// HTML mockups the agent writes under `mockups/`, plus the fail-soft rebuild
// of `mockups/index.json`.
//
// Contract (spec .tmp/pipeline/wp-dr-mockup.md):
//   - `mockups/_inputs.json`  daemon → agent (prepareScreenComponentInputs with
//                             `outFile`): the screens of the SELECTED flow
//                             variant + document context. The screen list here
//                             is the REQUIRED set: every key needs a file.
//   - `mockups/<KEY>.html`    agent → one self-contained page per screen:
//                             `<body data-screen="<KEY>" data-layout="mobile|web">`,
//                             `.mk-region[data-region][data-label]` boxes,
//                             `data-nav="<KEY>"` on regions leading elsewhere.
//   - `mockups/index.json`    agent → { schema_version: 1, generatedAt, variant,
//                             screens: [{ key, name, file, platform, provenance?,
//                             navOut, pattern?, notes? }] }. Missing/broken → rebuilt here.
//   - `mockups/_audit.json`   daemon → { errors, warnings, patterns, plainColumn }
//                             of the last validate.
//
// Blocking errors (stage fails): a screen without a file, an external/script
// dependency (`<script`, `<link`, `<img src=http…>`, `@import`, `url(http…)`),
// a file over 200 KB. Warnings (file fixed in place where possible): a
// `data-nav` pointing outside the screen list (attribute REMOVED), a missing
// `<style>`, a `data-screen` that does not match the key (rewritten),
// stray .html files nobody asked for.
//
// WP dr-mockup-layouts (2026-08-27): layout diversity is checked FAIL-SOFT
// (warnings only) — `<body data-pattern="<id>">` (pattern id from
// skills/docs-screen-mockup/references/layout-patterns.md) must be present,
// and the body must use at least one non-stack kit class (LAYOUT_KIT_CLASSES);
// otherwise the screen is flagged "1 cột thuần". `pattern` flows into
// index.json (data-pattern wins over the agent's value) and `_audit.json`
// gets `patterns` + `plainColumn`.
//
// Pure (fs only, no DB, no agent) — server.ts owns the run lifecycle.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ScreenComponentsInputs, ScreenInput } from './screen-components.js';

export const MOCKUP_DIR = 'mockups';
export const MOCKUP_INPUTS_FILE = 'mockups/_inputs.json';
export const MOCKUP_INDEX_FILE = 'mockups/index.json';
export const MOCKUP_CSS_FILE = 'mockups/_mockup.css';
export const MOCKUP_AUDIT_FILE = 'mockups/_audit.json';
export const MOCKUP_MAX_BYTES = 200 * 1024;
export const MOCKUP_INDEX_SCHEMA_VERSION = 1 as const;

/** `mockups/<SCREEN-KEY>.html` */
export const mockupRel = (key: string): string => `${MOCKUP_DIR}/${key}.html`;

export interface MockupIndexScreen {
  key: string;
  name: string;
  file: string;
  platform: 'mobile' | 'web';
  provenance?: string;
  navOut: string[];
  /** Layout pattern id (`<body data-pattern>`, catalogue references/layout-patterns.md). */
  pattern?: string;
  notes?: string;
}

export interface MockupIndexDoc {
  schema_version: typeof MOCKUP_INDEX_SCHEMA_VERSION;
  generatedAt: string;
  variant: 'original' | 'improved';
  screens: MockupIndexScreen[];
}

export interface MockupAudit {
  generatedAt: string;
  screens: number;
  errors: string[];
  warnings: string[];
  /** Screen key → `data-pattern` (null when the body has none). Only screens with a file. */
  patterns: Record<string, string | null>;
  /** Screens whose body uses none of LAYOUT_KIT_CLASSES (pure vertical stack). */
  plainColumn: string[];
}

/** Kit classes that make a layout "not a plain column" (any one is enough). */
export const LAYOUT_KIT_CLASSES = [
  'mk-grid-2',
  'mk-grid-3',
  'mk-grid-4',
  'mk-row',
  'mk-hscroll',
  'mk-split',
  'mk-kv',
  'mk-sticky',
  'mk-tabs',
  'mk-seg',
  'mk-tabbar',
  'mk-accordion',
] as const;

export interface MockupValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  index: MockupIndexDoc;
  /** True when index.json was missing/broken and rebuilt from the files on disk. */
  indexRebuilt: boolean;
}

// ── helpers ────────────────────────────────────────────────────────────────

async function readText(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const FORBIDDEN: Array<{ re: RegExp; label: string }> = [
  { re: /<script\b/i, label: '<script>' },
  { re: /<link\b/i, label: '<link>' },
  { re: /<img\b[^>]*\bsrc\s*=\s*["']?\s*https?:/i, label: '<img src="http…">' },
  { re: /@import\b/i, label: '@import' },
  { re: /url\(\s*["']?\s*https?:/i, label: 'url(http…)' },
];

const NAV_ATTR_RE = /\s+data-nav\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const DATA_SCREEN_RE = /(<body\b[^>]*?\sdata-screen\s*=\s*)(?:"([^"]*)"|'([^']*)')/i;
const BODY_OPEN_RE = /<body\b/i;
const LAYOUT_RE = /<body\b[^>]*\sdata-layout\s*=\s*["']?(mobile|web)\b/i;
const PATTERN_RE = /<body\b[^>]*\sdata-pattern\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const STYLE_BLOCK_RE = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;
const LAYOUT_KIT_RE = new RegExp(`\\bclass\\s*=\\s*["'][^"']*\\b(?:${LAYOUT_KIT_CLASSES.join('|')})\\b`, 'i');

/** `data-pattern` on `<body>` (null when absent / empty). */
export function patternOf(html: string): string | null {
  const m = PATTERN_RE.exec(html);
  const v = (m?.[1] ?? m?.[2] ?? '').trim();
  return v || null;
}

/**
 * True when the markup (style blocks stripped, from `<body` on) uses none of
 * LAYOUT_KIT_CLASSES — i.e. the screen is a pure vertical stack of regions.
 */
export function isPlainColumn(html: string): boolean {
  const body = html.replace(STYLE_BLOCK_RE, '');
  const at = body.search(BODY_OPEN_RE);
  return !LAYOUT_KIT_RE.test(at >= 0 ? body.slice(at) : body);
}

function platformOf(input: ScreenInput, html: string | null): 'mobile' | 'web' {
  const m = html ? LAYOUT_RE.exec(html) : null;
  if (m) return m[1] as 'mobile' | 'web';
  return input.platform ?? input.platformHint;
}

function navTargetsOf(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(NAV_ATTR_RE)) {
    const key = (m[1] ?? m[2] ?? '').trim();
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/** Parse the agent's index.json; null when missing / not the contract shape. */
export function parseMockupIndex(raw: string | null): MockupIndexDoc | null {
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (!Array.isArray(o.screens)) return null;
  const screens: MockupIndexScreen[] = [];
  for (const item of o.screens) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const s = item as Record<string, unknown>;
    const key = str(s.key);
    if (!key) continue;
    const platform = s.platform === 'mobile' || s.platform === 'web' ? s.platform : 'mobile';
    const navOut = Array.isArray(s.navOut) ? s.navOut.map(str).filter(Boolean) : [];
    const entry: MockupIndexScreen = {
      key,
      name: str(s.name) || key,
      file: str(s.file) || mockupRel(key),
      platform,
      navOut,
    };
    if (str(s.provenance)) entry.provenance = str(s.provenance);
    if (str(s.pattern)) entry.pattern = str(s.pattern);
    if (str(s.notes)) entry.notes = str(s.notes);
    screens.push(entry);
  }
  return {
    schema_version: MOCKUP_INDEX_SCHEMA_VERSION,
    generatedAt: str(o.generatedAt) || new Date().toISOString(),
    variant: o.variant === 'improved' ? 'improved' : 'original',
    screens,
  };
}

/**
 * Validate every mockup the stage requires (one per screen of `inputs`), fix
 * what can be fixed deterministically (stray `data-nav`, wrong `data-screen`),
 * reconcile / rebuild `mockups/index.json`, and write `mockups/_audit.json`.
 * Never throws on agent output — every finding lands in errors/warnings.
 */
export async function validateMockups(cwd: string, inputs: ScreenComponentsInputs): Promise<MockupValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const dir = path.join(cwd, MOCKUP_DIR);
  await fs.mkdir(dir, { recursive: true });

  const keys = new Set(inputs.screens.map((s) => s.key));
  const present = new Map<string, { html: string; navOut: string[]; platform: 'mobile' | 'web'; pattern: string | null }>();
  const missing: string[] = [];
  const patterns: Record<string, string | null> = {};
  const plainColumn: string[] = [];

  for (const screen of inputs.screens) {
    const rel = mockupRel(screen.key);
    const abs = path.join(cwd, rel);
    let html = await readText(abs);
    if (html == null) {
      missing.push(screen.key);
      continue;
    }
    let changed = false;

    for (const f of FORBIDDEN) {
      if (f.re.test(html)) errors.push(`${rel}: chứa ${f.label} — mockup phải tự chứa, không script/link/ảnh/font ngoài`);
    }
    const bytes = Buffer.byteLength(html, 'utf8');
    if (bytes > MOCKUP_MAX_BYTES) errors.push(`${rel}: ${Math.round(bytes / 1024)} KB > ${MOCKUP_MAX_BYTES / 1024} KB`);
    if (!/<style\b/i.test(html)) warnings.push(`${rel}: thiếu <style> — chép mockups/_mockup.css vào file`);

    // data-screen must equal the key — rewrite (fail-soft) rather than fail the stage.
    const ds = DATA_SCREEN_RE.exec(html);
    if (ds) {
      const value = (ds[2] ?? ds[3] ?? '').trim();
      if (value !== screen.key) {
        html = html.replace(DATA_SCREEN_RE, `$1"${screen.key}"`);
        warnings.push(`${rel}: data-screen="${value}" ≠ key — daemon sửa thành "${screen.key}"`);
        changed = true;
      }
    } else if (BODY_OPEN_RE.test(html)) {
      html = html.replace(BODY_OPEN_RE, `<body data-screen="${screen.key}"`);
      warnings.push(`${rel}: thiếu data-screen trên <body> — daemon thêm "${screen.key}"`);
      changed = true;
    } else {
      warnings.push(`${rel}: không có <body> — không đặt được data-screen`);
    }

    // data-nav must point at a listed screen — strip the attribute otherwise.
    const badNav: string[] = [];
    html = html.replace(NAV_ATTR_RE, (whole, a: string | undefined, b: string | undefined) => {
      const target = (a ?? b ?? '').trim();
      if (target && keys.has(target)) return whole;
      badNav.push(target || '(rỗng)');
      return '';
    });
    if (badNav.length) {
      changed = true;
      warnings.push(`${rel}: data-nav trỏ màn không có trong danh sách (${[...new Set(badNav)].join(', ')}) — daemon đã xoá attribute`);
    }

    // Layout diversity (WP dr-mockup-layouts) — warnings only, never blocks.
    const pattern = patternOf(html);
    patterns[screen.key] = pattern;
    if (!pattern) warnings.push(`${rel}: thiếu data-pattern`);
    if (isPlainColumn(html)) {
      plainColumn.push(screen.key);
      warnings.push(`${rel}: bố cục 1 cột thuần — xem references/layout-patterns.md`);
    }

    if (changed) await fs.writeFile(abs, html, 'utf8');
    present.set(screen.key, { html, navOut: navTargetsOf(html), platform: platformOf(screen, html), pattern });
  }

  if (missing.length) errors.push(`thiếu file mockup cho ${missing.length} màn: ${missing.join(', ')}`);

  // Stray .html files the stage did not ask for (never deleted, just flagged).
  const listed = await fs.readdir(dir).catch(() => [] as string[]);
  const stray = listed
    .filter((f) => f.toLowerCase().endsWith('.html') && !f.startsWith('_'))
    .map((f) => f.replace(/\.html$/i, ''))
    .filter((k) => !keys.has(k));
  if (stray.length) warnings.push(`mockups/ có ${stray.length} file không thuộc màn nào: ${stray.join(', ')}`);

  // index.json: keep the agent's when parseable, reconcile it against disk;
  // otherwise rebuild from the files present (fail-soft).
  const byKey = new Map(inputs.screens.map((s) => [s.key, s]));
  const buildEntry = (key: string): MockupIndexScreen | null => {
    const input = byKey.get(key);
    const file = present.get(key);
    if (!input || !file) return null;
    const entry: MockupIndexScreen = { key, name: input.name, file: mockupRel(key), platform: file.platform, navOut: file.navOut };
    if (input.provenance) entry.provenance = input.provenance;
    if (file.pattern) entry.pattern = file.pattern;
    return entry;
  };
  const variant: MockupIndexDoc['variant'] = inputs.selection?.variant === 'improved' ? 'improved' : 'original';
  const agentIndex = parseMockupIndex(await readText(path.join(cwd, MOCKUP_INDEX_FILE)));
  let index: MockupIndexDoc;
  let indexRebuilt = false;
  let indexChanged = false;
  if (!agentIndex) {
    indexRebuilt = true;
    indexChanged = true;
    warnings.push('mockups/index.json thiếu hoặc hỏng — daemon dựng lại từ file có mặt');
    index = {
      schema_version: MOCKUP_INDEX_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      variant,
      screens: inputs.screens.map((s) => buildEntry(s.key)).filter((e): e is MockupIndexScreen => e != null),
    };
  } else {
    const kept: MockupIndexScreen[] = [];
    const seen = new Set<string>();
    for (const s of agentIndex.screens) {
      if (seen.has(s.key)) continue;
      seen.add(s.key);
      const fresh = buildEntry(s.key);
      if (!fresh) {
        warnings.push(`index.json: màn "${s.key}" ${keys.has(s.key) ? 'chưa có file' : 'không có trong danh sách'} — bỏ khỏi index`);
        indexChanged = true;
        continue;
      }
      // Daemon-derived fields win (file/platform/navOut/pattern reflect the
      // validated HTML); agent keeps name/notes, and pattern when the body has none.
      const merged: MockupIndexScreen = { ...fresh, name: s.name || fresh.name, navOut: fresh.navOut };
      if (!merged.pattern && s.pattern) merged.pattern = s.pattern;
      if (s.notes) merged.notes = s.notes;
      if (JSON.stringify(merged) !== JSON.stringify(s)) indexChanged = true;
      kept.push(merged);
    }
    for (const s of inputs.screens) {
      if (seen.has(s.key) || !present.has(s.key)) continue;
      const fresh = buildEntry(s.key);
      if (fresh) {
        kept.push(fresh);
        warnings.push(`index.json: thiếu màn "${s.key}" (file có) — daemon bổ sung`);
        indexChanged = true;
      }
    }
    if (agentIndex.variant !== variant) {
      warnings.push(`index.json: variant "${agentIndex.variant}" ≠ bản đang dùng "${variant}" — daemon sửa`);
      indexChanged = true;
    }
    index = { ...agentIndex, variant, screens: kept };
  }
  if (indexChanged) await fs.writeFile(path.join(cwd, MOCKUP_INDEX_FILE), JSON.stringify(index, null, 2), 'utf8');

  const audit: MockupAudit = { generatedAt: new Date().toISOString(), screens: inputs.screens.length, errors, warnings, patterns, plainColumn };
  await fs.writeFile(path.join(cwd, MOCKUP_AUDIT_FILE), JSON.stringify(audit, null, 2), 'utf8');

  return { ok: errors.length === 0, errors, warnings, index, indexRebuilt };
}
