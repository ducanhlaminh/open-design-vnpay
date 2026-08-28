// layout-kb — kho bố cục tham khảo dựng từ dataset Enrico (Aalto, MIT; 1.460
// màn Android, 20 topic, wireframe PNG + hierarchy JSON) bằng
// `tools/layout-kb/build.mjs` → `~/layout-kb/` (env `LAYOUT_KB_DIR`).
//
// WP dr-mockup-layouts (2026-08-27): stage dr-mockup (skill docs-screen-mockup)
// ra 11/11 màn "1 cột nhiều hàng" vì không có kho pattern nào để tham chiếu.
// Module này cho daemon (1) đọc manifest KB, (2) gán ARCHETYPE cho từng màn
// từ tên/heading/bước (tiếng Việt, không phân biệt dấu) và (3) chọn khuôn bố
// cục + ảnh wireframe tham khảo theo archetype để `prepareScreenComponentInputs`
// (screen-components.ts, opts.layoutKb) đưa vào `mockups/_inputs.json`.
//
// Nguyên tắc: agent vẫn quyết bố cục cuối; ảnh mockup BA (nếu có) THẮNG KB;
// KB chỉ là gợi ý có cấu trúc. KB vắng → mọi hàm trả null/rỗng, stage chạy
// như trước với catalogue trong skill. Pure (không DB, không agent).
//
// WP layout-kb-web (2026-08-28): manifest schema_version 2 — mỗi topic có
// `platform: 'mobile' | 'web'` (vắng = mobile, manifest v1 đọc y hệt) + `sources[]`
// cấp file. Topic web tiền tố `web-` (`tools/layout-kb/web-templates.json` tầng 1,
// `build-web.mjs` tầng 2). `layoutRefsFor(kb, archetype, platform)`: màn web CHỈ
// nhận topic web (bảng `WEB_ARCHETYPE_TOPICS`); KB không có topic web → refs rỗng
// (màn web rơi về catalogue trong skill). Archetype thêm `table`/`dashboard`,
// chỉ gán khi platform web. Màn mobile: byte-identical với trước.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ScreenInput } from './screen-components.js';

export type Archetype =
  | 'list'
  | 'picker'
  | 'detail'
  | 'form'
  | 'checkout'
  | 'result'
  | 'status'
  | 'overlay'
  | 'home'
  | 'settings'
  | 'content'
  /** WP layout-kb-web: chỉ gán khi platform web (bảng/danh sách quản trị). */
  | 'table'
  /** WP layout-kb-web: chỉ gán khi platform web (tổng quan/thống kê/báo cáo). */
  | 'dashboard';

export type LayoutKbPlatform = 'mobile' | 'web';

export interface LayoutKbTemplate {
  /** `<topic>-<slug>` — ổn định giữa các lần rebuild cùng dữ liệu. */
  id: string;
  /** Chuỗi band trên→dưới, vd `['appbar', 'search', 'list', 'fab']`. */
  bands: string[];
  /** Sketch ASCII (≈12 dòng) minh hoạ bố cục. */
  sketch: string;
  /** Id màn Enrico đại diện cho khuôn này. */
  samples: string[];
}

export interface LayoutKbSample {
  id: string;
  /** Đường dẫn tương đối KB dir, vd `wireframes/123.png`. */
  wireframe: string;
  bands: string[];
}

export interface LayoutKbTopic {
  count: number;
  templates: LayoutKbTemplate[];
  samples: LayoutKbSample[];
  /** Schema 2: nền tảng của topic; manifest v1 (vắng) → `mobile`. */
  platform: LayoutKbPlatform;
}

export interface LayoutKbSource {
  id: string;
  license: string;
  note?: string;
}

export interface LayoutKbManifest {
  schema_version: number;
  source: string;
  license: string;
  builtAt: string;
  topics: Record<string, LayoutKbTopic>;
  /** Schema 2: nguồn dữ liệu cấp file (enrico MIT + web-templates viết tay + …). */
  sources?: LayoutKbSource[];
}

export interface LayoutKb {
  dir: string;
  manifest: LayoutKbManifest;
}

export interface ArchetypeGuess {
  id: Archetype;
  /** `high` khi ≥2 từ khoá trúng (tên màn được tính thêm 1). */
  confidence: 'high' | 'low';
}

export interface LayoutRefs {
  /** Topic có trong KB (Enrico cho mobile, `web-*` cho web) được dùng cho archetype này. */
  topics: string[];
  templates: Array<{ id: string; bands: string[]; sketch: string }>;
  /** Đường dẫn TUYỆT ĐỐI ảnh wireframe tham khảo (≤4). */
  images: string[];
}

export const LAYOUT_KB_MANIFEST = 'manifest.json';

/** Topic Enrico (mobile) ưu tiên cho từng archetype (thứ tự = mức ưu tiên).
 *  `table`/`dashboard` không bao giờ được gán cho màn mobile — mapping chỉ để
 *  Record đủ khoá (rơi về list/home). */
export const ARCHETYPE_TOPICS: Record<Archetype, string[]> = {
  list: ['list', 'news', 'gallery'],
  picker: ['list', 'search', 'menu'],
  detail: ['news', 'profile', 'gallery'],
  form: ['form', 'login'],
  checkout: ['form'],
  result: ['modal', 'tutorial'],
  status: ['modal'],
  overlay: ['modal'],
  home: ['profile', 'news', 'gallery'],
  settings: ['settings'],
  content: ['news', 'list'],
  table: ['list', 'news'],
  dashboard: ['profile', 'news', 'gallery'],
};

/** WP layout-kb-web: topic web (`platform: 'web'`) ưu tiên cho từng archetype
 *  khi màn là web. Màn web KHÔNG bao giờ nhận topic mobile. */
export const WEB_ARCHETYPE_TOPICS: Record<Archetype, string[]> = {
  list: ['web-table', 'web-list'],
  table: ['web-table'],
  detail: ['web-detail'],
  form: ['web-form', 'web-wizard'],
  checkout: ['web-form', 'web-wizard'],
  result: ['web-detail', 'web-dashboard'],
  status: ['web-detail', 'web-dashboard'],
  overlay: ['web-form'],
  picker: ['web-form'],
  home: ['web-dashboard', 'web-list'],
  dashboard: ['web-dashboard', 'web-list'],
  settings: ['web-settings'],
  content: ['web-detail', 'web-list'],
};

const MAX_TEMPLATES = 4;
const MAX_IMAGES = 4;

// ── KB dir + manifest ──────────────────────────────────────────────────────

/** env `LAYOUT_KB_DIR` → `~/layout-kb`. `null` khi không có `manifest.json`. */
export async function resolveLayoutKbDir(): Promise<string | null> {
  const envDir = (process.env.LAYOUT_KB_DIR ?? '').trim();
  const dir = envDir || path.join(os.homedir(), 'layout-kb');
  const ok = await fs
    .stat(path.join(dir, LAYOUT_KB_MANIFEST))
    .then((st) => st.isFile())
    .catch(() => false);
  return ok ? dir : null;
}

const cache = new Map<string, { mtimeMs: number; kb: LayoutKb }>();

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Đọc + kiểm khuôn manifest (chịu được field thiếu). `null` khi file hỏng. */
export function parseLayoutKbManifest(raw: string): LayoutKbManifest | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(json) || !isRecord(json.topics)) return null;
  const topics: Record<string, LayoutKbTopic> = {};
  for (const [name, t] of Object.entries(json.topics)) {
    if (!isRecord(t)) continue;
    const templates: LayoutKbTemplate[] = [];
    for (const tpl of Array.isArray(t.templates) ? t.templates : []) {
      if (!isRecord(tpl) || typeof tpl.id !== 'string') continue;
      templates.push({
        id: tpl.id,
        bands: strArr(tpl.bands),
        sketch: typeof tpl.sketch === 'string' ? tpl.sketch : '',
        samples: strArr(tpl.samples),
      });
    }
    const samples: LayoutKbSample[] = [];
    for (const s of Array.isArray(t.samples) ? t.samples : []) {
      if (!isRecord(s) || typeof s.id !== 'string' || typeof s.wireframe !== 'string') continue;
      samples.push({ id: s.id, wireframe: s.wireframe, bands: strArr(s.bands) });
    }
    // Schema 2: `platform` trên topic; vắng/lạ (manifest v1) → mobile.
    const platform: LayoutKbPlatform = t.platform === 'web' ? 'web' : 'mobile';
    topics[name] = { count: typeof t.count === 'number' ? t.count : samples.length, templates, samples, platform };
  }
  const sources: LayoutKbSource[] = [];
  for (const s of Array.isArray(json.sources) ? json.sources : []) {
    if (!isRecord(s) || typeof s.id !== 'string') continue;
    sources.push({
      id: s.id,
      license: typeof s.license === 'string' ? s.license : '',
      ...(typeof s.note === 'string' ? { note: s.note } : {}),
    });
  }
  return {
    schema_version: typeof json.schema_version === 'number' ? json.schema_version : 1,
    source: typeof json.source === 'string' ? json.source : 'enrico',
    license: typeof json.license === 'string' ? json.license : 'MIT',
    builtAt: typeof json.builtAt === 'string' ? json.builtAt : '',
    topics,
    ...(sources.length ? { sources } : {}),
  };
}

/** Số topic theo nền tảng trong manifest (schema 1 → toàn bộ là mobile). */
export function countLayoutKbTopics(manifest: LayoutKbManifest): { mobile: number; web: number } {
  let mobile = 0;
  let web = 0;
  for (const t of Object.values(manifest.topics)) {
    if (t.platform === 'web') web += 1;
    else mobile += 1;
  }
  return { mobile, web };
}

/** Đọc manifest, cache theo mtime của `manifest.json`. `null` khi vắng/hỏng. */
export async function loadLayoutKb(dir: string): Promise<LayoutKb | null> {
  const file = path.join(dir, LAYOUT_KB_MANIFEST);
  const st = await fs.stat(file).catch(() => null);
  if (!st || !st.isFile()) return null;
  const hit = cache.get(dir);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.kb;
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  const manifest = raw != null ? parseLayoutKbManifest(raw) : null;
  if (!manifest) return null;
  const kb: LayoutKb = { dir, manifest };
  cache.set(dir, { mtimeMs: st.mtimeMs, kb });
  return kb;
}

// ── Archetype ──────────────────────────────────────────────────────────────

/** Bỏ dấu tiếng Việt + hạ chữ thường, gom khoảng trắng — để so từ khoá không
 *  phụ thuộc dấu ("Đăng ký" ≡ "dang ky"). */
export function foldVi(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Từ khoá (đã bỏ dấu) theo archetype. Thứ tự mảng = ưu tiên khi hoà điểm
 *  (result trước checkout: "Thanh toán thành công" là màn kết quả). */
const ARCHETYPE_KEYWORDS: Array<[Archetype, string[]]> = [
  ['result', ['thanh cong', 'that bai', 'ket qua', 'timeout', 'hoan tat', 'hoan thanh', 'giao dich loi', 'khong thanh cong']],
  ['checkout', ['thanh toan', 'don hang', 'gio hang', 'checkout', 'tong tien', 'xac nhan don', 'xac nhan thanh toan', 'xac nhan giao dich']],
  ['status', ['dang xu ly', 'cho xu ly', 'dang cho', 'dang tai', 'processing', 'loading', 'xu ly giao dich']],
  ['form', ['nhap', 'thong tin', 'dang ky', 'form', 'bieu mau', 'khai bao', 'dien thong tin', 'cap nhat thong tin']],
  ['picker', ['chon', 'lua chon', 'picker', 'select']],
  ['list', ['danh sach', 'list', 'lich su', 'ket qua tim kiem', 'tim kiem']],
  ['detail', ['chi tiet', 'detail']],
  ['overlay', ['dialog', 'popup', 'pop up', 'sheet', 'modal', 'canh bao', 'xac nhan']],
  ['home', ['trang chu', 'home', 'man hinh chinh', 'dashboard']],
  ['settings', ['cai dat', 'thiet lap', 'settings', 'cau hinh']],
];

/** WP layout-kb-web: từ khoá CHỈ dùng khi platform web, xét TRƯỚC bảng chung
 *  (hoà điểm → mục đứng trước thắng: "Danh sách giao dịch" web → `table`,
 *  "Trang chủ / dashboard" web → `dashboard`). */
const WEB_ARCHETYPE_KEYWORDS: Array<[Archetype, string[]]> = [
  ['table', ['danh sach', 'quan ly', 'tra cuu', 'bang', 'list', 'table']],
  ['dashboard', ['tong quan', 'dashboard', 'thong ke', 'bao cao']],
];

const hasWord = (text: string, kw: string): boolean => new RegExp(`(^|\\s)${kw}(\\s|$)`).test(text);

/** Đoán archetype từ tên + heading mục + nhãn bước (+ vị trí trong luồng làm
 *  tie-break: màn cuối luồng không nav ra → `result` nếu chưa có gì trúng).
 *  Chỉ cần các field dùng tới — nhận ScreenInput hoặc object rút gọn.
 *  `platform === 'web'` mở thêm `table`/`dashboard`; vắng/mobile → như cũ. */
export function guessArchetype(
  screen: Pick<ScreenInput, 'name'> & Partial<Pick<ScreenInput, 'section' | 'steps' | 'navOut' | 'navIn'>>,
  platform?: LayoutKbPlatform,
): ArchetypeGuess {
  const name = foldVi(screen.name ?? '');
  const rest = foldVi([screen.section?.heading ?? '', ...(screen.steps ?? []).map((s) => s.label)].join(' . '));
  const all = `${name} . ${rest}`;
  const table = platform === 'web' ? [...WEB_ARCHETYPE_KEYWORDS, ...ARCHETYPE_KEYWORDS] : ARCHETYPE_KEYWORDS;
  let best: { id: Archetype; score: number } | null = null;
  for (const [id, kws] of table) {
    let score = 0;
    let inName = false;
    for (const kw of kws) {
      if (hasWord(all, kw)) {
        score += 1;
        if (hasWord(name, kw)) inName = true;
      }
    }
    if (inName) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { id, score };
  }
  if (best) return { id: best.id, confidence: best.score >= 2 ? 'high' : 'low' };
  const terminal = (screen.navOut?.length ?? 0) === 0 && (screen.navIn?.length ?? 0) > 0;
  return { id: terminal ? 'result' : 'content', confidence: 'low' };
}

// ── Refs ───────────────────────────────────────────────────────────────────

/** Chọn ≤4 khuôn + ≤4 ảnh cho archetype, luân phiên qua các topic ưu tiên
 *  (mỗi topic góp 1 rồi vòng lại) để refs đa dạng. Topic không có trong KB bị
 *  bỏ; KB không có topic nào → `{ topics: [], templates: [], images: [] }`.
 *  WP layout-kb-web: `platform` (mặc định mobile) chọn bảng topic VÀ lọc topic
 *  đúng nền tảng — màn web chỉ nhận topic `platform: 'web'`, màn mobile chỉ
 *  topic mobile (manifest v1 → toàn bộ mobile, kết quả y hệt trước). */
export function layoutRefsFor(kb: LayoutKb, archetype: Archetype, platform: LayoutKbPlatform = 'mobile'): LayoutRefs {
  const table = platform === 'web' ? WEB_ARCHETYPE_TOPICS : ARCHETYPE_TOPICS;
  const topics = table[archetype].filter((t) => kb.manifest.topics[t]?.platform === platform);
  const templates: LayoutRefs['templates'] = [];
  const images: string[] = [];
  const seenTpl = new Set<string>();
  const seenImg = new Set<string>();
  const roundRobin = <T>(pick: (topic: LayoutKbTopic, i: number) => T | undefined, push: (v: T) => boolean, max: number) => {
    let i = 0;
    let progressed = true;
    let count = 0;
    while (count < max && progressed) {
      progressed = false;
      for (const t of topics) {
        if (count >= max) break;
        const v = pick(kb.manifest.topics[t]!, i);
        if (v === undefined) continue;
        progressed = true;
        if (push(v)) count += 1;
      }
      i += 1;
    }
  };
  roundRobin(
    (t, i) => t.templates[i],
    (tpl) => {
      if (seenTpl.has(tpl.id)) return false;
      seenTpl.add(tpl.id);
      templates.push({ id: tpl.id, bands: tpl.bands, sketch: tpl.sketch });
      return true;
    },
    MAX_TEMPLATES,
  );
  roundRobin(
    (t, i) => t.samples[i],
    (s) => {
      const abs = path.resolve(kb.dir, s.wireframe);
      if (seenImg.has(abs)) return false;
      seenImg.add(abs);
      images.push(abs);
      return true;
    },
    MAX_IMAGES,
  );
  return { topics, templates, images };
}
