// WP25a — "Dựng trong Figma" per màn: pure, test-only helpers.
//
// Daemon cannot write to Figma (the REST client is read-only, see
// figma-rest.ts's docblock). The write path is an agent run holding the
// Figma MCP server the user already OAuth'd in Settings → MCP — this module
// only compiles the DETERMINISTIC input that run consumes (so the agent
// never has to guess a component key/variant/order), reads/writes the tiny
// preview-file config, and picks which of the user's external MCP servers is
// "the" Figma one. Everything here is pure (no fs writes except the two
// preview-config helpers, no agent/network calls) — figma-build-routes.ts
// owns the job/HTTP layer and the agent-spawn glue.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { load, type Cheerio } from 'cheerio';

import { anchorFor, type FigmaCatalogComponent, type FigmaComponentCatalogSnapshot } from './figma-component-catalog.js';
import { scanWireframe } from './screen-components.js';

// ── .figma-preview.json (docs-review workflow dir, sibling to screens-overrides.json) ──

/** Nằm NGAY DƯỚI cwd của workflow "docs-review" — NGOÀI `comp/`, cùng lý do
 *  `screens-overrides.json` sống sót "Run lại" (re-run clear chỉ dọn
 *  `comp/`): file preview do NGƯỜI DÙNG dán, không phải sản phẩm của một lần
 *  chạy stage. */
export const FIGMA_PREVIEW_CONFIG_REL = '.figma-preview.json';

export interface FigmaPreviewConfig {
  fileKey: string;
  url: string;
}

function isFigmaPreviewConfig(value: unknown): value is FigmaPreviewConfig {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.fileKey === 'string' && v.fileKey.trim().length > 0 && typeof v.url === 'string' && v.url.trim().length > 0;
}

/** `null` khi chưa cấu hình, hoặc file hỏng/không đọc được — best-effort,
 *  không throw (caller coi đây là "chưa cấu hình", giống mọi optional config
 *  khác trong repo này). */
export async function readFigmaPreviewConfig(cwd: string): Promise<FigmaPreviewConfig | null> {
  const raw = await fs.promises.readFile(path.join(cwd, FIGMA_PREVIEW_CONFIG_REL), 'utf8').catch(() => null);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    return isFigmaPreviewConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Atomic write (tmp → rename), khuôn `screens-overrides.ts` PUT route. */
export async function writeFigmaPreviewConfig(cwd: string, config: FigmaPreviewConfig): Promise<void> {
  await fs.promises.mkdir(cwd, { recursive: true });
  const target = path.join(cwd, FIGMA_PREVIEW_CONFIG_REL);
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
    await fs.promises.rename(tmp, target);
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

/** Parse + canonicalize ONE `figma.com/design/<fileKey>…` or `/file/<fileKey>…`
 *  link — same shape rule as `canonicalLinks` (figma-design-system-routes.ts,
 *  not exported there, so re-stated here for this single-link case) so a
 *  pasted link with a stray `node-id`/tracking query still normalizes to the
 *  same `{fileKey, url}`. `null` on anything that isn't a Figma file link. */
export function parseFigmaPreviewLink(raw: string): FigmaPreviewConfig | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!['figma.com', 'www.figma.com'].includes(parsed.hostname.toLowerCase())) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (!['design', 'file'].includes(parts[0] ?? '') || !/^[A-Za-z0-9]+$/.test(parts[1] ?? '')) return null;
  const fileKey = parts[1]!;
  return { fileKey, url: `https://www.figma.com/design/${fileKey}` };
}

// ── MCP server pick ──────────────────────────────────────────────────────

export interface McpServerLike {
  id: string;
  enabled: boolean;
  templateId?: string;
  url?: string;
}

/** The Figma MCP server the user configured in Settings → External MCP — the
 *  ONLY external server a figma-build run is allowed to see (see
 *  `computeEnabledMcp`). Deterministic: first enabled server whose
 *  `templateId` is exactly `'figma'`, or whose id/url matches `/figma/i`
 *  (covers a user-added custom entry without the template). `null` when
 *  none — the route reports `MCP_FIGMA_REQUIRED`. */
export function pickFigmaMcpServer<S extends McpServerLike>(servers: readonly S[]): S | null {
  return servers.find((s) => s.enabled && (
    s.templateId === 'figma' ||
    /figma/i.test(s.id) ||
    (typeof s.url === 'string' && /figma/i.test(s.url))
  )) ?? null;
}

/** WP25a: pure computation behind `enabledExternalMcp` in server.ts's
 *  `startChatRun` — pipeline stage runs never see external MCP (unchanged
 *  behaviour); everything else keeps the user's Settings → External MCP,
 *  UNLESS an internal caller narrowed it to an explicit allow-list of server
 *  ids (the figma-build job, via `INTERNAL_MCP_SERVER_IDS` — a Symbol only an
 *  in-process caller can set, never a JSON `/api/chat` body). `allowIds` is
 *  `null` for every existing call site (no behavior change there). */
export function computeEnabledMcp<S extends { id: string; enabled: boolean }>(
  servers: readonly S[],
  isPipelineProfile: boolean,
  allowIds: readonly string[] | null,
): S[] {
  if (isPipelineProfile) return [];
  const enabled = servers.filter((s) => s.enabled);
  if (!allowIds) return enabled;
  const allow = new Set(allowIds);
  return enabled.filter((s) => allow.has(s.id));
}

// ── Frozen per-run Figma catalog (docs-review/.figma-catalog/components.json) ──

/** Same file the dr-comp preparation phase freezes (server.ts, docs-comp
 *  block) — the one whose anchors comp/<KEY>.screen.json actually cites, NOT
 *  necessarily the App-level catalogue's latest refresh (which can have
 *  moved on since this screen was authored). `null` when missing/unreadable
 *  or not shaped like a snapshot. */
export async function readFrozenFigmaCatalog(cwd: string): Promise<FigmaComponentCatalogSnapshot | null> {
  const raw = await fs.promises.readFile(path.join(cwd, '.figma-catalog', 'components.json'), 'utf8').catch(() => null);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as FigmaComponentCatalogSnapshot;
    return parsed && Array.isArray(parsed.files) ? parsed : null;
  } catch {
    return null;
  }
}

/** A catalogue frozen before WP25a never carries `key`/`variants` (see
 *  figma-rest.ts) — the "Dựng trong Figma" skill can't import anything
 *  without them, so the route reports `CATALOG_REQUIRED` (hint: refresh DS
 *  Figma once) instead of silently building a frame with no real
 *  components. */
export function catalogHasComponentKeys(catalog: FigmaComponentCatalogSnapshot): boolean {
  return catalog.files.some((file) => file.components.some((c) => Boolean(c.key) || (c.variants?.length ?? 0) > 0));
}

// ── compileScreenBuildInput ──────────────────────────────────────────────

/** WP29: v1→v2 chỉ THÊM field tuỳ chọn `layout`/`mockups` — `elements[]` và
 *  `result.json` giữ nguyên shape, nên input.json v1 cũ (không `layout`) vẫn
 *  đọc được bởi skill mới (skill rẽ nhánh theo việc `layout` có mặt hay
 *  không, không theo số này). */
export const SCREEN_BUILD_INPUT_SCHEMA_VERSION = 2 as const;

export interface ScreenBuildContent {
  text?: string;
  secondary?: string;
  value?: string;
  badge?: string;
  items?: string[];
}

export interface ScreenBuildComponentRef {
  name: string;
  key?: string;
  /** Present when `name` resolves to a variant inside a COMPONENT_SET. */
  variantNodeId?: string;
  setNodeId?: string;
  /** The screen's own variant string (verbatim), when it declared one. */
  variant?: string;
}

export interface ScreenBuildInputElement {
  id: string;
  role: string;
  label: string;
  content?: ScreenBuildContent;
  /** Absent when the screen element has no DS anchor (`ds: null`) — the
   *  skill builds a plain text/frame node for it instead of an instance. */
  component?: ScreenBuildComponentRef;
  /** Non-fatal note for this ONE element (unknown anchor, variant fell back
   *  to default…) — the skill still builds the element, just not exactly as
   *  the screen asked. */
  warning?: string;
}

/** WP29: một node của cây bố cục — xem `buildWireframeLayoutTree`. */
export type ScreenBuildLayoutNode =
  | { type: 'el'; id: string }
  | { type: 'group'; id: string; children: ScreenBuildLayoutNode[] }
  | { type: 'row'; children: ScreenBuildLayoutNode[] }
  | { type: 'heading'; text: string };

export interface ScreenBuildInput {
  schema_version: typeof SCREEN_BUILD_INPUT_SCHEMA_VERSION;
  screenKey: string;
  screenName: string;
  appFeature: string;
  previewFileKey: string;
  /** fileKey of the DS library the matched components came from — `null`
   *  when no element resolved to a DS component at all (pure text/frame
   *  screen). */
  dsFileKey: string | null;
  platform: 'mobile' | 'web';
  pageName: string;
  frameName: string;
  elements: ScreenBuildInputElement[];
  /** WP29: cây bố cục THẬT của màn (xem `buildWireframeLayoutTree`) — vắng
   *  mặt khi không có wireframe hoặc wireframe không khớp phần tử nào
   *  (`elements[]` + thứ tự vẫn là nguồn dữ liệu duy nhất lúc đó, skill xếp
   *  dọc như v1). Có mặt → skill dựng ĐỆ QUY theo cây thay vì xếp phẳng. */
  layout?: ScreenBuildLayoutNode[];
  /** WP29: đường dẫn ảnh mockup BA (tương đối từ cwd docs-review), đã lọc
   *  còn file tồn tại thật trên đĩa — tham chiếu spacing/tỉ lệ cho agent,
   *  KHÔNG dùng để đổi cấu trúc (`layout` vẫn quyết định). Vắng mặt = không
   *  có ảnh cho màn này. */
  mockups?: string[];
  rules: {
    scope: string;
    naming: string;
    idempotent: string;
  };
}

// ── buildWireframeLayoutTree (WP29) ───────────────────────────────────────

/** Cây bố cục suy ra tất định từ wireframe HTML — nguồn cấu trúc cho
 *  `figma-screen-build` skill dựng đúng hàng-ngang/nhóm-lồng-nhau thay vì
 *  luôn xếp `elements[]` thành MỘT cột dọc (lý do WP29: "chồng comp một
 *  cột"). Bốn loại node:
 *  - `el`: lá — phần tử `data-el` (∈ knownIds) KHÔNG chứa `data-el` con nào.
 *  - `group`: phần tử `data-el` (∈ knownIds) CÓ chứa `data-el` con — `id`
 *    của chính nó + `children` là cây con lồng bên trong. LƯU Ý: instance
 *    Figma không nhận children (xem SKILL.md) — skill dựng instance của
 *    chính `id` đứng ĐẦU rồi tới `children`, một xấp xỉ v1 chấp nhận được.
 *  - `row`: thẻ mang class `wf-row` — các con xếp NGANG. Chỉ phát sinh khi
 *    còn ≥2 con sau khi parse (đúng 1 con → nâng con lên thay row; 0 con →
 *    bỏ).
 *  - `heading`: thẻ mang class `wf-section` — chữ đầu mục (rỗng thì bỏ).
 *  Container không khớp loại nào ở trên (div bọc vô danh, `<main>`,
 *  `<body>`…) bị "xuyên qua": con của nó được nâng thẳng lên cấp cha.
 *  `data-el` NGOÀI `knownIds` cũng bị bỏ như một wrapper vô danh — con của
 *  nó vẫn được duyệt bình thường. Trùng `data-el` (đã xuất hiện) → bỏ lần
 *  sau, giữ lần đầu. Trả về `null` khi cây rỗng (không phần tử nào khớp).
 *  Thuần: chỉ parse chuỗi (cheerio), không fs/network. */
export function buildWireframeLayoutTree(wireframeHtml: string, knownIds: readonly string[]): ScreenBuildLayoutNode[] | null {
  const known = new Set(knownIds);
  const seen = new Set<string>();
  const $ = load(wireframeHtml);

  const parseChildren = (container: Cheerio<any>): ScreenBuildLayoutNode[] => {
    const out: ScreenBuildLayoutNode[] = [];
    container.children().each((_i: number, el: any) => {
      out.push(...parseNode($(el)));
    });
    return out;
  };

  const parseNode = (el: Cheerio<any>): ScreenBuildLayoutNode[] => {
    const dataElRaw = el.attr('data-el');
    const dataEl = typeof dataElRaw === 'string' ? dataElRaw.trim() : '';
    if (dataEl) {
      if (!known.has(dataEl)) {
        // Ngoài knownIds — bỏ chính nó như một wrapper vô danh, con vẫn duyệt.
        return parseChildren(el);
      }
      if (seen.has(dataEl)) return []; // trùng — bỏ, giữ lần xuất hiện đầu.
      const hasNestedDataEl = el.find('[data-el]').length > 0;
      seen.add(dataEl);
      if (hasNestedDataEl) {
        return [{ type: 'group', id: dataEl, children: parseChildren(el) }];
      }
      return [{ type: 'el', id: dataEl }];
    }
    if (el.hasClass('wf-row')) {
      const children = parseChildren(el);
      if (children.length === 0) return [];
      if (children.length === 1) return children; // 1 con → nâng lên thay row.
      return [{ type: 'row', children }];
    }
    if (el.hasClass('wf-section')) {
      const text = el.text().trim();
      return text ? [{ type: 'heading', text }] : [];
    }
    // Wrapper vô danh (div bọc, <main>, <body>…) — xuyên qua.
    return parseChildren(el);
  };

  const roots = parseChildren($('body'));
  return roots.length > 0 ? roots : null;
}

/** Minimal shape this module needs from `ScreenComponentsDoc` (screen-
 *  components.ts) — declared locally instead of importing the full type so
 *  a caller building this from a plain `JSON.parse` (no daemon-only class)
 *  doesn't need to satisfy every field of the richer type. */
export interface ScreenBuildSourceElement {
  id: string;
  label: string;
  role: string;
  ds: { component: string; anchor: string; variant?: string } | null;
  content?: ScreenBuildContent;
}
export interface ScreenBuildSourceDoc {
  key: string;
  name: string;
  platform: 'mobile' | 'web';
  elements: ScreenBuildSourceElement[];
}

export interface CompileScreenBuildInputOptions {
  screenDoc: ScreenBuildSourceDoc;
  /** Wireframe HTML (wireframes/<KEY>.html) — `null` falls back to the
   *  screen.json elements' own order. */
  wireframeHtml: string | null;
  catalog: FigmaComponentCatalogSnapshot;
  previewFileKey: string;
  appFeature: string;
  /** WP29: đường dẫn ảnh mockup BA (tương đối từ cwd docs-review) đã lọc còn
   *  file tồn tại — routes.ts đọc `comp/_inputs.json` rồi truyền vào đây;
   *  module này chỉ passthrough (thuần, không tự kiểm tra đĩa). */
  mockups?: string[];
}

/** "Prop=Value" pairs, unordered, case/space-insensitive — Figma renders a
 *  variant name as e.g. `"State=Default, Size=Large"`, sometimes with " · "
 *  as the separator instead of ", ". Both `screen.json`'s `ds.variant` and a
 *  catalogue variant's `name` go through this before comparing. */
function parseVariantPairs(raw: string): Set<string> {
  const normalized = raw.replace(/\s*·\s*/g, ', ');
  const out = new Set<string>();
  for (const part of normalized.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    out.add(eq === -1
      ? trimmed.toLowerCase()
      : `${trimmed.slice(0, eq).trim().toLowerCase()}=${trimmed.slice(eq + 1).trim().toLowerCase()}`);
  }
  return out;
}

function variantPairsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** WP28: các state PROP=VALUE coi là "đang nghỉ" (bậc 1 của `pickDefaultVariant`). */
const REST_STATE_MARKERS = ['default', 'enabled', 'rest'];

/** WP28: giá trị prop nào rơi vào các state này thì KHÔNG được coi là mặc định
 *  (bậc 2 của `pickDefaultVariant`) — nút "State=Pressed"/"State=Hover" trông
 *  như đang bị bấm/hover ngay khi vừa dựng xong, dù đó không phải trục screen
 *  yêu cầu. */
const NON_REST_STATE_MARKERS = ['pressed', 'hover', 'disabled', 'focus', 'error', 'active', 'selected'];

/** WP28: chọn variant "trạng thái nghỉ" thay vì luôn lấy `variants[0]` — trước
 *  đó, khi screen khai variant không khớp bất kỳ trục nào của component (VD
 *  "Hierarchy=Secondary" trong khi component chỉ có trục Type/Size/State/Icon
 *  Btn), fallback rơi thẳng vào `variants[0]` — với nhiều component DS thật,
 *  `variants[0]` lại là "State=Pressed" (thứ tự Figma trả về không đảm bảo
 *  trạng thái nghỉ đứng đầu) khiến nút dựng ra trông như đang bị bấm.
 *
 *  Dừng ở bậc đầu tiên có ứng viên (KHÔNG partial-match trục của screen —
 *  đây thuần là chọn 1 variant "an toàn" trong chính component, không liên
 *  quan gì đến variant mà screen đã khai):
 *  1. Variant có prop `state` = default|enabled|rest (so trên cặp đã qua
 *     `parseVariantPairs`, case/space-insensitive).
 *  2. Variant KHÔNG có prop nào mang giá trị thuộc {pressed, hover, disabled,
 *     focus, error, active, selected}.
 *  3. `variants[0]` như hành vi cũ.
 *  Nhiều ứng viên cùng bậc → lấy cái đầu tiên (ổn định, không random). */
export function pickDefaultVariant<V extends { name: string }>(variants: readonly V[]): V {
  if (variants.length === 0) {
    throw new Error('pickDefaultVariant: danh sách variants rỗng.');
  }
  for (const variant of variants) {
    const pairs = parseVariantPairs(variant.name);
    if (REST_STATE_MARKERS.some((marker) => pairs.has(`state=${marker}`))) return variant;
  }
  for (const variant of variants) {
    const pairs = parseVariantPairs(variant.name);
    const hasNonRestMarker = [...pairs].some((pair) => {
      const value = pair.includes('=') ? pair.slice(pair.indexOf('=') + 1) : pair;
      return NON_REST_STATE_MARKERS.includes(value);
    });
    if (!hasNonRestMarker) return variant;
  }
  return variants[0]!;
}

/** Element order = order `data-el` first appears in the wireframe DOM (WP25a
 *  decision #4) — falls back to the screen.json elements[] order when there
 *  is no wireframe (should not happen in practice; dr-comp always writes
 *  one, but a hand-edited project could be missing it). */
function elementOrder(wireframeHtml: string | null, knownIds: readonly string[]): string[] {
  if (!wireframeHtml) return [...knownIds];
  const known = new Set(knownIds);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of scanWireframe(wireframeHtml).els) {
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  for (const id of knownIds) if (!seen.has(id)) ordered.push(id);
  return ordered;
}

function buildAnchorIndex(catalog: FigmaComponentCatalogSnapshot): Map<string, { fileKey: string; component: FigmaCatalogComponent }> {
  const index = new Map<string, { fileKey: string; component: FigmaCatalogComponent }>();
  for (const file of catalog.files) {
    for (const component of file.components) {
      index.set(anchorFor(file.fileKey, component.nodeId), { fileKey: file.fileKey, component });
    }
  }
  return index;
}

/** Compiles the daemon-side, TẤT ĐỊNH input the figma-screen-build skill
 *  reads — the agent only imports-by-key, ghép frame, override text,
 *  replace-by-name; it never has to decide WHICH component/variant/key to
 *  use (WP25a decision #4). Pure: no fs/network. */
export function compileScreenBuildInput(opts: CompileScreenBuildInputOptions): ScreenBuildInput {
  const { screenDoc, wireframeHtml, catalog, previewFileKey, appFeature, mockups } = opts;
  const anchorIndex = buildAnchorIndex(catalog);
  const byId = new Map(screenDoc.elements.map((el) => [el.id, el] as const));
  const order = elementOrder(wireframeHtml, screenDoc.elements.map((el) => el.id));
  // WP29: cây bố cục thật — chỉ có khi có wireframe (không thì elements[]
  // vẫn xếp phẳng như v1, xem docblock `ScreenBuildInput.layout`).
  const layout = wireframeHtml ? buildWireframeLayoutTree(wireframeHtml, screenDoc.elements.map((el) => el.id)) : null;

  let dsFileKey: string | null = null;
  const elements: ScreenBuildInputElement[] = [];

  for (const id of order) {
    const el = byId.get(id);
    if (!el) continue;
    const base: ScreenBuildInputElement = {
      id: el.id,
      role: el.role,
      label: el.label,
      ...(el.content ? { content: el.content } : {}),
    };
    if (!el.ds) {
      elements.push(base);
      continue;
    }
    const found = anchorIndex.get(el.ds.anchor);
    if (!found) {
      elements.push({
        ...base,
        warning: `Component "${el.ds.component}" (anchor ${el.ds.anchor}) không còn trong danh mục Figma — bỏ qua, dựng phần tử thường.`,
      });
      continue;
    }
    if (!dsFileKey) dsFileKey = found.fileKey;
    const { component } = found;
    if (component.variants && component.variants.length > 0) {
      const wanted = el.ds.variant ? parseVariantPairs(el.ds.variant) : null;
      let chosen = pickDefaultVariant(component.variants);
      let warning: string | undefined;
      if (wanted) {
        const match = component.variants.find((v) => variantPairsEqual(parseVariantPairs(v.name), wanted));
        if (match) chosen = match;
        else warning = `Variant "${el.ds.variant}" không khớp component "${component.name}" — dùng mặc định "${chosen.name}".`;
      } else if (component.variants.length > 1) {
        warning = `Element "${el.id}" không khai variant cho component "${component.name}" — dùng mặc định "${chosen.name}".`;
      }
      elements.push({
        ...base,
        component: {
          name: component.name,
          ...(chosen.key ? { key: chosen.key } : {}),
          variantNodeId: chosen.nodeId,
          setNodeId: component.nodeId,
          ...(el.ds.variant ? { variant: el.ds.variant } : {}),
        },
        ...(warning ? { warning } : {}),
      });
    } else {
      elements.push({
        ...base,
        component: { name: component.name, ...(component.key ? { key: component.key } : {}) },
      });
    }
  }

  return {
    schema_version: SCREEN_BUILD_INPUT_SCHEMA_VERSION,
    screenKey: screenDoc.key,
    screenName: screenDoc.name,
    appFeature,
    previewFileKey,
    dsFileKey,
    platform: screenDoc.platform,
    pageName: `[OD] ${appFeature}`,
    frameName: `${screenDoc.key} — ${screenDoc.name}`,
    elements,
    ...(layout ? { layout } : {}),
    ...(mockups && mockups.length > 0 ? { mockups } : {}),
    rules: {
      scope: `CHỈ thao tác trên file preview "${previewFileKey}" — TUYỆT ĐỐI không mở/sửa file Figma nào khác (kể cả file DS, ngoài việc import component theo key).`,
      naming: `Trang tên "[OD] ${appFeature}" (tạo nếu chưa có, tái dùng nếu có); frame tên "${screenDoc.key} — ${screenDoc.name}".`,
      idempotent: 'Trước khi dựng: tìm frame trùng tên trong page — có thì nhớ {x,y} rồi XÓA, dựng lại đúng vị trí cũ; không có thì xếp lưới cạnh frame "[OD]" gần nhất (không đè node khác).',
    },
  };
}
