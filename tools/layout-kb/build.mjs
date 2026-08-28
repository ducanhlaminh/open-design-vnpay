#!/usr/bin/env node
// layout-kb builder — dựng kho bố cục tham khảo từ dataset Enrico (Aalto, MIT)
// vào `~/layout-kb/` (hoặc `--out`). Daemon (apps/daemon/src/layout-kb.ts) đọc
// `manifest.json` + `wireframes/<id>.png` để gợi ý khuôn bố cục cho stage
// dr-mockup theo archetype màn.
//
//   node tools/layout-kb/build.mjs [--out ~/layout-kb] [--topics list,form,...]
//                                  [--max-per-topic 12] [--with-screenshots] [--force]
//
// Node ≥ 20, không dependency npm. Tải qua http (server Aalto không có https),
// cache ở `<out>/.cache/`, giải nén bằng `unzip` CLI (có sẵn macOS/Linux).
// Idempotent + resumable: file đã tải/giải nén thì bỏ qua; `--force` tải lại.
// `<out>/curate.json` `{ "exclude": ["<id>", ...] }` (deny-list do người
// curate) được tôn trọng ở mỗi lần rebuild.
//
// Enrico: 1.460 màn Android (subset Rico), 20 topic, mỗi màn có hierarchy JSON
// (cây `children[]`, `bounds [x1,y1,x2,y2]` @1440×2560, `class`, `ancestors`,
// `componentLabel` — nhãn ngữ nghĩa Rico: Toolbar/List Item/Input/Card/…) +
// wireframe PNG. Builder: hierarchy → hàng (row) theo dải y → phân loại band
// theo componentLabel + class + hình học → gộp hàng lặp (list/cards/grid/form)
// → signature = chuỗi band. Theo topic giữ ≤6 khuôn (template) phổ biến và
// ≤N màn mẫu đa dạng nhất (mặc định 12), chỉ copy wireframe của màn được chọn.

import { spawnSync } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// WP layout-kb-web (2026-08-28): manifest schema_version 2 — mỗi topic có
// `platform: 'mobile' | 'web'`, file có `sources[]`. Topic web tầng 1 (viết tay)
// đọc từ `web-templates.json` cạnh script và merge sau topic Enrico; tầng 2
// (dữ liệu thật) do `build-web.mjs` bổ sung vào manifest hiện có.
const WEB_TEMPLATES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web-templates.json');
const SOURCES = [
  { id: 'enrico', license: 'MIT', note: 'Leiva, Hota, Oulasvirta — Enrico (Aalto, MobileHCI 2020); topic mobile.' },
  { id: 'web-templates', license: 'hand-authored', note: 'tools/layout-kb/web-templates.json — topic web tầng 1 (khuôn viết tay, không ảnh).' },
];

const BASE_URL = 'http://userinterfaces.aalto.fi/enrico/resources';
const RESOURCES = ['hierarchies.zip', 'metadata.zip', 'wireframes.zip'];
const TOPICS_CSV = 'design_topics.csv';
// design_topics.csv KHÔNG có ở server Aalto (404) — lấy từ repo GitHub (README
// Enrico "Link to file"); thử Aalto sau cùng phòng khi họ đăng lại.
const TOPICS_CSV_URLS = [
  `https://raw.githubusercontent.com/luileito/enrico/master/${TOPICS_CSV}`,
  `https://raw.githubusercontent.com/luileito/enrico/main/${TOPICS_CSV}`,
  `${BASE_URL}/${TOPICS_CSV}`,
];
const SCREENSHOTS_ZIP = 'screenshots.zip';

/** Topic giữ lại (Enrico có 20; bỏ bare/other/terms/camera/dialer/mediaplayer/maps/editor). */
const DEFAULT_TOPICS = ['list', 'gallery', 'news', 'form', 'login', 'search', 'menu', 'profile', 'settings', 'modal', 'tutorial', 'chat'];
const DROP_TOPICS = new Set(['bare', 'other', 'terms', 'camera', 'dialer', 'mediaplayer', 'maps', 'editor']);

const MAX_TEMPLATES_PER_TOPIC = 6;
const ROW_GAP_PX = 24; // ngưỡng gom hàng theo y @1440×2560
const MIN_BANDS = 2; // `appbar › list` vẫn là khuôn hợp lệ (Enrico trung bình 3.7 band/màn)
const SAMPLE_PREF_MIN = 3; // sample ưu tiên 3–9 band
const MAX_BANDS = 9;
const SKETCH_LINES = 12;
const SKETCH_W = 22;

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { out: path.join(os.homedir(), 'layout-kb'), topics: DEFAULT_TOPICS, maxPerTopic: 12, withScreenshots: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${a} cần giá trị`);
      return argv[i];
    };
    if (a === '--out') out.out = expandHome(next());
    else if (a === '--topics') out.topics = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--max-per-topic') out.maxPerTopic = Math.max(1, Number.parseInt(next(), 10) || 12);
    else if (a === '--with-screenshots') out.withScreenshots = true;
    else if (a === '--force') out.force = true;
    else if (a === '-h' || a === '--help') {
      console.log('node tools/layout-kb/build.mjs [--out DIR] [--topics a,b] [--max-per-topic N] [--with-screenshots] [--force]');
      process.exit(0);
    } else throw new Error(`Tham số lạ: ${a}`);
  }
  return out;
}

function expandHome(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

// ── Download (http, follow redirect, resumable qua cache) ──────────────────

function fetchToFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'user-agent': 'od-layout-kb/1' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume();
        resolve(fetchToFile(new URL(res.headers.location, url).toString(), dest, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} ${url}`));
        return;
      }
      const total = Number(res.headers['content-length'] ?? 0);
      let got = 0;
      let lastPct = -1;
      const tmp = `${dest}.part`;
      const ws = createWriteStream(tmp);
      res.on('data', (chunk) => {
        got += chunk.length;
        if (total) {
          const pct = Math.floor((got / total) * 10) * 10;
          if (pct !== lastPct) {
            lastPct = pct;
            process.stdout.write(`\r  ${path.basename(dest)} ${pct}% (${(got / 1e6).toFixed(1)} MB)`);
          }
        }
      });
      res.pipe(ws);
      ws.on('finish', async () => {
        process.stdout.write('\n');
        await fs.rename(tmp, dest);
        resolve(got);
      });
      ws.on('error', reject);
      res.on('error', reject);
    });
    req.setTimeout(120_000, () => req.destroy(new Error(`timeout ${url}`)));
    req.on('error', reject);
  });
}

/** Cache hợp lệ? zip: có chữ ký PK; csv: dòng đầu là header (bắt trang 404 HTML lưu nhầm). */
async function cacheLooksValid(dest) {
  const fh = await fs.open(dest, 'r').catch(() => null);
  if (!fh) return false;
  try {
    const buf = Buffer.alloc(32);
    const { bytesRead } = await fh.read(buf, 0, 32, 0);
    const head = buf.subarray(0, bytesRead).toString('latin1');
    return dest.endsWith('.zip') ? head.startsWith('PK') : /^screen_id\s*,\s*topic/i.test(head);
  } finally {
    await fh.close();
  }
}

async function ensureDownloaded(cacheDir, name, force, urls = [`${BASE_URL}/${name}`]) {
  const dest = path.join(cacheDir, name);
  const st = await fs.stat(dest).catch(() => null);
  if (st?.isFile() && st.size > 0 && !force && (await cacheLooksValid(dest))) {
    console.log(`  ${name}: cache (${(st.size / 1e6).toFixed(1)} MB)`);
    return dest;
  }
  let lastErr = null;
  for (const url of urls) {
    console.log(`  ${name}: tải ${url}`);
    try {
      await fetchToFile(url, dest);
      return dest;
    } catch (err) {
      lastErr = err;
      console.log(`  ${name}: lỗi ${err?.message ?? err}`);
    }
  }
  throw lastErr ?? new Error(`không tải được ${name}`);
}

function unzip(zipPath, destDir, files) {
  const args = ['-o', '-q', zipPath, ...(files ?? []), '-d', destDir];
  const r = spawnSync('unzip', args, { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`unzip không chạy được (${r.error.message}) — cần CLI unzip`);
  // unzip trả 11 khi không khớp file nào (files filter) → coi là lỗi mềm.
  if (r.status !== 0 && r.status !== 11 && r.status !== 1) throw new Error(`unzip ${zipPath} lỗi ${r.status}: ${r.stderr?.toString().slice(0, 400)}`);
  return r.status;
}

async function ensureExtracted(zipPath, cacheDir, subdir) {
  const dir = path.join(cacheDir, subdir);
  const st = await fs.stat(dir).catch(() => null);
  if (st?.isDirectory()) {
    const n = (await fs.readdir(dir)).length;
    if (n > 0) return dir;
  }
  console.log(`  giải nén ${path.basename(zipPath)} → ${dir}`);
  unzip(zipPath, cacheDir);
  return dir;
}

// ── Hierarchy → bands ──────────────────────────────────────────────────────

const last = (cls) => (typeof cls === 'string' ? cls.split('.').pop() ?? '' : '');

function isNum4(b) {
  return Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** Nhãn ngữ nghĩa Rico → kind thô của UNIT. Container có nhãn (List Item,
 *  Card, Toolbar, …) là 1 unit — không đi sâu; container không nhãn thì đi sâu. */
const LABEL_KIND = {
  Toolbar: 'appbar',
  'Multi-Tab': 'tabs',
  'Bottom Navigation': 'tabbar',
  Input: 'input',
  'List Item': 'list-item',
  Card: 'card',
  'Text Button': 'button',
  Image: 'image',
  'Background Image': 'image',
  Video: 'image',
  'Map View': 'image',
  Icon: 'icon',
  Text: 'text',
  'Web View': 'content',
  Advertisement: null, // bỏ
  'Pager Indicator': 'pager',
  // Modal/Drawer: KHÔNG phải unit — đánh dấu lớp phủ rồi đi sâu vào nội dung
  // bên trong (34/67 màn topic modal chỉ có mỗi band "modal" nếu coi là unit).
  Drawer: 'overlay',
  Modal: 'overlay',
  Checkbox: 'option',
  'Radio Button': 'option',
  'On/Off Switch': 'option',
  Slider: 'input',
  'Number Stepper': 'input',
  'Date Picker': 'input',
  'Button Bar': 'button-row',
};

function classKind(node) {
  const names = [last(node.class), ...(Array.isArray(node.ancestors) ? node.ancestors.map(last) : [])];
  const has = (re) => names.some((n) => re.test(n));
  if (has(/^(Toolbar|ActionBar|ActionBarContainer)$/)) return 'appbar';
  if (has(/TabLayout|PagerTabStrip|TabWidget/)) return 'tabs';
  if (has(/BottomNavigation/)) return 'tabbar';
  if (has(/FloatingActionButton/)) return 'fab';
  if (has(/SearchView/)) return 'search';
  if (has(/EditText/)) return 'input';
  if (has(/^(CheckBox|RadioButton|Switch|SwitchCompat|CompoundButton|ToggleButton)$/)) return 'option';
  if (has(/HorizontalScrollView|ViewPager|RecyclerView.*Horizontal/)) return 'hscroll';
  if (has(/CardView/)) return 'card';
  if (has(/^(Button|AppCompatButton|MaterialButton)$/)) return 'button';
  if (has(/ImageView|ImageButton/)) return 'image';
  if (has(/TextView/)) return 'text';
  if (has(/RecyclerView|ListView|GridView/)) return 'list';
  return null;
}

/** Thu unit hiển thị từ cây. Chịu được node thiếu field. */
function collectUnits(root, H) {
  const units = [];
  let overlay = null;
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 40) return;
    if (node.visibility && node.visibility !== 'visible') return;
    const b = isNum4(node.bounds) ? node.bounds : null;
    const label = typeof node.componentLabel === 'string' ? node.componentLabel : null;
    const kids = Array.isArray(node.children) ? node.children : [];
    if (label !== null && label in LABEL_KIND) {
      const kind = LABEL_KIND[label];
      if (kind === 'overlay') {
        overlay = label === 'Drawer' ? 'drawer' : 'modal';
        for (const k of kids) walk(k, depth + 1);
        return;
      }
      // Card lớn (> 25% cao màn — modal/nội dung bọc trong CardView) là
      // container: đi sâu để thấy bố cục bên trong; card nhỏ = 1 unit (grid/cards).
      if (kind === 'card' && b && b[3] - b[1] > H * 0.25 && kids.length) {
        for (const k of kids) walk(k, depth + 1);
        return;
      }
      if (kind && b) units.push({ kind, b, label, clickable: node.clickable === true });
      return;
    }
    if (kids.length === 0) {
      const kind = classKind(node);
      if (kind && b) units.push({ kind, b, label: null, clickable: node.clickable === true });
      return;
    }
    // Container không nhãn: một số class đặc trưng đủ nói lên band (FAB/tabs/hscroll).
    const ck = classKind(node);
    if (ck && ['fab', 'tabs', 'tabbar', 'hscroll', 'appbar', 'search'].includes(ck) && b) {
      units.push({ kind: ck, b, label: null, clickable: node.clickable === true });
      return;
    }
    for (const k of kids) walk(k, depth + 1);
  };
  walk(root, 0);
  return { units, overlay };
}

/** Gom unit thành hàng theo dải y (unit chồng dải y với hàng, dung sai ROW_GAP_PX). */
function groupRows(units, H) {
  const sorted = [...units].filter((u) => u.b[3] > u.b[1] && u.b[2] > u.b[0]).sort((a, b) => a.b[1] - b.b[1] || a.b[0] - b.b[0]);
  const rows = [];
  for (const u of sorted) {
    const y1 = u.b[1];
    const y2 = u.b[3];
    // Unit chiếm > 60% chiều cao màn (nền, web view) → không gom, tự là hàng.
    const tall = y2 - y1 > H * 0.6;
    const cur = rows[rows.length - 1];
    if (cur && !tall && !cur.tall && y1 <= cur.y2 - ROW_GAP_PX) {
      cur.units.push(u);
      cur.y2 = Math.max(cur.y2, y2);
    } else rows.push({ y1, y2, units: [u], tall });
  }
  return rows;
}

/** Hàng → band kind (kèm cols khi là grid). */
function classifyRow(row, W, H) {
  const kinds = new Set(row.units.map((u) => u.kind));
  const yc = (row.y1 + row.y2) / 2 / H;
  const wOf = (u) => u.b[2] - u.b[0];
  const wide = (u) => wOf(u) >= W * 0.6;
  if (kinds.has('appbar') && yc < 0.15) return { kind: 'appbar' };
  if (kinds.has('tabbar') || (kinds.has('tabs') && yc > 0.85)) return { kind: 'tabbar' };
  if (kinds.has('tabs')) return { kind: 'tabs' };
  if (kinds.has('fab')) return { kind: 'fab' };
  if (kinds.has('hscroll')) return { kind: 'hscroll' };
  if (kinds.has('search') || (kinds.has('input') && yc < 0.2 && row.units.some((u) => u.kind === 'input' && wide(u)))) return { kind: 'search' };
  if (kinds.has('list')) return { kind: 'list' };
  if (kinds.has('list-item')) return { kind: 'list-item' };
  if (kinds.has('card')) {
    const cards = row.units.filter((u) => u.kind === 'card');
    return cards.length >= 2 ? { kind: 'grid', cols: cards.length } : { kind: 'card' };
  }
  if (kinds.has('input')) return { kind: 'input' };
  if (kinds.has('button-row')) return { kind: 'button-row' };
  const buttons = row.units.filter((u) => u.kind === 'button');
  if (buttons.length >= 2) return { kind: 'button-row' };
  if (buttons.length === 1 && wide(buttons[0])) return { kind: 'button' };
  if (kinds.has('option')) return { kind: 'option' };
  // grid: ≥2 unit cùng loại, width ±10%, mỗi ô ≥ 18% W
  const byKind = new Map();
  for (const u of row.units) {
    if (u.kind !== 'image' && u.kind !== 'text' && u.kind !== 'icon') continue;
    const arr = byKind.get(u.kind) ?? [];
    arr.push(u);
    byKind.set(u.kind, arr);
  }
  for (const [, arr] of byKind) {
    if (arr.length < 2) continue;
    const ws = arr.map(wOf);
    const mean = ws.reduce((a, b) => a + b, 0) / ws.length;
    if (mean >= W * 0.18 && ws.every((w) => Math.abs(w - mean) <= mean * 0.1)) return { kind: 'grid', cols: Math.min(arr.length, 4) };
  }
  const images = row.units.filter((u) => u.kind === 'image');
  if (images.some((u) => wOf(u) > W * 0.3)) return { kind: 'image' };
  if (buttons.length === 1) return { kind: 'button' };
  if (kinds.has('content')) return { kind: 'content' };
  if (kinds.has('pager')) return { kind: 'pager' };
  if (images.length && kinds.has('text')) return { kind: 'split' };
  if (kinds.has('icon') && !kinds.has('text')) return { kind: 'icons' };
  return { kind: 'text' };
}

const bandName = (r) => (r.kind === 'grid' ? `grid-${r.cols}` : r.kind);

/** Gộp hàng lặp thành band cấp cao: list-item×≥2 → list, card×≥2 → cards,
 *  grid-N liên tiếp → grid-N, input×≥2 → form, option×≥2 → options,
 *  text/split liên tiếp gộp 1. */
function collapse(rowKinds) {
  const bands = [];
  let i = 0;
  while (i < rowKinds.length) {
    const cur = rowKinds[i];
    let j = i + 1;
    while (j < rowKinds.length && bandName(rowKinds[j]) === bandName(cur)) j += 1;
    const n = j - i;
    const name = bandName(cur);
    let out;
    if (name === 'list-item') out = n >= 2 ? `list(${Math.min(n, 9)})` : 'split';
    else if (name === 'card') out = n >= 2 ? 'cards' : 'card';
    else if (name === 'input') out = n >= 2 ? `form(${Math.min(n, 9)})` : 'input';
    else if (name === 'option') out = n >= 2 ? 'options' : 'option';
    else if (name.startsWith('grid-')) out = name;
    else out = name;
    if (bands.length && stripCount(bands[bands.length - 1]) === stripCount(out) && !/^(list|form)/.test(out)) {
      // trùng band liền kề (vd text › text) → giữ 1
    } else bands.push(out);
    i = j;
  }
  return bands;
}
const stripCount = (b) => b.replace(/\(\d+\)$/, '');

function analyseHierarchy(root) {
  if (!root || typeof root !== 'object') return null;
  const rb = isNum4(root.bounds) ? root.bounds : [0, 0, 1440, 2560];
  const W = Math.max(1, rb[2] - rb[0]);
  const H = Math.max(1, rb[3] - rb[1]);
  const { units, overlay } = collectUnits(root, H);
  if (units.length === 0) return null;
  const rows = groupRows(units, H);
  const rowKinds = rows.map((r) => classifyRow(r, W, H));
  const bands = collapse(rowKinds);
  // Lớp phủ (Modal/Drawer) đứng đầu chuỗi band: `modal › text › button-row`.
  if (overlay) bands.unshift(overlay);
  return { bands, rows: rows.length, units: units.length };
}

// ── Sketch ASCII ───────────────────────────────────────────────────────────

const inner = SKETCH_W - 2;
const pad = (s) => {
  const t = [...s].slice(0, inner).join('');
  return `│${t}${' '.repeat(Math.max(0, inner - [...t].length))}│`;
};
const BAND_LINES = {
  appbar: ['≡  Tiêu đề        ⋮ '],
  search: ['[⌕ Tìm kiếm       ]'],
  tabs: [' Tab1 | Tab2 | Tab3 '],
  tabbar: ['⌂    ⌕    ♡    ☺   '],
  fab: ['               (+) '],
  hscroll: ['[▢][▢][▢][▢] ›     '],
  list: ['▢ ──────── ···     ', '▢ ──────── ···     ', '▢ ──────── ···     '],
  cards: ['┌────────────────┐ ', '│ ▢ ────── ───   │ ', '└────────────────┘ '],
  card: ['┌────────────────┐ ', '│ ──────  ────── │ ', '└────────────────┘ '],
  'grid-2': ['[  ▢   ] [  ▢   ]  ', '[  ▢   ] [  ▢   ]  '],
  'grid-3': ['[▢] [▢] [▢]        ', '[▢] [▢] [▢]        '],
  'grid-4': ['[▢][▢][▢][▢]       '],
  form: ['Nhãn ____________  ', 'Nhãn ____________  '],
  input: ['Nhãn ____________  '],
  options: ['○ ────   ○ ────    '],
  option: ['☐ ──────────       '],
  button: ['[    Tiếp tục     ]'],
  'button-row': ['[ Huỷ ]  [ Đồng ý ]'],
  image: ['╭────────────────╮ ', '│   ✕   ảnh   ✕  │ ', '╰────────────────╯ '],
  split: ['▢ ─────── ──       '],
  text: ['────────────       ', '──────             '],
  content: ['nội dung …         '],
  icons: ['✦   ✦   ✦   ✦      '],
  pager: ['     • ○ ○         '],
  modal: ['░░ nền mờ ░░░░░░░░░', '┌─ hộp thoại ─────┐ '],
  drawer: ['▌ ngăn kéo ░░░░░░░░', '▌ ─────  ░░░░░░░░░'],
};

function sketchFor(bands) {
  const body = SKETCH_LINES - 2;
  const pick = bands.map((b) => BAND_LINES[stripCount(b)] ?? BAND_LINES.text);
  // Chia dòng: mỗi band ≥1 dòng, phần dư ưu tiên list/cards/grid/form.
  let lines = pick.map(() => 1);
  let left = body - lines.length;
  const grow = ['list', 'cards', 'grid-2', 'grid-3', 'grid-4', 'form', 'image', 'card', 'text', 'modal'];
  let guard = 0;
  while (left > 0 && guard < 50) {
    guard += 1;
    let grew = false;
    for (let k = 0; k < bands.length && left > 0; k += 1) {
      // list/cards/form/grid được kéo dài tới 5 dòng (lặp mẫu) để khuôn 2–3 band không trống nửa khung.
      const cap = /^(list|cards|form|grid)/.test(stripCount(bands[k])) ? Math.max(5, pick[k].length + 1) : pick[k].length + 1;
      if (grow.includes(stripCount(bands[k])) && lines[k] < cap) {
        lines[k] += 1;
        left -= 1;
        grew = true;
      }
    }
    if (!grew) break;
  }
  const rows = [];
  for (let k = 0; k < bands.length; k += 1) {
    for (let l = 0; l < lines[k]; l += 1) rows.push(pad(pick[k][l % pick[k].length]));
  }
  while (rows.length < body) rows.push(pad(''));
  return [`┌${'─'.repeat(inner)}┐`, ...rows.slice(0, body), `└${'─'.repeat(inner)}┘`].join('\n');
}

const slugOf = (bands) =>
  bands
    .map(stripCount)
    .map((b) => b.replace(/[^a-z0-9]+/g, ''))
    .join('-')
    .slice(0, 48);

// ── Main ───────────────────────────────────────────────────────────────────

async function readTopicsCsv(file) {
  const raw = await fs.readFile(file, 'utf8');
  const map = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const [id, topic] = line.split(',').map((s) => s?.trim());
    if (!id || !topic || id === 'screen_id') continue;
    map.set(id, topic);
  }
  return map;
}

async function main() {
  const t0 = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.out;
  const cacheDir = path.join(outDir, '.cache');
  await fs.mkdir(cacheDir, { recursive: true });
  console.log(`layout-kb → ${outDir}`);

  console.log('Tải nguồn Enrico (cache ở .cache/):');
  const zips = {};
  for (const name of RESOURCES) zips[name] = await ensureDownloaded(cacheDir, name, args.force);
  const csvPath = await ensureDownloaded(cacheDir, TOPICS_CSV, args.force, TOPICS_CSV_URLS);
  if (args.withScreenshots) zips[SCREENSHOTS_ZIP] = await ensureDownloaded(cacheDir, SCREENSHOTS_ZIP, args.force);

  const hierDir = await ensureExtracted(zips['hierarchies.zip'], cacheDir, 'hierarchies');
  await ensureExtracted(zips['metadata.zip'], cacheDir, 'metadata').catch(() => null);

  const topicOf = await readTopicsCsv(csvPath);
  if (topicOf.size === 0) throw new Error(`${csvPath} không có dòng "screen_id,topic" nào — xoá file rồi chạy lại`);
  const wanted = new Set(args.topics.filter((t) => !DROP_TOPICS.has(t)));
  const curate = await fs
    .readFile(path.join(outDir, 'curate.json'), 'utf8')
    .then((s) => JSON.parse(s))
    .catch(() => ({}));
  const exclude = new Set(Array.isArray(curate?.exclude) ? curate.exclude.map(String) : []);

  // Phân tích hierarchy từng màn.
  const perTopic = new Map();
  let parsed = 0;
  let skipped = 0;
  const files = (await fs.readdir(hierDir)).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const id = path.basename(f, '.json');
    const topic = topicOf.get(id);
    if (!topic || !wanted.has(topic) || exclude.has(id)) {
      skipped += 1;
      continue;
    }
    let root;
    try {
      root = JSON.parse(await fs.readFile(path.join(hierDir, f), 'utf8'));
    } catch {
      skipped += 1;
      continue;
    }
    const a = analyseHierarchy(root);
    if (!a || a.bands.length < MIN_BANDS) {
      skipped += 1;
      continue;
    }
    parsed += 1;
    const arr = perTopic.get(topic) ?? [];
    arr.push({ id, bands: a.bands.slice(0, MAX_BANDS + 3) });
    perTopic.set(topic, arr);
  }

  // Chọn template + sample theo topic.
  const manifest = { schema_version: 2, source: 'enrico', license: 'MIT', builtAt: new Date().toISOString(), sources: SOURCES, topics: {} };
  const pickIds = new Set();
  for (const topic of [...wanted].sort()) {
    const screens = perTopic.get(topic) ?? [];
    if (!screens.length) continue;
    const bySig = new Map();
    const bandsOf = new Map(screens.map((s) => [s.id, s.bands]));
    for (const s of screens) {
      // Signature bỏ số đếm (list(5) ≡ list(9)) để khuôn không vỡ vụn theo số hàng.
      const sigBands = s.bands.map(stripCount);
      const sig = sigBands.join(' › ');
      const g = bySig.get(sig) ?? { sig, bands: sigBands, ids: [] };
      g.ids.push(s.id);
      bySig.set(sig, g);
    }
    const inRange = (g) => g.bands.length >= MIN_BANDS && g.bands.length <= MAX_BANDS;
    const groups = [...bySig.values()].sort((a, b) => b.ids.length - a.ids.length || a.sig.localeCompare(b.sig));
    const templates = [];
    const usedSlug = new Set();
    for (const g of groups.filter(inRange)) {
      if (templates.length >= MAX_TEMPLATES_PER_TOPIC) break;
      let slug = slugOf(g.bands);
      let k = 2;
      while (usedSlug.has(slug)) slug = `${slugOf(g.bands)}-${k++}`;
      usedSlug.add(slug);
      templates.push({ id: `${topic}-${slug}`, bands: g.bands, sketch: sketchFor(g.bands), samples: g.ids.slice(0, 3) });
    }
    // Samples: đa dạng signature — vòng 1 mỗi signature 1 màn (4–9 band ưu tiên), vòng 2 bổ sung.
    const samples = [];
    const pref = groups.filter((g) => g.bands.length >= SAMPLE_PREF_MIN && g.bands.length <= MAX_BANDS);
    const rest = groups.filter((g) => !pref.includes(g) && inRange(g));
    for (const pool of [pref, rest]) {
      for (let round = 0; samples.length < args.maxPerTopic && round < 3; round += 1) {
        let added = false;
        for (const g of pool) {
          if (samples.length >= args.maxPerTopic) break;
          const id = g.ids[round];
          if (!id || pickIds.has(id)) continue;
          samples.push({ id, wireframe: `wireframes/${id}.png`, bands: bandsOf.get(id) ?? g.bands });
          pickIds.add(id);
          added = true;
        }
        if (!added) break;
      }
    }
    manifest.topics[topic] = { platform: 'mobile', count: screens.length, templates, samples };
  }

  // Topic web tầng 1: merge web-templates.json (platform web, count = số template, samples []).
  const webTopics = await readWebTemplates();
  for (const [name, t] of Object.entries(webTopics)) {
    if (manifest.topics[name]) throw new Error(`web-templates.json: topic "${name}" trùng topic Enrico`);
    manifest.topics[name] = {
      platform: 'web',
      count: t.templates.length,
      templates: t.templates.map((tpl) => ({ id: tpl.id, bands: tpl.bands, sketch: tpl.sketch, samples: [] })),
      samples: [],
    };
  }

  // Wireframes: chỉ copy màn được chọn.
  const wfOut = path.join(outDir, 'wireframes');
  await fs.mkdir(wfOut, { recursive: true });
  const missing = [];
  for (const id of pickIds) {
    if (await fs.stat(path.join(wfOut, `${id}.png`)).then((s) => s.isFile()).catch(() => false)) continue;
    missing.push(`wireframes/${id}.png`);
  }
  if (missing.length) {
    console.log(`  giải nén ${missing.length} wireframe → ${wfOut}`);
    const tmp = await fs.mkdtemp(path.join(cacheDir, 'wf-'));
    for (let i = 0; i < missing.length; i += 200) unzip(zips['wireframes.zip'], tmp, missing.slice(i, i + 200));
    for (const rel of missing) {
      const src = path.join(tmp, rel);
      await fs.copyFile(src, path.join(wfOut, path.basename(rel))).catch(() => null);
    }
    await fs.rm(tmp, { recursive: true, force: true });
  }
  if (args.withScreenshots) {
    const scOut = path.join(outDir, 'screenshots');
    await fs.mkdir(scOut, { recursive: true });
    const tmp = await fs.mkdtemp(path.join(cacheDir, 'sc-'));
    const want = [...pickIds].map((id) => `screenshots/${id}.jpg`);
    for (let i = 0; i < want.length; i += 200) unzip(zips[SCREENSHOTS_ZIP], tmp, want.slice(i, i + 200));
    for (const rel of want) await fs.copyFile(path.join(tmp, rel), path.join(scOut, path.basename(rel))).catch(() => null);
    await fs.rm(tmp, { recursive: true, force: true });
  }
  // Bỏ sample không có ảnh (zip thiếu) để manifest không trỏ file ma.
  let imgCount = 0;
  let imgBytes = 0;
  for (const t of Object.values(manifest.topics)) {
    const kept = [];
    for (const s of t.samples) {
      const st = await fs.stat(path.join(outDir, s.wireframe)).catch(() => null);
      if (st?.isFile()) {
        kept.push(s);
        imgCount += 1;
        imgBytes += st.size;
      }
    }
    t.samples = kept;
  }

  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await fs.writeFile(path.join(outDir, 'README.md'), readmeText(args), 'utf8');
  if (!(await fs.stat(path.join(outDir, 'curate.json')).catch(() => null))) {
    await fs.writeFile(path.join(outDir, 'curate.json'), JSON.stringify({ exclude: [] }, null, 2), 'utf8');
  }

  const topics = Object.keys(manifest.topics);
  const nMobile = topics.filter((t) => manifest.topics[t].platform !== 'web').length;
  const nWeb = topics.length - nMobile;
  if (parsed === 0) throw new Error(`không phân tích được màn nào (bỏ ${skipped}) — kiểm tra .cache/hierarchies + design_topics.csv`);
  const nTpl = topics.reduce((a, t) => a + manifest.topics[t].templates.length, 0);
  console.log('');
  console.log(`Xong ${((Date.now() - t0) / 1000).toFixed(1)}s — ${topics.length} topic (${nMobile} mobile, ${nWeb} web), ${nTpl} template, ${imgCount} wireframe (${(imgBytes / 1e6).toFixed(2)} MB); phân tích ${parsed} màn, bỏ ${skipped}.`);
  for (const t of topics) {
    const x = manifest.topics[t];
    console.log(`  ${t.padEnd(13)} ${x.platform.padEnd(6)} ${String(x.count).padStart(4)} màn  ${x.templates.length} tpl  ${x.samples.length} ảnh  | ${x.templates[0]?.bands.join(' › ') ?? ''}`);
  }
}

/** Đọc `web-templates.json` (tầng 1). Kiểm khuôn tối thiểu: topic tiền tố `web-`,
 *  template `{ id, bands[], sketch }` với id tiền tố `<topic>-`. Thiếu file → {} (có cảnh báo). */
async function readWebTemplates() {
  const raw = await fs.readFile(WEB_TEMPLATES_FILE, 'utf8').catch(() => null);
  if (raw == null) {
    console.log(`  (không có ${path.basename(WEB_TEMPLATES_FILE)} — manifest không có topic web)`);
    return {};
  }
  const json = JSON.parse(raw);
  const out = {};
  for (const [name, t] of Object.entries(json?.topics ?? {})) {
    if (!name.startsWith('web-')) throw new Error(`web-templates.json: topic "${name}" phải có tiền tố web-`);
    const templates = [];
    for (const tpl of Array.isArray(t?.templates) ? t.templates : []) {
      if (typeof tpl?.id !== 'string' || !tpl.id.startsWith(`${name}-`)) throw new Error(`web-templates.json: template id "${tpl?.id}" phải có tiền tố ${name}-`);
      if (!Array.isArray(tpl.bands) || !tpl.bands.length) throw new Error(`web-templates.json: ${tpl.id} thiếu bands`);
      templates.push({ id: tpl.id, bands: tpl.bands.map(String), sketch: typeof tpl.sketch === 'string' ? tpl.sketch : '' });
    }
    if (templates.length) out[name] = { templates };
  }
  return out;
}

function readmeText(args) {
  return `# layout-kb

Kho bố cục tham khảo cho stage dr-mockup (open-design-vnpay), dựng tự động từ
dataset **Enrico** (Aalto University, giấy phép MIT — https://github.com/luileito/enrico):
1.460 màn Android (subset Rico) gắn 20 topic thiết kế, mỗi màn có wireframe PNG
+ hierarchy JSON. Chỉ giữ topic liên quan: ${args.topics.join(', ')}.

- \`manifest.json\` — schema_version 2: theo topic gồm \`platform\` (mobile | web), \`templates[]\` (id, bands, sketch ASCII, samples)
  và \`samples[]\` (id, wireframe, bands); \`sources[]\` cấp file. Daemon đọc file này (\`apps/daemon/src/layout-kb.ts\`).
  Topic \`web-*\` tầng 1 lấy từ \`tools/layout-kb/web-templates.json\` (khuôn viết tay, samples rỗng);
  \`build-web.mjs\` (tầng 2) bổ sung sample/template thật — chạy SAU build.mjs (build.mjs ghi lại topic web về tầng 1).
- \`wireframes/<id>.png\` — wireframe Enrico của màn được chọn (chỉ màn trong manifest).
- \`curate.json\` — \`{ "exclude": ["<id>", ...] }\`: màn xấu/lạc đề do người curate; được tôn trọng khi rebuild.
- \`.cache/\` — zip gốc + hierarchy đã giải nén (có thể xoá; rebuild sẽ tải lại).

Rebuild: \`node tools/layout-kb/build.mjs\` (trong repo open-design-vnpay). Tuỳ chọn:
\`--out DIR\`, \`--topics a,b\`, \`--max-per-topic N\` (mặc định ${args.maxPerTopic}), \`--with-screenshots\`
(tải thêm screenshots.zip ~110 MB, ảnh app thật), \`--force\` (tải lại nguồn).
Daemon đọc thư mục này qua env \`LAYOUT_KB_DIR\` (mặc định \`~/layout-kb\`).

Nguồn: http://userinterfaces.aalto.fi/enrico/ — Leiva, Hota, Oulasvirta. "Enrico: A Dataset for
Topic Modeling of Mobile UI Designs" (MobileHCI 2020). Rico: Deka et al. (UIST 2017).
`;
}

main().catch((err) => {
  console.error(`layout-kb: ${err?.message ?? err}`);
  process.exit(1);
});
