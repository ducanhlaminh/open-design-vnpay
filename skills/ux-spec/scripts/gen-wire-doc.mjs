#!/usr/bin/env node
// gen-wire-doc.mjs — regenerate everything derived from
// `references/wire-registry.json` (the ONE source of truth for the wireframe
// vocabulary):
//
//   node skills/ux-spec/scripts/gen-wire-doc.mjs
//     → references/wire-components.md            (the doc the agent reads)
//     → apps/web/src/components/wire-slug-map.generated.ts   (od web renderer)
//
//   node …/gen-wire-doc.mjs --emit-ts <path>     (extra host, e.g. pipeline-studio
//                                                 which lives in the PARENT repo)
//   node …/gen-wire-doc.mjs --check [--emit-ts <path>]
//                                                (write NOTHING; exit 1 if any
//                                                 generated file is stale — this
//                                                 is what `pnpm guard` runs)
//
// Both outputs are GENERATED — never hand-edit them.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REF = join(HERE, '..', 'references');
const REGISTRY = JSON.parse(readFileSync(join(REF, 'wire-registry.json'), 'utf8'));

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const emitOnly = argv.includes('--emit-ts') && !check;
const extraTs = argv.flatMap((a, i) => (a === '--emit-ts' ? [resolve(argv[i + 1])] : []));

let stale = 0;
/** Write, or in --check mode compare and report. */
const emit = (file, content, label) => {
  if (check) {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (current === content) return;
    stale++;
    console.error(`✗ ${label ?? file} ${current === null ? 'chưa được sinh' : 'lệch registry'}`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.log(`✓ ${label ?? file}`);
};

const GROUPS = [
  ['shadcn:', 'shadcn — 1:1 với `src/components/ui/*` của terminal `ui-react`'],
  ['mobile:', 'mobile — shadcn KHÔNG có các primitive này; đây là phần mở rộng có chủ đích'],
  ['data:', 'data — không có primitive, terminal tự compose'],
  ['media:', 'media'],
  ['layout:', 'layout'],
];

const code = (s) => (s && s !== '—' ? `\`${s}\`` : '—');

const propsCell = (p) =>
  Object.keys(p ?? {}).length
    ? Object.entries(p).map(([k, v]) => `\`${k}\`${v.endsWith('?') ? '' : '**\\***'}`).join(' ')
    : '—';

let out = `<!-- GENERATED bởi scripts/gen-wire-doc.mjs — ĐỪNG sửa tay.
     Nguồn sự thật: references/wire-registry.json -->
# Từ vựng component wireframe (DSL v${REGISTRY.dslVersion})

Đây là **danh sách ĐÓNG**. Slug không có trong bảng sẽ bị
\`scripts/validate-wire.mjs\` báo lỗi và renderer vẽ ra badge đỏ \`?slug\` — không
im lặng ra hộp rỗng như DSL v1.

Prop có dấu **\\*** là **bắt buộc**. Mọi leaf còn nhận thêm prop chung:
${Object.entries(REGISTRY.commonProps).map(([k, v]) => `\`${k}\` (${v})`).join(' · ')}.

Cột **→ ui-react / ui-html** là hợp đồng bàn giao: bước UI dựng đúng
component đó, không tự chọn lại.

`;

for (const [prefix, title] of GROUPS) {
  const rows = REGISTRY.slugs.filter((s) => s.slug.startsWith(prefix));
  if (!rows.length) continue;
  out += `## ${title}\n\n`;
  out += `| Slug | Props | Từ vựng v1 (cũ) | → ui-react | → ui-html |\n`;
  out += `|---|---|---|---|---|\n`;
  for (const s of rows) {
    out += `| \`${s.slug}\` | ${propsCell(s.props)} | ${(s.aliases ?? []).map((a) => `\`${a}\``).join(' ') || '—'} | ${code(s.map?.uiReact)} | ${code(s.map?.uiHtml)} |\n`;
  }
  out += `\n`;
}

out += `## Ghi chú

- **Overlay không phải leaf.** Dialog / sheet / drawer là MỘT MÀN riêng, khai bằng
  \`overlay\` + \`overlayOf\` ở cấp document (xem \`wireframe.md\`). \`mobile:NavDrawer\`
  là ngoại lệ duy nhất: nó vẽ menu điều hướng ở trạng thái mở.
- **File cũ vẫn chạy**: renderer nhận từ vựng v1 qua cột "Từ vựng v1", validator
  báo cảnh báo kèm slug v2 tương ứng. Không cần script migrate.
- Thêm slug mới: sửa \`wire-registry.json\` → chạy \`gen-wire-doc.mjs\` → đồng bộ
  renderer (\`npm run sync:wire-registry\` bên pipeline-studio).
`;

if (!emitOnly) {
  emit(join(REF, 'wire-components.md'), out, `references/wire-components.md — ${REGISTRY.slugs.length} slug`);
}

/* ── the renderer half: one generated TS module per host ──────────────────── */
const slugRender = {};
const aliasRender = {};
const canonical = {};
for (const s of REGISTRY.slugs) {
  slugRender[s.slug.toLowerCase()] = s.render;
  canonical[s.slug.toLowerCase()] = s.slug;
  for (const a of s.aliases ?? []) {
    if (aliasRender[a.toLowerCase()]) continue; // first slug wins a shared alias
    aliasRender[a.toLowerCase()] = s.render;
    canonical[a.toLowerCase()] = s.slug;
  }
}

const ts = `// GENERATED bởi skills/ux-spec/scripts/gen-wire-doc.mjs — ĐỪNG sửa tay.
// Nguồn: skills/ux-spec/references/wire-registry.json (DSL v${REGISTRY.dslVersion}).
// Chạy lại: node skills/ux-spec/scripts/gen-wire-doc.mjs
export const WIRE_DSL_VERSION = ${REGISTRY.dslVersion};

/** slug v2 (lowercase) → render kind mà LeafBody vẽ. */
const SLUG_RENDER: Record<string, string> = ${JSON.stringify(slugRender, null, 2)};
/** từ vựng v1 (lowercase) → render kind. Giữ file cũ chạy được, không cần migrate. */
const ALIAS_RENDER: Record<string, string> = ${JSON.stringify(aliasRender, null, 2)};
/** bất kỳ key nào → slug v2 chính tắc (để hiện trong badge / tooltip). */
const CANONICAL: Record<string, string> = ${JSON.stringify(canonical, null, 2)};

export interface ResolvedWireKind {
  /** render kind cho switch trong LeafBody */
  kind: string;
  /** slug v2 chính tắc */
  slug: string;
  /** true khi file dùng từ vựng v1 */
  legacy: boolean;
}

/** Tra slug (v2) hoặc componentType (v1). null = KHÔNG có trong registry →
 *  renderer phải vẽ badge đỏ, không được im lặng ra hộp rỗng. */
export function resolveWireKind(raw?: string | null): ResolvedWireKind | null {
  if (!raw) return null;
  const key = String(raw).toLowerCase();
  const direct = SLUG_RENDER[key];
  if (direct) return { kind: direct, slug: CANONICAL[key] ?? String(raw), legacy: false };
  const alias = ALIAS_RENDER[key];
  if (alias) return { kind: alias, slug: CANONICAL[key] ?? String(raw), legacy: true };
  return null;
}

/** Làm phẳng leaf v2 (\`{c, props:{…}}\`) về đúng shape phẳng mà renderer đang đọc,
 *  và ánh xạ prop v2 (items/active/block) sang tên v1 (tabs/chips/activeTab/grow). */
export function normalizeWireLeaf<T extends Record<string, unknown>>(node: T): Record<string, unknown> {
  const bag = (node as { props?: Record<string, unknown> }).props;
  const flat: Record<string, unknown> = bag && typeof bag === 'object' ? { ...node, ...bag } : { ...node };
  const items = flat.items;
  if (Array.isArray(items)) {
    if (flat.tabs === undefined) flat.tabs = items;
    if (flat.chips === undefined) flat.chips = items;
    if (flat.navItems === undefined) flat.navItems = items;
  }
  if (typeof flat.active === 'number') {
    if (flat.activeTab === undefined) flat.activeTab = flat.active;
    if (flat.activeStep === undefined) flat.activeStep = flat.active;
  }
  if (flat.block === true && flat.grow === undefined) flat.grow = 1;
  return flat;
}
`;

const targets = [...extraTs];
if (!emitOnly) {
  const web = join(HERE, '..', '..', '..', 'apps', 'web', 'src', 'components', 'wire-slug-map.generated.ts');
  if (existsSync(dirname(web))) targets.push(web);
}
// Drift guard: a registry render kind that no renderer draws would silently fall
// into the generic dashed box. Check the renderer sitting next to each target.
const RENDERERS = [
  'WireFrameView.tsx', 'wire-frame-view.tsx',                     // od web: map + renderer cùng thư mục
  '../components/WireFrameView.tsx', '../components/wire-frame-view.tsx', // studio: map ở src/lib
];
const kinds = [...new Set(REGISTRY.slugs.map((s) => s.render))];
let drift = 0;
for (const t of targets) {
  emit(t, ts);
  for (const r of RENDERERS) {
    const p = join(dirname(t), r);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, 'utf8');
    const missing = kinds.filter((k) => !src.includes(`case '${k}'`));
    if (missing.length) {
      drift += missing.length;
      console.log(`  ! ${r} chưa vẽ render kind: ${missing.join(', ')}`);
    }
  }
}
const undeclared = kinds.filter((k) => !(REGISTRY.renderKinds ?? []).includes(k));
if (undeclared.length) {
  drift += undeclared.length;
  console.error(`  ! renderKinds thiếu: ${undeclared.join(', ')}`);
}
if (check) {
  if (stale || drift) {
    console.error(
      `\nRegistry và file sinh ra đang lệch. Chạy:\n` +
        `  node skills/ux-spec/scripts/gen-wire-doc.mjs\n` +
        `  (và \`npm run sync:wire-registry\` trong ui/pipeline-studio nếu có)`,
    );
  } else {
    console.log(`Wire registry sync check passed: ${REGISTRY.slugs.length} slug, ${kinds.length} render kind, không lệch.`);
  }
}
if (drift || stale) process.exitCode = 1;

