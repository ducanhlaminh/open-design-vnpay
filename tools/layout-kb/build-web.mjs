#!/usr/bin/env node
// layout-kb builder tầng 2 — dữ liệu WEB thật → merge vào `~/layout-kb/manifest.json`
// (schema 2, topic `web-*`, `platform: 'web'`). Chạy SAU `build.mjs` (build.mjs ghi lại
// topic web về tầng 1 = khuôn viết tay của web-templates.json; script này THÊM
// template/sample thật, giữ nguyên mọi topic mobile + khuôn tay).
//
//   node tools/layout-kb/build-web.mjs [--out ~/layout-kb] [--admin|--no-admin] [--webui]
//        [--webui-dir DIR] [--templates adminlte,tabler] [--max-per-topic 12] [--force]
//        [--playwright-dir DIR] [--viewport 1440x900] [--dump]
//
// Nhánh nguồn:
//   --admin (mặc định BẬT): `admin-templates.json` — dist HTML tĩnh của AdminLTE (MIT) +
//     Tabler (MIT), render bằng Playwright (tự tìm trong pnpm workspace
//     `node_modules/.pnpm/playwright@*`; hoặc `--playwright-dir`/env PLAYWRIGHT_DIR trỏ
//     thư mục đã `npm i playwright`), viewport 1440×900, trích hộp DOM hiển thị (tag/role/
//     class từ khoá/bbox/số input) → cache `.cache/web/<template>/<page>.json`.
//   --webui (mặc định TẮT, ~8,4 GB): HF `biglab/webui-7k` (giấy phép "other" — điều khoản
//     nghiên cứu CMU, ảnh chụp có thể chứa nội dung bản quyền; xem README). Chỉ đọc viewport
//     `default_1920-1080-*` (bb + class + axtree). Tải zip 2 phần → ghép → unzip; hoặc
//     `--webui-dir` trỏ thư mục đã giải nén (mỗi id 1 thư mục).
// Cả hai nhánh → `web-band.mjs` (thuần): boxes → bands → signature/sketch/topic.
// Wireframe: vẽ SVG hộp xám từ bbox (không cần ảnh chụp) → PNG qua Playwright
// (`wireframes/web/<id>.png`); không có trình duyệt → ghi `.svg` và manifest trỏ `.svg`.
//
// Idempotent + resumable: boxes/PNG đã có thì bỏ qua; `--force` render lại. Sample/template
// do script này ghi có `source: 'build-web:<nguồn>'` → lần chạy sau thay thế đúng phần
// của mình, không nhân đôi. `curate.json` `{ "exclude": [id…] }` được tôn trọng (id sample
// web = `<template>-<page>` hoặc `webui-<id>`).

import { spawnSync } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import { bandsFromBoxes, signatureOf, sketchFor, slugOf, stripCount, topicFor, WEB_TOPICS } from './web-band.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const ADMIN_TEMPLATES_FILE = path.join(HERE, 'admin-templates.json');

const MAX_TEMPLATES_PER_TOPIC = 6;
const MIN_BANDS = 2;
const MAX_WF_HEIGHT = 1800; // px trang tối đa đưa vào wireframe
const SOURCE_PREFIX = 'build-web:';

const WEBUI_REPO = 'biglab/webui-7k';
const WEBUI_FILES = ['train_split_web7k.json', 'train_split_web7k.zip.001', 'train_split_web7k.zip.002'];
const WEBUI_VIEWPORT = 'default_1920-1080';

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    out: path.join(os.homedir(), 'layout-kb'),
    admin: true,
    webui: false,
    webuiDir: null,
    webuiMaxMinutes: 30,
    templates: null,
    maxPerTopic: 12,
    force: false,
    playwrightDir: process.env.PLAYWRIGHT_DIR || null,
    viewport: { w: 1440, h: 900 },
    dump: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${a} cần giá trị`);
      return argv[i];
    };
    if (a === '--out') out.out = expandHome(next());
    else if (a === '--admin') out.admin = true;
    else if (a === '--no-admin') out.admin = false;
    else if (a === '--webui') out.webui = true;
    else if (a === '--webui-dir') {
      out.webui = true;
      out.webuiDir = expandHome(next());
    } else if (a === '--webui-max-minutes') out.webuiMaxMinutes = Math.max(1, Number(next()) || 30);
    else if (a === '--templates') out.templates = new Set(next().split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--max-per-topic') out.maxPerTopic = Math.max(1, Number.parseInt(next(), 10) || 12);
    else if (a === '--force') out.force = true;
    else if (a === '--playwright-dir') out.playwrightDir = expandHome(next());
    else if (a === '--viewport') {
      const m = /^(\d+)x(\d+)$/.exec(next());
      if (!m) throw new Error('--viewport dạng 1440x900');
      out.viewport = { w: Number(m[1]), h: Number(m[2]) };
    } else if (a === '--dump') out.dump = true;
    else if (a === '-h' || a === '--help') {
      console.log(
        'node tools/layout-kb/build-web.mjs [--out DIR] [--admin|--no-admin] [--webui] [--webui-dir DIR] [--templates a,b] [--max-per-topic N] [--force] [--playwright-dir DIR] [--viewport WxH] [--dump]',
      );
      process.exit(0);
    } else throw new Error(`Tham số lạ: ${a}`);
  }
  return out;
}

const expandHome = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const exists = (p) => fs.stat(p).then(() => true).catch(() => false);
const readJson = (p) => fs.readFile(p, 'utf8').then((s) => JSON.parse(s));

// ── Playwright ─────────────────────────────────────────────────────────────

/** Tìm Playwright: --playwright-dir → env → pnpm workspace `node_modules/.pnpm/playwright@*` → `import('playwright')`. */
async function loadPlaywright(dirOpt) {
  const cands = [];
  if (dirOpt) cands.push(path.join(dirOpt, 'node_modules/playwright/index.mjs'), path.join(dirOpt, 'index.mjs'));
  const pnpm = path.join(REPO_ROOT, 'node_modules/.pnpm');
  const names = (await fs.readdir(pnpm).catch(() => [])).filter((n) => /^playwright@\d/.test(n)).sort().reverse();
  for (const n of names) cands.push(path.join(pnpm, n, 'node_modules/playwright/index.mjs'));
  cands.push(path.join(REPO_ROOT, 'node_modules/playwright/index.mjs'));
  for (const c of cands) {
    if (!(await exists(c))) continue;
    try {
      const pw = await import(pathToFileURL(c).href);
      return { pw, from: c };
    } catch (err) {
      console.log(`  playwright ${c}: ${err?.message ?? err}`);
    }
  }
  try {
    const pw = await import('playwright');
    return { pw, from: 'playwright (resolve)' };
  } catch {
    return null;
  }
}

async function openBrowser(args) {
  const found = await loadPlaywright(args.playwrightDir);
  if (!found) return null;
  try {
    const browser = await found.pw.chromium.launch({ headless: true });
    console.log(`  Playwright: ${found.from} (chromium ${browser.version()})`);
    return browser;
  } catch (err) {
    console.log(`  Playwright có nhưng không mở được chromium: ${err?.message?.split('\n')[0] ?? err}`);
    console.log('  → cài trình duyệt: `npx playwright install chromium` (trong --playwright-dir) hoặc dùng cache boxes đã có.');
    return null;
  }
}

/** Chạy trong trang: mọi phần tử hiển thị → { tag, role, cls (class từ khoá), x, y, w, h, n, inputs, txt, num, hd }. */
function extractBoxes() {
  const KW =
    /sidebar|sidenav|side-nav|navbar|header|topbar|top-nav|footer|breadcrumb|pagination|paginate|page-link|pager|nav-tabs|nav-pills|tabs|stepper|steps|wizard|step-item|table|datatable|chart|apexcharts|graph|sparkline|hero|jumbotron|page-header|page-title|banner|cover|small-box|info-box|kpi|stat|counter|form|input-group|btn|button|card|box|panel|widget|tile|callout|accordion|list-group|list|timeline|feed|image|thumbnail|avatar|img-fluid|illustration|gallery|summary|total|modal|dialog|offcanvas|drawer|datagrid|description-list|dl-horizontal|kv|title|lead|text-muted|empty|main|content|container|row|col/;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'BR', 'WBR']);
  const els = [];
  const sx = window.scrollX;
  const sy = window.scrollY;
  const walk = (node, depth) => {
    if (els.length > 8000 || depth > 60) return;
    if (node.nodeType !== 1 || SKIP.has(node.tagName)) return;
    const cs = getComputedStyle(node);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return;
    const r = node.getBoundingClientRect();
    const tag = node.tagName.toLowerCase();
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w >= 8 && h >= 6) {
      const cls = [...node.classList].filter((c) => KW.test(c)).slice(0, 8).join(' ');
      const role = node.getAttribute('role') || '';
      const rec = { tag, x: Math.round(r.left + sx), y: Math.round(r.top + sy), w, h, n: node.childElementCount };
      if (cls) rec.cls = cls;
      if (role) rec.role = role;
      if (/^(form|div|section|article|fieldset|main|aside|dialog)$/.test(tag) && node.childElementCount) {
        const inputs = node.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),select,textarea').length;
        if (inputs) rec.inputs = inputs;
      }
      const txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
      rec.txt = Math.min(txt.length, 999);
      if (txt.length && txt.length <= 14 && /^[\d.,%$€₫+\-\s]+[a-z%]{0,2}$/i.test(txt)) rec.num = true;
      const hd = /^h([1-6])$/.exec(tag);
      if (hd) rec.hd = Number(hd[1]);
      els.push(rec);
    }
    if (tag === 'svg' || tag === 'table' || tag === 'select' || tag === 'canvas') return;
    for (const k of node.children) walk(k, depth + 1);
  };
  walk(document.body, 0);
  return {
    w: window.innerWidth,
    h: window.innerHeight,
    docH: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    title: document.title,
    els,
  };
}

async function renderPage(browser, url, viewport) {
  const ctx = await browser.newContext({ viewport: { width: viewport.w, height: viewport.h }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  try {
    // jsDelivr trả *.html với content-type text/plain → ép text/html để trình duyệt render thật.
    await page.route(
      (u) => /\.html?(\?|$)/.test(u.pathname),
      async (route) => {
        const res = await route.fetch();
        const ct = res.headers()['content-type'] ?? '';
        if (/text\/html/.test(ct)) return route.fulfill({ response: res });
        return route.fulfill({ response: res, contentType: 'text/html; charset=utf-8', body: await res.body() });
      },
    );
    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => null);
    await page.waitForTimeout(500);
    const data = await page.evaluate(extractBoxes);
    return { url, viewport, at: new Date().toISOString(), ...data };
  } finally {
    await ctx.close();
  }
}

// ── Wireframe SVG → PNG ────────────────────────────────────────────────────

const FILL = {
  sidenav: '#cfd4da',
  topbar: '#cfd4da',
  footer: '#dfe3e8',
  modal: '#f4f4f4',
  table: '#f2f4f6',
  chart: '#e3e7ec',
  kpi: '#e9ecef',
  card: '#f7f8fa',
  form: '#f7f8fa',
  input: '#ffffff',
  button: '#9aa3ad',
  image: '#d9dde2',
  hero: '#e3e7ec',
};

function wireframeSvg(analysis, W, docH) {
  const H = Math.min(docH, MAX_WF_HEIGHT);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`, `<rect width="${W}" height="${H}" fill="#ffffff"/>`];
  const rect = (b, fill, stroke = '#8a929b', rx = 2) => {
    if (b.y > H) return;
    parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${Math.min(b.h, H - b.y)}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`);
  };
  const { regions, units } = analysis;
  if (regions.sidenav) {
    rect(regions.sidenav, FILL.sidenav, '#7d8590', 0);
    for (let y = regions.sidenav.y + 80; y < Math.min(H, regions.sidenav.y + regions.sidenav.h) - 20; y += 40)
      parts.push(`<rect x="${regions.sidenav.x + 20}" y="${y}" width="${Math.max(40, regions.sidenav.w - 40)}" height="12" rx="3" fill="#a3aab3"/>`);
  }
  if (regions.topbar) rect(regions.topbar, FILL.topbar, '#7d8590', 0);
  if (regions.footer) rect(regions.footer, FILL.footer, '#9aa3ad', 0);
  for (const u of units) {
    const fill = FILL[u.kind] ?? '#f0f1f3';
    rect(u, fill, u.kind === 'button' ? '#6c757d' : '#8a929b', u.kind === 'button' || u.kind === 'input' ? 4 : 2);
    if (u.kind === 'table') {
      const cols = Math.max(3, Math.min(7, Math.round(u.w / 180)));
      for (let c = 1; c < cols; c += 1) parts.push(`<line x1="${u.x + (u.w * c) / cols}" y1="${u.y}" x2="${u.x + (u.w * c) / cols}" y2="${Math.min(u.y + u.h, H)}" stroke="#c3c9d0"/>`);
      for (let y = u.y + 40; y < Math.min(u.y + u.h, H); y += 40) parts.push(`<line x1="${u.x}" y1="${y}" x2="${u.x + u.w}" y2="${y}" stroke="#c3c9d0"/>`);
    } else if (u.kind === 'chart') {
      const pts = [];
      for (let i = 0; i <= 12; i += 1) pts.push(`${u.x + (u.w * i) / 12},${u.y + u.h * (0.35 + 0.45 * Math.abs(Math.sin(i * 1.3)))}`);
      parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="#7d8590" stroke-width="2"/>`);
    } else if (u.kind === 'image') {
      parts.push(`<line x1="${u.x}" y1="${u.y}" x2="${u.x + u.w}" y2="${u.y + u.h}" stroke="#aab0b8"/><line x1="${u.x + u.w}" y1="${u.y}" x2="${u.x}" y2="${u.y + u.h}" stroke="#aab0b8"/>`);
    } else if (u.kind === 'title' || u.kind === 'text' || u.kind === 'kv' || u.kind === 'list' || u.kind === 'summary') {
      for (let y = u.y + 8; y < Math.min(u.y + u.h, H) - 6; y += 22) parts.push(`<rect x="${u.x + 8}" y="${y}" width="${Math.max(24, Math.min(u.w - 16, u.kind === 'title' ? 260 : u.w * 0.7))}" height="10" rx="3" fill="#b8bfc7"/>`);
    }
  }
  if (regions.modal) {
    parts.push(`<rect width="${W}" height="${H}" fill="#000" opacity="0.25"/>`);
    rect(regions.modal, FILL.modal, '#6c757d', 6);
  }
  parts.push('</svg>');
  return parts.join('\n');
}

async function svgToPng(browser, svg, outPng, W) {
  const scale = 0.5;
  const ctx = await browser.newContext({ viewport: { width: Math.round(W * scale), height: 400 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  try {
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">${svg.replace(/width="\d+" height="\d+"/, `width="${Math.round(W * scale)}"`)}</body></html>`);
    await page.locator('svg').screenshot({ path: outPng, type: 'png' });
  } finally {
    await ctx.close();
  }
}

// ── Nhánh admin ────────────────────────────────────────────────────────────

async function runAdmin(args, cacheDir, browser) {
  const spec = await readJson(ADMIN_TEMPLATES_FILE);
  const pages = [];
  const sources = [];
  for (const tpl of spec.templates ?? []) {
    if (args.templates && !args.templates.has(tpl.id)) continue;
    sources.push({ id: `${SOURCE_PREFIX}${tpl.id}`, license: tpl.license, note: `${tpl.name} — ${tpl.source}` });
    const dir = path.join(cacheDir, tpl.id);
    await fs.mkdir(dir, { recursive: true });
    console.log(`  ${tpl.name} (${tpl.license}) — ${tpl.pages.length} trang`);
    for (const pg of tpl.pages) {
      const id = `${tpl.id}-${pg.name}`;
      const cacheFile = path.join(dir, `${pg.name}.json`);
      const url = new URL(pg.path, tpl.base).toString();
      let data = null;
      if (!args.force && (await exists(cacheFile))) data = await readJson(cacheFile).catch(() => null);
      if (!data || !Array.isArray(data.els)) {
        if (!browser) {
          console.log(`    ${id}: không có cache boxes và không có trình duyệt — bỏ`);
          continue;
        }
        process.stdout.write(`    ${id}: render ${url} … `);
        try {
          data = await renderPage(browser, url, args.viewport);
          await fs.writeFile(cacheFile, JSON.stringify(data), 'utf8');
          console.log(`${data.els.length} hộp, docH ${data.docH}`);
        } catch (err) {
          console.log(`lỗi ${err?.message?.split('\n')[0] ?? err}`);
          continue;
        }
      }
      pages.push({ id, name: pg.name, url, topicHint: pg.topic ?? null, source: `${SOURCE_PREFIX}${tpl.id}`, data });
    }
  }
  return { pages, sources };
}

// ── Nhánh WebUI (HF biglab/webui-7k) ───────────────────────────────────────

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
        const pct = total ? Math.floor((got / total) * 20) * 5 : -1;
        if (pct !== lastPct) {
          lastPct = pct;
          process.stdout.write(`\r  ${path.basename(dest)} ${pct >= 0 ? `${pct}%` : ''} (${(got / 1e6).toFixed(0)} MB)`);
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
    req.setTimeout(300_000, () => req.destroy(new Error(`timeout ${url}`)));
    req.on('error', reject);
  });
}

const gunzipJson = async (p) => JSON.parse(zlib.gunzipSync(await fs.readFile(p)).toString('utf8'));

/** Thư mục 1 sample WebUI (`<id>/default_1920-1080-{bb,class,axtree,viewport}.json.gz`) → elements theo thứ tự cây a11y. */
export async function webuiSampleToElements(dir, vp = WEBUI_VIEWPORT) {
  const f = (suffix) => path.join(dir, `${vp}-${suffix}`);
  if (!(await exists(f('bb.json.gz')))) return null;
  const bb = await gunzipJson(f('bb.json.gz'));
  const cls = (await exists(f('class.json.gz'))) ? await gunzipJson(f('class.json.gz')) : {};
  const vis = (await exists(f('viewport.json.gz'))) ? await gunzipJson(f('viewport.json.gz')) : {};
  const ax = (await exists(f('axtree.json.gz'))) ? await gunzipJson(f('axtree.json.gz')) : { nodes: [] };
  const url = (await fs.readFile(f('url.txt'), 'utf8').catch(() => '')).trim();
  const byId = new Map((ax.nodes ?? []).map((n) => [String(n.nodeId), n]));
  const roleOf = new Map();
  const order = [];
  const seen = new Set();
  const walk = (nodeId) => {
    const n = byId.get(String(nodeId));
    if (!n || seen.has(n.nodeId)) return;
    seen.add(n.nodeId);
    const dom = n.backendDOMNodeId != null ? String(n.backendDOMNodeId) : null;
    if (dom) {
      order.push(dom);
      roleOf.set(dom, n.role?.value ?? '');
    }
    for (const c of n.childIds ?? []) walk(c);
  };
  if (ax.nodes?.length) walk(ax.nodes[0].nodeId);
  for (const id of Object.keys(bb)) if (!roleOf.has(id)) order.push(id); // node không trong cây a11y: thêm cuối
  const AX_TAG = { navigation: 'nav', banner: 'header', contentinfo: 'footer', complementary: 'aside', table: 'table', form: 'form', textbox: 'input', combobox: 'select', button: 'button', heading: 'h2', img: 'img', list: 'ul', dialog: 'dialog', tablist: 'div', paragraph: 'p', main: 'main' };
  const els = [];
  let rootName = ax.nodes?.[0]?.name?.value ?? '';
  for (const id of order) {
    const b = bb[id];
    if (!b || !(b.width >= 8 && b.height >= 6)) continue;
    if (vis[id] === false && b.y < 1080) continue; // ẩn trong viewport
    const role = roleOf.get(id) ?? '';
    const classes = Object.values(cls[id] ?? {}).join(' ');
    els.push({ tag: AX_TAG[role] ?? 'div', role, cls: classes, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) });
  }
  const root = bb['3'] ?? Object.values(bb)[0];
  const docH = Math.max(...els.map((e) => e.y + e.h), root?.height ?? 1080);
  return { url, title: rootName, w: root?.width ?? 1920, h: 1080, docH, els };
}

async function runWebui(args, cacheDir, exclude) {
  const dir = path.join(cacheDir, 'webui');
  await fs.mkdir(dir, { recursive: true });
  const t0 = Date.now();
  const base = `https://huggingface.co/datasets/${WEBUI_REPO}/resolve/main/`;
  let dataDir = args.webuiDir;
  if (!dataDir) {
    const idsFile = path.join(dir, WEBUI_FILES[0]);
    if (!(await exists(idsFile))) await fetchToFile(base + WEBUI_FILES[0], idsFile);
    dataDir = path.join(dir, 'data');
    if (!(await exists(dataDir))) {
      const parts = [];
      for (const name of WEBUI_FILES.slice(1)) {
        const dest = path.join(dir, name);
        if (!(await exists(dest))) {
          if ((Date.now() - t0) / 60_000 > args.webuiMaxMinutes) throw new Error(`webui: quá ${args.webuiMaxMinutes} phút — dừng nhánh`);
          console.log(`  webui: tải ${name} (~4 GB)`);
          await fetchToFile(base + name, dest);
        }
        parts.push(dest);
      }
      const joined = path.join(dir, 'train_split_web7k.zip');
      if (!(await exists(joined))) {
        console.log('  webui: ghép 2 phần zip → train_split_web7k.zip');
        const r = spawnSync('sh', ['-c', `cat ${parts.map((p) => JSON.stringify(p)).join(' ')} > ${JSON.stringify(joined)}`], { stdio: 'inherit' });
        if (r.status !== 0) throw new Error('webui: ghép zip lỗi');
      }
      console.log(`  webui: giải nén → ${dataDir}`);
      const r = spawnSync('unzip', ['-o', '-q', joined, '-d', dataDir], { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0 && r.status !== 1) throw new Error(`webui: unzip lỗi ${r.status}: ${r.stderr?.toString().slice(0, 300)}`);
    }
  }
  // Mỗi id = 1 thư mục (có thể lồng 1 cấp: <dataDir>/<split>/<id>).
  const entries = [];
  const scan = async (d, depth) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      if (await exists(path.join(p, `${WEBUI_VIEWPORT}-bb.json.gz`))) entries.push({ id: e.name, dir: p });
      else if (depth < 2) await scan(p, depth + 1);
    }
  };
  await scan(dataDir, 0);
  console.log(`  webui: ${entries.length} sample có ${WEBUI_VIEWPORT}`);
  const pages = [];
  const perTopic = new Map();
  for (const e of entries) {
    const id = `webui-${e.id}`;
    if (exclude.has(id) || exclude.has(e.id)) continue;
    let data;
    try {
      data = await webuiSampleToElements(e.dir);
    } catch {
      continue;
    }
    if (!data) continue;
    const a = bandsFromBoxes(data.els, { w: data.w, h: data.h, docH: data.docH });
    if (a.bands.length < MIN_BANDS || a.bands.includes('empty')) continue;
    const topic = topicFor({ name: data.title, url: data.url, bands: a.bands });
    const n = perTopic.get(topic) ?? 0;
    if (n >= args.maxPerTopic * 3) continue; // đủ ứng viên cho topic này
    perTopic.set(topic, n + 1);
    pages.push({ id, name: e.id, url: data.url, topicHint: null, source: `${SOURCE_PREFIX}webui-7k`, data });
  }
  return {
    pages,
    sources: [{ id: `${SOURCE_PREFIX}webui-7k`, license: 'other (CMU research terms — js0nwu/webui COPYRIGHT.txt)', note: `HF ${WEBUI_REPO}, viewport ${WEBUI_VIEWPORT}; chỉ dùng bbox/class/axtree (không ảnh chụp).` }],
  };
}

// ── Merge manifest ─────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.out;
  const cacheDir = path.join(outDir, '.cache', 'web');
  const wfDir = path.join(outDir, 'wireframes', 'web');
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.mkdir(wfDir, { recursive: true });
  console.log(`layout-kb web → ${outDir}`);

  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest = (await exists(manifestPath))
    ? await readJson(manifestPath)
    : { schema_version: 2, source: 'enrico', license: 'MIT', builtAt: new Date().toISOString(), sources: [], topics: {} };
  if (!manifest.topics || typeof manifest.topics !== 'object') manifest.topics = {};
  const curate = await readJson(path.join(outDir, 'curate.json')).catch(() => ({}));
  const exclude = new Set(Array.isArray(curate?.exclude) ? curate.exclude.map(String) : []);

  const browser = await openBrowser(args);
  if (!browser) console.log('  (không có Playwright/chromium — chỉ dùng cache boxes; wireframe ghi .svg)');

  const pages = [];
  const sources = [];
  try {
    if (args.admin) {
      console.log('Nhánh admin templates:');
      const r = await runAdmin(args, cacheDir, browser);
      pages.push(...r.pages);
      sources.push(...r.sources);
    }
    if (args.webui) {
      console.log('Nhánh WebUI (HF biglab/webui-7k):');
      try {
        const r = await runWebui(args, cacheDir, exclude);
        pages.push(...r.pages);
        sources.push(...r.sources);
      } catch (err) {
        console.log(`  webui: ${err?.message ?? err} — bỏ nhánh này, nhánh admin vẫn tiếp tục`);
      }
    }

    // Phân tích band + topic cho từng trang.
    const analysed = [];
    for (const pg of pages) {
      if (exclude.has(pg.id)) continue;
      const vp = { w: pg.data.w ?? args.viewport.w, h: pg.data.h ?? args.viewport.h, docH: pg.data.docH };
      const a = bandsFromBoxes(pg.data.els, vp);
      const topicAuto = topicFor({ name: pg.name, url: pg.url, bands: a.bands });
      const topic = pg.topicHint && WEB_TOPICS.includes(pg.topicHint) ? pg.topicHint : topicAuto;
      if (a.bands.length < MIN_BANDS) continue;
      analysed.push({ ...pg, analysis: a, bands: a.bands, topic, topicAuto, vp });
      if (args.dump) console.log(`    ${pg.id.padEnd(30)} ${topic.padEnd(14)}${topic !== topicAuto ? `(auto ${topicAuto}) ` : ''}${a.bands.join(' › ')}`);
    }

    // Wireframe từng trang (PNG qua Playwright; không có → SVG).
    let imgCount = 0;
    for (const pg of analysed) {
      const png = path.join(wfDir, `${pg.id}.png`);
      const svgPath = path.join(wfDir, `${pg.id}.svg`);
      if (!args.force && (await exists(png))) {
        pg.wireframe = `wireframes/web/${pg.id}.png`;
        imgCount += 1;
        continue;
      }
      const svg = wireframeSvg(pg.analysis, pg.vp.w, pg.vp.docH ?? pg.vp.h);
      if (browser) {
        try {
          await svgToPng(browser, svg, png, pg.vp.w);
          pg.wireframe = `wireframes/web/${pg.id}.png`;
          imgCount += 1;
          continue;
        } catch (err) {
          console.log(`    ${pg.id}: PNG lỗi (${err?.message?.split('\n')[0]}) → ghi SVG`);
        }
      }
      await fs.writeFile(svgPath, svg, 'utf8');
      pg.wireframe = `wireframes/web/${pg.id}.svg`;
      imgCount += 1;
    }

    // Merge theo topic.
    const mySources = new Set(sources.map((s) => s.id));
    const isMine = (x) => typeof x?.source === 'string' && (mySources.has(x.source) || (args.force && x.source.startsWith(SOURCE_PREFIX)));
    const byTopic = new Map();
    for (const pg of analysed) {
      const arr = byTopic.get(pg.topic) ?? [];
      arr.push(pg);
      byTopic.set(pg.topic, arr);
    }
    const summary = [];
    for (const topic of WEB_TOPICS) {
      const real = byTopic.get(topic) ?? [];
      const t = manifest.topics[topic] ?? { platform: 'web', count: 0, templates: [], samples: [] };
      t.platform = 'web';
      t.templates = (t.templates ?? []).filter((x) => !isMine(x));
      t.samples = (t.samples ?? []).filter((x) => !isMine(x));
      const handCount = t.templates.length;
      if (!real.length && !manifest.topics[topic]) continue; // không có gì để ghi
      // Template thật: nhóm theo signature (bỏ số đếm), phổ biến trước.
      const bySig = new Map();
      for (const pg of real) {
        const sigBands = pg.bands.map(stripCount);
        const sig = signatureOf(pg.bands);
        const g = bySig.get(sig) ?? { sig, bands: sigBands, sidenav: pg.analysis.sidenav, ids: [] };
        g.ids.push(pg.id);
        bySig.set(sig, g);
      }
      const existingSigs = new Set(t.templates.map((x) => signatureOf(x.bands ?? [])));
      const usedSlug = new Set(t.templates.map((x) => x.id));
      const groups = [...bySig.values()].sort((a, b) => b.ids.length - a.ids.length || a.sig.localeCompare(b.sig));
      for (const g of groups) {
        if (t.templates.length >= MAX_TEMPLATES_PER_TOPIC) break;
        if (existingSigs.has(g.sig)) {
          // khuôn tay đã có cùng signature → chỉ nối id sample vào khuôn tay
          const hand = t.templates.find((x) => signatureOf(x.bands ?? []) === g.sig);
          if (hand) hand.samples = [...new Set([...(hand.samples ?? []), ...g.ids.slice(0, 3)])];
          continue;
        }
        let slug = `${topic}-${slugOf(g.bands)}`;
        let k = 2;
        while (usedSlug.has(slug)) slug = `${topic}-${slugOf(g.bands)}-${k++}`;
        usedSlug.add(slug);
        t.templates.push({ id: slug, bands: g.bands, sketch: sketchFor(g.bands, { sidenav: g.sidenav }), samples: g.ids.slice(0, 3), source: real.find((p) => p.id === g.ids[0])?.source ?? `${SOURCE_PREFIX}admin` });
      }
      // Sample: đa dạng signature — vòng 1 mỗi signature 1 trang, vòng 2+ bổ sung, ≤ maxPerTopic.
      const picked = [];
      for (let round = 0; picked.length < args.maxPerTopic && round < 6; round += 1) {
        let added = false;
        for (const g of groups) {
          if (picked.length >= args.maxPerTopic) break;
          const id = g.ids[round];
          if (!id) continue;
          const pg = real.find((p) => p.id === id);
          if (!pg?.wireframe) continue;
          picked.push({ id: pg.id, wireframe: pg.wireframe, bands: pg.bands, source: pg.source });
          added = true;
        }
        if (!added) break;
      }
      t.samples.push(...picked);
      t.count = handCount + real.length;
      manifest.topics[topic] = t;
      summary.push({ topic, hand: handCount, tpl: t.templates.length, samples: t.samples.length, real: real.length, sig: groups[0]?.sig ?? '' });
    }

    manifest.schema_version = Math.max(2, Number(manifest.schema_version) || 2);
    const srcById = new Map((Array.isArray(manifest.sources) ? manifest.sources : []).map((s) => [s.id, s]));
    for (const s of sources) srcById.set(s.id, s);
    manifest.sources = [...srcById.values()];
    manifest.builtAt = new Date().toISOString();
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const nMobile = Object.values(manifest.topics).filter((t) => t.platform !== 'web').length;
    console.log('');
    console.log(`Xong ${((Date.now() - t0) / 1000).toFixed(1)}s — ${analysed.length}/${pages.length} trang phân tích, ${imgCount} wireframe; manifest schema ${manifest.schema_version}: ${nMobile} topic mobile + ${Object.keys(manifest.topics).length - nMobile} topic web.`);
    for (const s of summary) console.log(`  ${s.topic.padEnd(14)} ${String(s.real).padStart(3)} trang  ${s.tpl} tpl (${s.hand} tay)  ${String(s.samples).padStart(2)} sample  | ${s.sig}`);
  } finally {
    await browser?.close().catch(() => null);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`layout-kb web: ${err?.message ?? err}`);
    process.exit(1);
  });
}
