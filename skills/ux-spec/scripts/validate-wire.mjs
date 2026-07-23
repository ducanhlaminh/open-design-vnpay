#!/usr/bin/env node
// validate-wire.mjs — check every `wireframes/<SCREEN-ID>.wire.json` against the
// closed component registry (`references/wire-registry.json`).
//
//   node skills/ux-spec/scripts/validate-wire.mjs [wireframesDir] [--spec <ux-spec.json>]
//
// Default dir: ./wireframes. Exits 1 when there is any ERROR.
// Without a registry check an unknown slug renders as a silent empty box — this
// script is what turns that into a build-time failure.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = JSON.parse(readFileSync(join(HERE, '..', 'references', 'wire-registry.json'), 'utf8'));

/* ── registry indexes ─────────────────────────────────────────────────────── */
const bySlug = new Map();
const byAlias = new Map();
for (const e of REGISTRY.slugs) {
  bySlug.set(e.slug.toLowerCase(), e);
  for (const a of e.aliases ?? []) byAlias.set(a.toLowerCase(), e);
}

/* ── prop type checking ───────────────────────────────────────────────────── */
function typeOk(spec, v) {
  const optional = spec.endsWith('?');
  const t = optional ? spec.slice(0, -1) : spec;
  if (v === undefined || v === null) return optional;
  if (t === 'string') return typeof v === 'string';
  if (t === 'number') return typeof v === 'number';
  if (t === 'boolean') return typeof v === 'boolean';
  if (t === 'string[]') return Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (t === 'string[][]') return Array.isArray(v) && v.every((r) => Array.isArray(r));
  if (t.startsWith('enum(')) return t.slice(5, -1).split('|').includes(String(v));
  return true;
}

const CONTAINER_KEYS = new Set(['dir', 'children', 'gap', 'align', 'card', 'label', 'grow', 'w', 'pad', 'note']);
const GAPS = new Set(['none', 'sm', 'md', 'lg']);
const ALIGNS = new Set(['start', 'center', 'end', 'between', 'stretch']);

/* ── tree walk ────────────────────────────────────────────────────────────── */
function walk(node, path, ctx) {
  if (!node || typeof node !== 'object') {
    ctx.err(`${path}: node phải là object`);
    return;
  }
  const isContainer = typeof node.dir === 'string' || Array.isArray(node.children);
  if (isContainer) {
    if (node.dir !== 'stack' && node.dir !== 'row') ctx.err(`${path}: dir phải là "stack" | "row" (đang: ${JSON.stringify(node.dir)})`);
    if (!Array.isArray(node.children)) return ctx.err(`${path}: container thiếu children[]`);
    if (node.gap !== undefined && !GAPS.has(node.gap)) ctx.err(`${path}: gap không hợp lệ "${node.gap}" (none|sm|md|lg)`);
    if (node.align !== undefined && !ALIGNS.has(node.align)) ctx.err(`${path}: align không hợp lệ "${node.align}"`);
    for (const k of Object.keys(node)) if (!CONTAINER_KEYS.has(k)) ctx.warn(`${path}: key lạ trên container "${k}"`);
    node.children.forEach((c, i) => walk(c, `${path}.children[${i}]`, ctx));
    return;
  }

  // leaf
  const raw = node.c ?? node.componentType ?? node.type;
  if (!raw) return ctx.err(`${path}: leaf thiếu "c" (slug component)`);
  const key = String(raw).toLowerCase();
  let entry = bySlug.get(key);
  if (entry) {
    if (node.componentType || node.type) ctx.warn(`${path}: slug v2 nên khai bằng "c", không phải componentType/type`);
  } else {
    entry = byAlias.get(key);
    if (!entry) return ctx.err(`${path}: slug "${raw}" KHÔNG có trong registry — dùng một slug ở references/wire-components.md`);
    ctx.warn(`${path}: "${raw}" là từ vựng v1 → đổi thành "${entry.slug}"`);
  }

  const allowed = { ...REGISTRY.commonProps, ...(entry.props ?? {}) };
  const props = node.props && typeof node.props === 'object' ? node.props : node;
  for (const [k, v] of Object.entries(props)) {
    if (k === 'c' || k === 'componentType' || k === 'type' || k === 'props') continue;
    const spec = allowed[k];
    if (!spec) {
      ctx.warn(`${path}: prop lạ "${k}" trên ${entry.slug} (bị bỏ qua khi render)`);
      continue;
    }
    if (!typeOk(spec, v)) ctx.err(`${path}: prop "${k}" của ${entry.slug} sai kiểu — cần ${spec}, nhận ${JSON.stringify(v)}`);
  }
  for (const [k, spec] of Object.entries(entry.props ?? {})) {
    if (!spec.endsWith('?') && props[k] === undefined) ctx.err(`${path}: ${entry.slug} thiếu prop bắt buộc "${k}" (${spec})`);
  }
}

/* ── per-file check ───────────────────────────────────────────────────────── */
function checkDoc(doc, file, ctx) {
  if (doc.objects && !doc.layout) ctx.warn(`${file}: dùng shape "objects" (toạ độ tuyệt đối, đã bỏ) — hãy viết lại thành cây layout`);
  if (doc.dslVersion === undefined) ctx.warn(`${file}: thiếu "dslVersion": 2`);
  else if (doc.dslVersion !== 2) ctx.err(`${file}: dslVersion không hỗ trợ (${doc.dslVersion})`);
  if (doc.overlay && !['dialog', 'drawer', 'sheet'].includes(doc.overlay)) ctx.err(`${file}: overlay phải là dialog|drawer|sheet`);
  if (!doc.layout && !doc.objects) return ctx.err(`${file}: thiếu "layout"`);
  if (doc.layout) walk(doc.layout, 'layout', ctx);
  for (const [dev, tree] of Object.entries(doc.layouts ?? {})) {
    if (!['desktop', 'tablet', 'mobile'].includes(dev)) ctx.err(`${file}: layouts."${dev}" không hợp lệ (desktop|tablet|mobile)`);
    walk(tree, `layouts.${dev}`, ctx);
  }
}

/* ── main ─────────────────────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const specIdx = args.indexOf('--spec');
const specPath = specIdx >= 0 ? args[specIdx + 1] : null;
const dir = resolve(args.find((a) => !a.startsWith('--') && a !== specPath) ?? './wireframes');

if (!existsSync(dir)) {
  console.error(`✗ không thấy thư mục ${dir}`);
  process.exit(1);
}

const files = readdirSync(dir).filter((f) => f.endsWith('.wire.json')).sort();
let errors = 0;
let warns = 0;
const seenIds = new Set();

for (const f of files) {
  const id = f.replace(/\.wire\.json$/, '');
  seenIds.add(id);
  const lines = [];
  const ctx = {
    err: (m) => { errors++; lines.push(`  ✗ ${m}`); },
    warn: (m) => { warns++; lines.push(`  ! ${m}`); },
  };
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  } catch (e) {
    errors++;
    console.log(`${f}\n  ✗ JSON hỏng: ${e.message}`);
    continue;
  }
  checkDoc(doc, f, ctx);
  if (lines.length) console.log(`${f}\n${lines.join('\n')}`);
}

// Cross-check against the UX Spec: the join is BY FILENAME, so a typo silently
// orphans a wireframe.
if (specPath && existsSync(specPath)) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const screens = spec.screens ?? [];
  const ids = new Set(screens.map((s) => s.id));
  for (const id of seenIds) if (!ids.has(id)) { errors++; console.log(`${id}.wire.json\n  ✗ không khớp screen id nào trong ${specPath}`); }
  for (const s of screens) {
    if (!seenIds.has(s.id)) { errors++; console.log(`${s.id}\n  ✗ screen thiếu wireframes/${s.id}.wire.json`); }
    else if (s.layout === 'web') {
      const doc = JSON.parse(readFileSync(join(dir, `${s.id}.wire.json`), 'utf8'));
      for (const dev of ['tablet', 'mobile']) {
        if (!doc.layouts?.[dev]) { warns++; console.log(`${s.id}.wire.json\n  ! screen web thiếu layouts.${dev} (sẽ co lại cây desktop thay vì thiết kế lại)`); }
      }
    }
  }
}

console.log(`\n${files.length} file · ${errors} lỗi · ${warns} cảnh báo`);
process.exit(errors ? 1 : 0);
