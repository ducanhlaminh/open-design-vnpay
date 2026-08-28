// web-band — thuần (không I/O): hộp DOM của một trang WEB đã render → chuỗi band
// bố cục → signature / sketch ASCII 40 cột / topic `web-*`. Dùng bởi
// `build-web.mjs` (tầng 2 layout-kb, dữ liệu thật) và test `web-band.test.mjs`.
//
// Đầu vào `elements[]` (thứ tự tài liệu, cha trước con), mỗi phần tử:
//   { tag, role?, cls?, x, y, w, h, n?: số con, inputs?: số input/select/textarea
//     bên trong, txt?: độ dài text, num?: text là số (KPI), hd?: cấp heading }
// `viewport = { w, h, docH? }` (docH = chiều cao trang; mặc định = h).
//
// Pipeline (giống Enrico build.mjs nhưng cho khung web):
//   kindOf(el)          — tag/role/class → kind thô (sidenav, topbar, table, card, input …)
//   structuralRegions   — sidenav (cột trái) · topbar/header-nav · footer · modal
//   resolveUnits        — container (card/form) nhìn con để quyết kind; bỏ con của unit đục
//   groupRows/classify  — gom hàng theo y trong vùng nội dung → band (table, form-2col, kpi-cards …)
//   collapse            — gộp hàng lặp/trùng; filterbar = hàng input/nút ngay trước table
//   sketchFor           — 12 dòng × 40 cột, sidenav chiếm 8 cột trái khi có
//   topicFor            — tên trang/URL + band → web-table | web-form | … (8 topic Hợp đồng)

export const WEB_BAND_VOCAB = [
  'topbar', 'sidenav', 'breadcrumb', 'filterbar', 'table', 'pagination', 'kpi-cards', 'chart', 'tabs', 'kv',
  'form-2col', 'form', 'actions', 'modal', 'header-nav', 'hero', 'cards-3', 'footer', 'stepper', 'summary',
  // band phụ khi dữ liệu thật không khớp vocab chính
  'cards-2', 'card', 'list', 'image', 'text', 'empty',
];

export const WEB_TOPICS = ['web-table', 'web-detail', 'web-form', 'web-dashboard', 'web-settings', 'web-auth', 'web-list', 'web-wizard'];

export const SKETCH_W = 40;
export const SKETCH_LINES = 12;
export const SIDENAV_COLS = 8; // 7 ký tự + vạch dọc
const ROW_GAP_PX = 12;
const MAX_BANDS = 9;

// ── kind thô ───────────────────────────────────────────────────────────────

const INPUT_TAGS = new Set(['input', 'select', 'textarea']);

/** Kind thô của 1 phần tử từ tag + role + class (chưa nhìn hình học/con). `null` = wrapper vô nghĩa. */
export function kindOf(el) {
  const tag = String(el.tag ?? '').toLowerCase();
  const role = String(el.role ?? '').toLowerCase();
  const cls = ` ${String(el.cls ?? '').toLowerCase().replace(/\s+/g, ' ')} `;
  const has = (re) => re.test(cls);
  if (has(/ modal-backdrop /)) return null;
  if (role === 'dialog' || role === 'alertdialog' || has(/ (modal|modal-dialog|dialog|offcanvas) /)) return 'modal';
  if (tag === 'aside' || has(/ (sidebar|sidenav|side-nav|app-sidebar|main-sidebar|navbar-vertical|left-nav|drawer) /)) return 'sidenav';
  if (has(/ (breadcrumb|breadcrumbs) /) || (role === 'navigation' && has(/breadcrumb/))) return 'breadcrumb';
  if (tag === 'header' || role === 'banner' || has(/ (navbar|app-header|main-header|topbar|top-nav|site-header|navbar-expand[a-z-]*) /)) return 'topbar';
  if (tag === 'footer' || role === 'contentinfo' || has(/ (footer|app-footer|main-footer) /)) return 'footer';
  if (has(/ (pagination|paginate|page-link|pager) /)) return 'pagination';
  if (role === 'tablist' || has(/ (nav-tabs|nav-pills|tabs|tab-nav|card-tabs) /)) return 'tabs';
  if (has(/ (stepper|steps|bs-stepper|wizard|step-item|steps-vertical) /)) return 'stepper';
  if (tag === 'table' || role === 'table' || role === 'grid' || has(/ (table|datatable|data-table) /)) return 'table';
  if (tag === 'canvas' || has(/ (chart|charts|apexcharts|apexcharts-canvas|graph|sparkline|chart-lg|chart-sm) /)) return 'chart';
  if (has(/ (hero|jumbotron|banner|cover) /)) return 'hero';
  if (has(/ (page-header|page-title|page-pretitle) /)) return 'title';
  if (has(/ (empty|empty-state|blank-state) /)) return 'empty';
  if (has(/ (small-box|info-box|kpi|stat|stats|widget-number|counter) /)) return 'kpi';
  if (tag === 'form' || has(/ (form|form-horizontal) /)) return 'form';
  if (INPUT_TAGS.has(tag) || has(/ (form-control|form-select|form-selectgroup|input-group) /)) return 'input';
  if (tag === 'button' || role === 'button' || has(/ (btn|button) /)) return 'button';
  if (tag === 'dl' || has(/ (datagrid|description-list|dl-horizontal|kv|key-value|detail-list) /)) return 'kv';
  if (has(/ (summary|order-summary|cart-summary|total|totals|checkout-summary) /)) return 'summary';
  if (has(/ (card|box|panel|widget|tile|callout|accordion|accordion-item) /)) return 'card';
  if (tag === 'ul' || tag === 'ol' || role === 'list' || has(/ (list-group|list|timeline|feed) /)) return 'list';
  if (tag === 'img' || tag === 'picture' || has(/ (image|thumbnail|avatar|img-fluid|illustration|gallery) /)) return 'image';
  if (/^h[1-6]$/.test(tag) || role === 'heading' || has(/ (page-title|card-title|h1|h2|h3|title) /)) return 'title';
  if (tag === 'p' || role === 'paragraph' || has(/ (text|lead|text-muted) /)) return 'text';
  if (tag === 'svg' && Number(el.w) >= 300 && Number(el.h) >= 150) return 'chart';
  return null;
}

// ── hình học ───────────────────────────────────────────────────────────────

const right = (b) => b.x + b.w;
const bottom = (b) => b.y + b.h;
const area = (b) => Math.max(0, b.w) * Math.max(0, b.h);
const contains = (outer, inner, tol = 2) =>
  inner.x >= outer.x - tol && inner.y >= outer.y - tol && right(inner) <= right(outer) + tol && bottom(inner) <= bottom(outer) + tol;
const inside = (box, region) => !!region && contains(region, box, 4);

/** Sidenav (cột trái) · topbar/header-nav · footer · modal — từ kind thô + vị trí. */
export function structuralRegions(elements, viewport) {
  const W = Math.max(1, viewport?.w ?? 1440);
  const H = Math.max(1, viewport?.h ?? 900);
  const docH = Math.max(H, viewport?.docH ?? H);
  let sidenav = null;
  let topbar = null;
  let footer = null;
  let modal = null;
  for (const el of elements) {
    const k = kindOf(el);
    if (!k) continue;
    if (k === 'sidenav' && el.x <= W * 0.1 && el.w >= 120 && el.w <= W * 0.35 && el.h >= H * 0.5) {
      if (!sidenav || area(el) > area(sidenav)) sidenav = { ...el };
    } else if (k === 'topbar' && el.y <= H * 0.15 && el.h <= H * 0.25 && el.w >= W * 0.45) {
      // Nhiều thanh ngang kề nhau trên đỉnh (navbar + menu bar) → gộp thành 1 vùng topbar.
      if (!topbar) topbar = { ...el };
      else if (el.y <= bottom(topbar) + 10 && bottom(el) >= topbar.y - 10) {
        const y1 = Math.min(topbar.y, el.y);
        const y2 = Math.max(bottom(topbar), bottom(el));
        const x1 = Math.min(topbar.x, el.x);
        const x2 = Math.max(right(topbar), right(el));
        topbar = { ...topbar, x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      } else if (area(el) > area(topbar)) topbar = { ...el };
    } else if (k === 'footer' && el.w >= W * 0.4 && bottom(el) >= docH * 0.7 && el.h <= H * 0.6) {
      if (!footer || area(el) > area(footer)) footer = { ...el };
    } else if (k === 'modal' && area(el) >= W * H * 0.05 && el.w <= W * 0.9) {
      if (!modal || area(el) > area(modal)) modal = { ...el };
    }
  }
  // topbar nằm trong sidenav (logo) → không phải topbar.
  if (topbar && sidenav && inside(topbar, sidenav)) topbar = null;
  return { sidenav, topbar, footer, modal, W, H, docH };
}

// ── unit ───────────────────────────────────────────────────────────────────

const OPAQUE = new Set(['table', 'chart', 'tabs', 'pagination', 'breadcrumb', 'stepper', 'kv', 'list', 'hero', 'kpi', 'summary', 'image', 'input', 'button', 'title', 'text', 'form', 'card', 'empty']);

/** Cột input trong 1 container: gom theo x (bước 40px) — ≥2 cột có hàng y trùng → form 2 cột. */
function inputColumns(inputs) {
  if (inputs.length < 2) return 1;
  const cols = [];
  for (const u of inputs) {
    const c = cols.find((col) => Math.abs(col.x - u.x) <= 40);
    if (c) c.items.push(u);
    else cols.push({ x: u.x, items: [u] });
  }
  if (cols.length < 2) return 1;
  // Chỉ tính là 2 cột khi có cặp input ở 2 cột chồng dải y (cùng hàng) VÀ có ≥2 hàng
  // (một hàng input đơn lẻ là filterbar/1 dòng, không phải form 2 cột).
  const yRows = [];
  for (const u of inputs) if (!yRows.some((y) => Math.abs(y - u.y) <= 20)) yRows.push(u.y);
  if (yRows.length < 2) return 1;
  const [a, b] = cols.sort((p, q) => q.items.length - p.items.length);
  for (const u of a.items) for (const v of b.items) if (u.y < bottom(v) && v.y < bottom(u)) return Math.min(cols.length, 3);
  return 1;
}

/** Từ phần tử thô → unit đã phân giải (container nhìn con). Bỏ phần tử trong vùng cấu trúc. */
export function resolveUnits(elements, regions) {
  const els = elements
    .map((el, i) => ({ ...el, i, k: kindOf(el) }))
    .filter((el) => el.k && el.w >= 8 && el.h >= 6 && !['sidenav', 'topbar', 'footer', 'modal'].includes(el.k));
  // Sidenav thường `position: fixed` cao = viewport nhưng menu bên trong tràn xuống dưới →
  // loại mọi phần tử nằm trong DẢI X của sidenav (không xét y).
  const inSideCol = (el) => !!regions.sidenav && el.x >= regions.sidenav.x - 4 && right(el) <= right(regions.sidenav) + 4;
  const inStructural = (el) => inSideCol(el) || (regions.topbar && inside(el, regions.topbar)) || (regions.footer && inside(el, regions.footer));
  const cands = els.filter((el) => !inStructural(el));
  const mainW = regions.W - (regions.sidenav ? regions.sidenav.w : 0);
  const units = [];
  const opaque = [];
  for (let idx = 0; idx < cands.length; idx += 1) {
    const el = cands[idx];
    if (opaque.some((o) => contains(o, el))) continue;
    let kind = el.k;
    const kids = [];
    for (let j = idx + 1; j < cands.length; j += 1) if (contains(el, cands[j])) kids.push(cands[j]);
    const kidKinds = new Set(kids.map((k) => k.k));
    const inputs = kids.filter((k) => k.k === 'input');
    const nInputs = Math.max(inputs.length, Number(el.inputs ?? 0));
    let cols = 1;
    if (kind === 'card' || kind === 'form' || kind === 'hero' || kind === 'modal') {
      if (kidKinds.has('table')) kind = 'table';
      else if (kidKinds.has('stepper')) kind = 'stepper';
      else if (kind === 'card' && (kidKinds.has('card') || kidKinds.has('kpi'))) continue; // nhóm card → trong suốt
      else if (nInputs >= 2) {
        kind = 'form';
        cols = inputColumns(inputs);
      } else if (kidKinds.has('chart') && kind !== 'form' && nInputs === 0) kind = 'chart';
      else if (kind === 'card' && kidKinds.has('kv')) kind = 'kv';
      else if (kind === 'card' && kidKinds.has('list') && nInputs === 0) kind = 'list';
      else if (kind === 'card' && kidKinds.has('tabs')) kind = 'tabs';
      else if (kind === 'card' && el.h <= 220 && el.w <= mainW * 0.4 && (el.num || kids.some((k) => k.num) || (el.txt ?? 0) <= 80)) kind = 'kpi';
      else if (kind === 'form' && nInputs === 1) kind = 'input';
      else if (kind === 'form' && nInputs === 0) {
        if (kids.some((k) => k.k === 'button')) kind = 'actions';
        else continue; // form rỗng (vd form tìm kiếm ẩn) → trong suốt
      }
    }
    if (kind === 'form' && cols === 1 && inputs.length >= 2) cols = inputColumns(inputs);
    const unit = { kind, x: el.x, y: el.y, w: el.w, h: el.h, n: nInputs || undefined, cols, hd: el.hd };
    units.push(unit);
    if (OPAQUE.has(kind) || kind === 'actions') opaque.push(el);
  }
  return units;
}

// ── hàng → band ────────────────────────────────────────────────────────────

export function groupRows(units) {
  const sorted = [...units].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const u of sorted) {
    const cur = rows[rows.length - 1];
    if (cur && u.y <= cur.y2 - ROW_GAP_PX) {
      cur.units.push(u);
      cur.y2 = Math.max(cur.y2, bottom(u));
    } else rows.push({ y1: u.y, y2: bottom(u), units: [u] });
  }
  return rows;
}

/** Hàng cao (≥300px) có 2 cột không chồng x (nội dung chính + panel phụ ≥20% rộng)
 *  → phân loại theo cột chính (rộng nhất), cột phụ thành band `summary` đi kèm. */
function splitColumns(row, mainW) {
  if (row.y2 - row.y1 < 300 || row.units.length < 2) return null;
  const dom = [...row.units].sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const overlapX = (u) => Math.min(right(u), right(dom)) - Math.max(u.x, dom.x) > Math.min(u.w, dom.w) * 0.5;
  const main = row.units.filter(overlapX);
  const aside = row.units.filter((u) => !overlapX(u));
  if (!aside.length) return null;
  const asideW = Math.max(...aside.map((u) => u.w));
  const asideH = aside.reduce((a, u) => a + u.h, 0);
  if (asideW < mainW * 0.2 || asideH < 200 || asideW > dom.w) return null;
  // Lưới card/ô cùng cỡ (gallery, cards-3, kpi) không phải "nội dung + panel phụ".
  if (aside.some((u) => Math.abs(u.w - dom.w) <= dom.w * 0.15)) return null;
  if (!aside.some((u) => ['card', 'kpi', 'summary', 'kv', 'list', 'form', 'text', 'image', 'title'].includes(u.kind))) return null;
  return { main, aside };
}

export function classifyRow(row, mainW) {
  const split = splitColumns(row, mainW);
  if (split) return `${classifyRow({ y1: row.y1, y2: row.y2, units: split.main }, mainW)}+summary`;
  const by = (k) => row.units.filter((u) => u.kind === k);
  const kinds = new Set(row.units.map((u) => u.kind));
  const cards = by('card');
  const kpis = by('kpi');
  const inputs = by('input');
  const buttons = by('button');
  const forms = by('form');
  if (kinds.has('stepper')) return 'stepper';
  if (kinds.has('empty')) return 'empty';
  if (kinds.has('breadcrumb')) return 'breadcrumb';
  if (kinds.has('pagination')) return 'pagination';
  if (kinds.has('table')) return 'table';
  if (kpis.length >= 2 || (cards.length >= 3 && cards.every((c) => c.h <= 240))) return 'kpi-cards';
  if (kinds.has('chart')) return 'chart';
  if (kinds.has('tabs')) return 'tabs';
  if (kinds.has('hero')) return 'hero';
  if (forms.length) return forms.some((f) => f.cols >= 2) ? 'form-2col' : `form(${Math.min(9, forms.reduce((a, f) => a + (f.n ?? 2), 0))})`;
  const oneLine = row.y2 - row.y1 <= 64;
  if (inputs.length >= 1 && oneLine && buttons.length) return 'filterbar';
  if (inputs.length >= 2 && !oneLine) return inputColumns(inputs) >= 2 ? 'form-2col' : `form(${Math.min(9, inputs.length)})`;
  if (inputs.length >= 1) return 'input';
  if (kinds.has('summary')) return 'summary';
  if (kinds.has('kv')) return 'kv';
  if (cards.length >= 3) return 'cards-3';
  if (cards.length === 2) return 'cards-2';
  if (cards.length === 1) return kinds.has('list') ? 'list' : 'card';
  if (kinds.has('list')) return 'list';
  if (buttons.length && kinds.size === 1) return 'actions';
  if (kpis.length === 1) return 'card';
  if (by('image').some((u) => u.w >= mainW * 0.3)) return 'image';
  if (kinds.has('image') && kinds.has('title')) return 'hero';
  if (buttons.length) return 'actions';
  if (kinds.has('title') || kinds.has('text')) return 'text';
  return 'text';
}

export const stripCount = (b) => b.replace(/\(\d+\)$/, '');

/** Gộp hàng: trùng liền kề giữ 1 (form cộng số); `input` ×≥2 → form; hàng input/nút ngay trước table → filterbar. */
export function collapse(rowKinds) {
  const bands = [];
  for (const k of rowKinds) {
    const prev = bands[bands.length - 1];
    if (prev !== undefined && k !== 'input' && stripCount(prev) === stripCount(k)) {
      if (/^form\(/.test(prev)) bands[bands.length - 1] = `form(${Math.min(9, Number(prev.slice(5, -1)) + Number(k.slice(5, -1)))})`;
      continue;
    }
    bands.push(k);
  }
  const out = [];
  for (let i = 0; i < bands.length; i += 1) {
    const b = bands[i];
    if (b === 'input') {
      let j = i;
      while (j < bands.length && bands[j] === 'input') j += 1;
      const n = j - i;
      if (n >= 2) out.push(`form(${Math.min(9, n)})`);
      else out.push(bands[i + 1] === 'table' ? 'filterbar' : 'input');
      i = j - 1;
      continue;
    }
    if ((/^form\(/.test(b) || b === 'actions' || b === 'filterbar') && bands[i + 1] === 'table' && (b === 'filterbar' || (b === 'actions') || Number(b.slice(5, -1)) <= 4)) {
      out.push('filterbar');
      continue;
    }
    out.push(b);
  }
  // text › text sau gộp filterbar vẫn có thể trùng → gộp lần cuối
  return out.filter((b, i) => i === 0 || stripCount(out[i - 1]) !== stripCount(b));
}

/** Toàn bộ: elements + viewport → { bands, sidenav, topbar, footer, modal, units, rows }. */
export function bandsFromBoxes(elements, viewport = { w: 1440, h: 900 }) {
  const regions = structuralRegions(elements, viewport);
  const mainW = regions.W - (regions.sidenav ? regions.sidenav.w : 0);
  const units = resolveUnits(elements, regions);
  const rows = groupRows(units);
  const rowKinds = rows.flatMap((r) => classifyRow(r, mainW).split('+'));
  const body = collapse(rowKinds);
  const bands = [];
  if (regions.modal) bands.push('modal');
  if (regions.topbar) bands.push(regions.sidenav ? 'topbar' : 'header-nav');
  if (regions.sidenav) bands.push('sidenav');
  bands.push(...body.slice(0, MAX_BANDS));
  if (regions.footer) bands.push('footer');
  if (!body.length) bands.push('empty');
  return { bands, sidenav: !!regions.sidenav, topbar: !!regions.topbar, footer: !!regions.footer, modal: !!regions.modal, units, rows, regions };
}

export const signatureOf = (bands) => bands.map(stripCount).join(' › ');

export const slugOf = (bands) =>
  bands
    .map(stripCount)
    .map((b) => b.replace(/[^a-z0-9]+/g, ''))
    .join('-')
    .slice(0, 48);

// ── sketch ASCII 40 cột ─────────────────────────────────────────────────────

const fit = (s, w) => {
  const t = [...s].slice(0, w).join('');
  return t + ' '.repeat(Math.max(0, w - [...t].length));
};

/** Mẫu dòng theo band cho vùng nội dung (rộng tuỳ có sidenav). `{w}` = phần cần lặp/kéo dài. */
const BAND_LINES = {
  breadcrumb: ['Trang chủ › Mục › Trang'],
  filterbar: ['[Từ khoá  ] [Trạng thái ▾] [Tìm] [+ Thêm]'],
  table: ['┌──────┬─────────┬───────┬──────┬────┐', '│ Mã   │ Tên     │ Ngày  │ TT   │ ⋯  │', '├──────┼─────────┼───────┼──────┼────┤', '│ ───  │ ──────  │ ────  │ ●    │ ✎ ✕│', '│ ───  │ ──────  │ ────  │ ●    │ ✎ ✕│'],
  pagination: ['Hiển thị 1–10 / 128        ‹ 1 2 3 … ›'],
  'kpi-cards': ['[ 1.284 ] [ 96,5% ] [ 32   ] [ 4,1 tỷ ]'],
  chart: ['┌─ Biểu đồ ─────────────────────────┐', '│  ▁▂▃▅▆▇▆▅▃▂▁▂▃▅▇ ▂▃                │', '└───────────────────────────────────┘'],
  tabs: ['Tổng quan | Chi tiết | Lịch sử | Tệp'],
  kv: ['Mã KH        ─────────', 'Trạng thái   ● Hoạt động', 'Ngày tạo     ──/──/────'],
  'form-2col': ['Nhãn ________   Nhãn ________', 'Nhãn ________   Nhãn ________'],
  form: ['Nhãn ______________________', 'Nhãn ______________________'],
  input: ['Nhãn ______________________'],
  actions: ['                  [ Huỷ ] [ Lưu ]'],
  modal: ['░░░░ ┌─ Hộp thoại ─────────┐ ░░░░', '░░░░ │ Nhãn ____________     │ ░░░░', '░░░░ │       [ Huỷ ] [ OK ]  │ ░░░░'],
  hero: ['╭──────────────────────────────╮', '│  TIÊU ĐỀ LỚN   [ Bắt đầu ]   │', '╰──────────────────────────────╯'],
  'cards-3': ['┌────────┐ ┌────────┐ ┌────────┐', '│ ▢ ──── │ │ ▢ ──── │ │ ▢ ──── │', '└────────┘ └────────┘ └────────┘'],
  'cards-2': ['┌─────────────┐ ┌─────────────┐', '│ ──── ────   │ │ ──── ────   │', '└─────────────┘ └─────────────┘'],
  card: ['┌─────────────────────────────┐', '│ ──────── ──────  ─────      │', '└─────────────────────────────┘'],
  stepper: ['(1) Thông tin ── (2) Xác nhận ── (3) Xong'],
  summary: ['┌ Tóm tắt ────────┐', '│ Tổng   1.200.000 │', '└──────────────────┘'],
  list: ['▢ ───────────── ···', '▢ ───────────── ···', '▢ ───────────── ···'],
  image: ['╭────────────────────╮', '│      ✕  ảnh  ✕     │', '╰────────────────────╯'],
  text: ['Tiêu đề trang', '──────────── ──────'],
  empty: ['', '        (∅) Chưa có dữ liệu', '            [ + Tạo mới ]'],
};

const GROW = ['table', 'form', 'form-2col', 'list', 'cards-3', 'cards-2', 'card', 'chart', 'kv', 'image', 'modal', 'empty', 'text'];

/** Sketch 12 dòng × 40 cột. Có sidenav → 8 cột trái là menu, nội dung 30 cột;
 *  không sidenav → nội dung 38 cột. topbar/header-nav = dòng đầu, footer = dòng cuối. */
export function sketchFor(bands, opts = {}) {
  const hasSide = opts.sidenav ?? bands.includes('sidenav');
  const hasTop = bands.includes('topbar') || bands.includes('header-nav');
  const hasFoot = bands.includes('footer');
  const innerW = SKETCH_W - 2;
  const contentW = hasSide ? innerW - SIDENAV_COLS : innerW;
  const body = SKETCH_LINES - 2;
  const mid = body - (hasTop ? 1 : 0) - (hasFoot ? 1 : 0);
  const main = bands.filter((b) => !['topbar', 'header-nav', 'sidenav', 'footer'].includes(b));
  const pick = main.map((b) => BAND_LINES[stripCount(b)] ?? BAND_LINES.text);
  const lines = pick.map(() => 1);
  let left = mid - lines.length;
  let guard = 0;
  while (left > 0 && guard < 60) {
    guard += 1;
    let grew = false;
    for (let k = 0; k < main.length && left > 0; k += 1) {
      const name = stripCount(main[k]);
      const cap = /^(table|list|form|cards)/.test(name) ? Math.max(5, pick[k].length + 1) : pick[k].length;
      if (GROW.includes(name) && lines[k] < cap) {
        lines[k] += 1;
        left -= 1;
        grew = true;
      }
    }
    if (!grew) break;
  }
  const content = [];
  for (let k = 0; k < main.length; k += 1) {
    const repeatLast = stripCount(main[k]) === 'table'; // bảng: dòng dư lặp HÀNG cuối, không lặp header
    for (let l = 0; l < lines[k]; l += 1) content.push(pick[k][repeatLast ? Math.min(l, pick[k].length - 1) : l % pick[k].length]);
  }
  while (content.length < mid) content.push('');
  const side = ['≡ Menu ', '▸ Mục 1', '▸ Mục 2', '▸ Mục 3', '▸ Mục 4', '       '];
  const rows = [];
  if (hasTop) rows.push(`│${fit(bands.includes('header-nav') ? 'Logo   Trang chủ  Sản phẩm  Hỗ trợ   ☺ ▾' : '≡ Logo        [⌕ Tìm kiếm ]      ⚙ ☺ ▾', innerW)}│`);
  for (let i = 0; i < mid; i += 1) {
    const c = fit(content[i] ?? '', contentW);
    rows.push(hasSide ? `│${fit(side[Math.min(i, side.length - 1)], SIDENAV_COLS - 1)}│${c}│` : `│${c}│`);
  }
  if (hasFoot) rows.push(`│${fit('© Công ty · Điều khoản · Liên hệ', innerW)}│`);
  return [`┌${'─'.repeat(innerW)}┐`, ...rows.slice(0, body), `└${'─'.repeat(innerW)}┘`].join('\n');
}

// ── topic ──────────────────────────────────────────────────────────────────

/** Topic `web-*` từ tên trang/URL + band. Ưu tiên: auth/wizard/settings theo tên → thành phần → tên chi tiết → mặc định web-detail. */
export function topicFor({ name = '', url = '', bands = [] } = {}) {
  const n = ` ${`${name} ${url}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const has = (re) => re.test(n);
  const b = new Set(bands.map(stripCount));
  if (has(/ (login|sign in|signin|sign up|signup|register|forgot|password|lockscreen|lock screen|auth|otp|verify) /)) return 'web-auth';
  if (has(/ (wizard|stepper|steps?) /) || b.has('stepper')) return 'web-wizard';
  if (has(/ (settings?|preferences?|account settings|config|configuration) /)) return 'web-settings';
  if (has(/ (dashboard|analytics|overview|index|widgets?|statistics?) /) && (b.has('kpi-cards') || b.has('chart') || b.has('cards-3'))) return 'web-dashboard';
  if (b.has('table')) return 'web-table';
  if (b.has('kpi-cards') || b.has('chart')) return 'web-dashboard';
  if (has(/ (profile|detail|details|invoice|view|record|read|show) /)) return 'web-detail';
  if (b.has('form-2col') || bands.some((x) => /^form\(/.test(x))) return 'web-form';
  if (has(/ (form|edit|create|new|compose) /)) return 'web-form';
  if (b.has('cards-3') || b.has('list')) return 'web-list';
  if (has(/ (list|users|orders|logs|results|search|gallery|projects|pricing|cards|tasks|inbox|kanban|leads?) /)) return 'web-list';
  if (has(/ (empty|404|500|error|maintenance|blank|not found) /)) return 'web-list';
  return 'web-detail';
}
