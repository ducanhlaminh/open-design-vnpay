// figma-capture — "code → screen JSON → Figma" capture of the UI-Spec
// (React DS) app. Drives the BUILT react-ds/dist with Playwright, captures a
// full figma-h2d IR per screen/state (component instance markers from the
// design-system bundle + tk-* token-name hints + layout declarations), and
// writes the screens.json the design-v3 Fig Pipeline plugin's "Screen JSON →
// Figma" tab rebuilds with REAL component instances (variant + props + swap)
// bound to Figma variables by token name.
//
// Only meaningful for the ui-react-ds stage: its components come from the
// imported design system's compiled bundle, which stamps
// data-fig-comp/variant/props when `window.__FIG_CAPTURE__` is on. A generic
// ui-react app has no markers (and no matching UI-Lib Figma file) — capturing
// it would produce anonymous frames only.
//
// Runtime layout mirrors react-demo.ts: the pinned Playwright lives in
// <runtimeDataDir>/react-demo-runner (shared env, one chromium download), the
// generated runner serves dist itself over 127.0.0.1 and imports the vendored
// capture helpers from the daemon dist by absolute file URL. Deliverables land
// under react-ds/figma-screens/ (inside the stage outputs, so they sync to the
// media store): screens/NN-*.capture.json + shots/NN-*.png + <name>.screens.json.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { ensureRunnerEnv, execBuffered } from './react-demo.js';

export interface FigmaCaptureState {
  name: string;
  clicks?: string[];
}

export interface FigmaCaptureScreen {
  /**
   * `/screens/<slug>.html` captures a built standalone page; any other value
   * is treated as a hash route of the full app (`/index.html#<path>`).
   */
  path: string;
  name: string;
  states?: FigmaCaptureState[];
}

export interface FigmaCaptureConfig {
  project?: string;
  viewport?: { width: number; height: number };
  /**
   * Capture WIDTHS. Explicit list wins; otherwise the staged bundle's
   * `.od-target.json` decides: responsive target → [1440, 390] (one Figma
   * frame per width, named `<screen> · <width>`), fixed-viewport target →
   * just the base viewport width.
   */
  viewports?: number[];
  rootSelector?: string;
  screens?: FigmaCaptureScreen[];
}

/** Effective capture viewport list (exported for tests). `configWidths` from
 * capture.config.json wins; else responsive targets capture desktop+mobile.
 * Desktop-ish widths (≥1024) get a taller default height. */
export function resolveCaptureViewports(
  configWidths: unknown,
  responsive: boolean,
  baseViewport: { width: number; height: number },
): Array<{ width: number; height: number }> {
  const explicit = Array.isArray(configWidths)
    ? configWidths.filter((w): w is number => Number.isFinite(w) && w >= 200 && w <= 4000)
    : [];
  const widths = explicit.length > 0 ? explicit : responsive ? [1440, 390] : [baseViewport.width];
  return widths.map((width) => ({
    width,
    height: width >= 1024 ? Math.max(900, baseViewport.height) : baseViewport.height,
  }));
}

export interface FigmaCaptureResult {
  screens: number;
  /** Total component-instance markers captured across all screens. */
  markers: number;
  outDir: string;
  /** Repo-relative-ish path of the merged screens.json inside the stage. */
  screensJson: string;
  output: string;
}

/** Screens to capture: the agent-authored capture.config.json wins; without
 * one, every built screen page gets a default stateless capture so the button
 * works out of the box. Exported for tests. */
export function deriveCaptureScreens(
  distScreenSlugs: string[],
  config: FigmaCaptureConfig,
): FigmaCaptureScreen[] {
  const declared = (config.screens ?? []).filter(
    (s): s is FigmaCaptureScreen =>
      Boolean(s) && typeof s.path === 'string' && s.path.length > 0 && typeof s.name === 'string' && s.name.length > 0,
  );
  if (declared.length > 0) return declared;
  return distScreenSlugs.map((slug, index) => ({
    path: `/screens/${slug}.html`,
    name: `${String(index + 1).padStart(2, '0')} ${slug.replace(/[-_]+/g, ' ')}`,
  }));
}

// ── Icon-marker realname rewrite ────────────────────────────────────────────
// compile-core SLUG hóa tên icon khi biên dịch (`iPay / Divider` → thẻ
// data-fig-icon="ipay-divider"), nên marker fig-comp trong screens.json mang
// slug — còn plugin "Screen JSON → Figma" match component theo TÊN NGUYÊN VĂN
// trong file đang mở → icon unmatched dù đã copy page Iconography vào UI Lib.
// Sau capture, map slug → tên thật từ IR của DS và viết lại marker. Icon là
// COMPONENT SET (slug có đuôi variant, vd …-icon-success) match theo PREFIX —
// variant rơi về default của set, icon vẫn hiện (chỉnh variant trong Figma nếu
// cần). Fix gốc (plugin match tên chuẩn hóa + variant cho icon) thuộc design-v3.

/** slug rule của compile-core (đồng bộ với vendor/fig-import/compile-core). */
export function compileCoreSlug(name: string): string {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/** Tên Figma thật cho một slug marker; null nếu không suy ra được. */
export function realIconNameForSlug(slug: string, nameBySlug: Map<string, string>): string | null {
  const exact = nameBySlug.get(slug);
  if (exact) return exact;
  // prefix dài nhất thắng (slug = slug(tên set) + '-' + slug(variant))
  let best: string | null = null;
  let bestLen = 0;
  for (const [candidate, real] of nameBySlug) {
    if (candidate.length > bestLen && slug.startsWith(`${candidate}-`)) {
      best = real;
      bestLen = candidate.length;
    }
  }
  return best;
}

/** Viết lại `fig-comp=<slug>` → tên thật trong mọi file capture của một
 *  figma-screens dir. Trả về số marker đã đổi. */
export async function rewriteIconMarkersInDir(
  figmaScreensDir: string,
  nameBySlug: Map<string, string>,
): Promise<number> {
  if (nameBySlug.size === 0) return 0;
  const targets: string[] = [];
  const screensDir = path.join(figmaScreensDir, 'screens');
  for (const f of await fs.promises.readdir(screensDir).catch(() => [] as string[])) {
    if (f.endsWith('.capture.json')) targets.push(path.join(screensDir, f));
  }
  for (const f of await fs.promises.readdir(figmaScreensDir).catch(() => [] as string[])) {
    if (f.endsWith('.screens.json')) targets.push(path.join(figmaScreensDir, f));
  }
  let total = 0;
  for (const file of targets) {
    const src = await fs.promises.readFile(file, 'utf8').catch(() => null);
    if (!src) continue;
    const out = src.replace(/fig-comp=([a-z0-9-]+)(?=[;"\\])/g, (whole, slug: string) => {
      const real = realIconNameForSlug(slug, nameBySlug);
      if (!real || real === slug) return whole;
      total += 1;
      return `fig-comp=${real}`;
    });
    if (out !== src) await fs.promises.writeFile(file, out, 'utf8');
  }
  return total;
}

/** Map slug → tên icon thật từ các file IR đã persist của DS. */
export async function iconNameMapFromIrDir(irDir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const f of await fs.promises.readdir(irDir).catch(() => [] as string[])) {
    if (!f.endsWith('.ir.json')) continue;
    try {
      const ir = JSON.parse(await fs.promises.readFile(path.join(irDir, f), 'utf8')) as {
        icons?: Array<{ name?: string }>;
      };
      for (const icon of ir.icons ?? []) {
        if (icon?.name) map.set(compileCoreSlug(icon.name), icon.name);
      }
    } catch {
      /* IR hỏng không chặn capture */
    }
  }
  return map;
}

export function slugifyCaptureName(raw: string): string {
  return (
    raw
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'screens'
  );
}

// The generated runner (plain Node ESM, executed with the host `node` from the
// runner dir so `playwright` resolves from its node_modules). No template
// literals inside — the whole runner is one String.raw template.
const RUN_FIGMA_CAPTURE_MJS = String.raw`// GENERATED by open-design (figma-capture.ts) — do not edit.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { promises as fsp, readFileSync, existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const cfg = JSON.parse(await fsp.readFile(process.argv[2], 'utf8'));
const lib = await import(pathToFileURL(cfg.captureLibPath).href);
const h2dBundle = readFileSync(cfg.h2dBundlePath, 'utf8');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};
const root = path.resolve(cfg.distDir);
const srv = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  let p = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
  if (p.endsWith(path.sep)) p = path.join(p, 'index.html');
  if (!p.startsWith(root)) { res.writeHead(403).end(); return; }
  if (!existsSync(p)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
  createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const countNodes = (n) => 1 + (n.childNodes || []).reduce((a, c) => a + countNodes(c), 0);
const countMarkers = (n) =>
  (((n.owningReactComponent || '').indexOf('kg:fig') === 0) ? 1 : 0) +
  (n.childNodes || []).reduce((a, c) => a + countMarkers(c), 0);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: cfg.viewport });
await page.addInitScript(() => { window.__FIG_CAPTURE__ = true; });

const all = [];
const skipped = [];
let idx = 0;
let totalMarkers = 0;
// Responsive targets capture EVERY screen/state once per viewport width — one
// Figma frame per width, suffixed with the width when there are several.
const viewports = cfg.viewportList && cfg.viewportList.length ? cfg.viewportList : [cfg.viewport];
for (const screen of cfg.screens) {
  const variants = [{ name: null, clicks: [] }].concat(screen.states || []);
  for (const state of variants) {
    for (const vp of viewports) {
    idx += 1;
    const stateLabel = state.name ? screen.name + ' — ' + state.name : screen.name;
    const label = viewports.length > 1 ? stateLabel + ' · ' + vp.width : stateLabel;
    const target = screen.path.endsWith('.html')
      ? 'http://127.0.0.1:' + port + screen.path
      : 'http://127.0.0.1:' + port + '/index.html#' + screen.path;
    // Every state reloads the screen from scratch (clicks are a FULL chain
    // from the default state); about:blank first so a same-URL hash target
    // still re-fires load.
    await page.setViewportSize(vp);
    await page.goto('about:blank');
    await lib.gotoRetry(page, target);
    // '#root' itself exists before React mounts — wait on its first child.
    const waitSelector = cfg.rootSelector === '#root' ? '#root > *' : cfg.rootSelector;
    await lib.preparePageForCapture(page, waitSelector);
    // A click chain that can't be walked (selector renamed, DS component that
    // drops the text it was matched on) costs this ONE state, not the run —
    // an uncaught Playwright timeout here used to kill the process before
    // screens.json was ever written, so every already-captured screen was lost.
    let deadSelector = null;
    for (const sel of state.clicks || []) {
      try {
        await page.click(sel, { timeout: 10000 });
      } catch {
        deadSelector = sel;
        break;
      }
      await page.waitForTimeout(250);
    }
    if (deadSelector) {
      console.error('x ' + label + ': click target not found — ' + deadSelector);
      skipped.push({ label: label, selector: deadSelector });
      continue;
    }
    // Sticky bars freeze at their viewport-relative position when serialized;
    // grow the viewport to the full content height so sticky-bottom footers
    // land at the real bottom of the frame instead of mid-content. Then reset
    // any scroll Playwright's click-into-view caused so rects start at (0,0).
    const contentHeight = await page.evaluate(() =>
      Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)),
    );
    if (contentHeight > vp.height) {
      await page.setViewportSize({ width: vp.width, height: contentHeight });
      await page.waitForTimeout(150);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await lib.stampFigMarkers(page, cfg.rootSelector);
    await lib.neutralizeTransformPositioning(page);
    const svgPrep = await lib.prepareSvgCapture(page);
    await page.addScriptTag({ content: h2dBundle });
    const r = await lib.captureRootIR(page, cfg.rootSelector);
    if (r.error) {
      console.error('x ' + label + ': ' + r.error);
      continue;
    }
    const diffs = await lib.collectStyleDiffs(page, cfg.rootSelector);
    await lib.restoreSvgTexts(page);
    const doc = lib.sanitizeDoc(
      lib.spliceStyleDiffs(lib.spliceSvgTexts(JSON.parse(r.serialized), svgPrep.svgTexts), diffs),
    );
    const spec = { name: cfg.project + ' · ' + label, width: vp.width, doc };
    const base = String(idx).padStart(2, '0') + '-' + slug(label);
    await fsp.writeFile(path.join(cfg.outDir, 'screens', base + '.capture.json'), JSON.stringify(spec));
    await page.screenshot({ path: path.join(cfg.outDir, 'shots', base + '.png'), fullPage: true });
    const markers = countMarkers(doc.root || doc);
    totalMarkers += markers;
    all.push(spec);
    console.log('ok ' + label + ' — ' + countNodes(doc.root || doc) + ' node IR, ' + markers + ' instance marker');
    }
  }
}

await fsp.writeFile(
  path.join(cfg.outDir, cfg.screensJsonName),
  JSON.stringify({ version: 2, screens: all }),
);
await browser.close();
srv.close();
// Re-state skips at the very end: the daemon only keeps the last 30 output
// lines, so a skip early in a long run would otherwise scroll out of sight.
if (skipped.length) {
  console.log('! ' + skipped.length + ' state bỏ qua: ' + skipped.map((s) => s.label + ' (' + s.selector + ')').join(', '));
}
console.log('__RESULT__' + JSON.stringify({ screens: all.length, markers: totalMarkers, skipped: skipped }));
`;

/** Capture every configured screen/state of a BUILT react-ds/ app into
 * react-ds/figma-screens/. Throws with a user-actionable message when dist is
 * missing or no screens exist. */
export async function runFigmaCapture(
  reactDsDir: string,
  runtimeDataDir: string,
  projectName: string,
): Promise<FigmaCaptureResult> {
  const distDir = path.join(reactDsDir, 'dist');
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(
      'react-ds/dist chưa có — bấm Build app (hoặc `od pipeline build`) trước khi capture Figma.',
    );
  }

  let config: FigmaCaptureConfig = {};
  const configPath = path.join(reactDsDir, 'capture.config.json');
  if (fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(await fs.promises.readFile(configPath, 'utf8')) as unknown;
      if (raw && typeof raw === 'object') config = raw as FigmaCaptureConfig;
    } catch {
      throw new Error(`react-ds/capture.config.json không phải JSON hợp lệ — sửa file rồi chạy lại.`);
    }
  }

  const distScreensDir = path.join(distDir, 'screens');
  let slugs: string[] = [];
  try {
    slugs = (await fs.promises.readdir(distScreensDir))
      .filter((f) => /\.html?$/i.test(f))
      .map((f) => f.replace(/\.html?$/i, ''))
      .sort();
  } catch {
    slugs = [];
  }
  const screens = deriveCaptureScreens(slugs, config);
  if (screens.length === 0) {
    throw new Error('không có screen nào để capture (dist/screens trống và capture.config.json không khai màn).');
  }

  const runnerDir = path.join(runtimeDataDir, 'react-demo-runner');
  await ensureRunnerEnv(runnerDir);
  await fs.promises.writeFile(path.join(runnerDir, 'run-figma-capture.mjs'), RUN_FIGMA_CAPTURE_MJS);

  // The runner is plain Node — it needs the COMPILED capture-lib. When the
  // daemon itself runs from dist/ the sibling path resolves; when it runs
  // straight from src/ (tsx dev loop) fall back to the package's dist build.
  const captureLibCandidates = [
    fileURLToPath(new URL('./vendor/fig-capture/capture-lib.js', import.meta.url)),
    fileURLToPath(new URL('../dist/vendor/fig-capture/capture-lib.js', import.meta.url)),
  ];
  const captureLibPath = captureLibCandidates.find((p) => fs.existsSync(p));
  if (!captureLibPath) {
    throw new Error(
      'capture-lib build not found — run `pnpm --filter @open-design/daemon build` once so dist/vendor/fig-capture/capture-lib.js exists.',
    );
  }
  const h2dBundlePath = createRequire(import.meta.url).resolve('@open-design/figma-h2d/global');

  const outDir = path.join(reactDsDir, 'figma-screens');
  await fs.promises.rm(outDir, { recursive: true, force: true }).catch(() => null);
  await fs.promises.mkdir(path.join(outDir, 'screens'), { recursive: true });
  await fs.promises.mkdir(path.join(outDir, 'shots'), { recursive: true });

  const project = typeof config.project === 'string' && config.project.trim() ? config.project.trim() : projectName;
  const screensJsonName = `${slugifyCaptureName(project)}.screens.json`;
  // Responsive targets (staging marker .od-target.json) capture desktop+mobile
  // frames per screen; explicit capture.config.json `viewports` overrides.
  let responsive = false;
  try {
    const marker = JSON.parse(
      await fs.promises.readFile(path.join(reactDsDir, '.od-target.json'), 'utf8'),
    ) as { responsive?: boolean };
    responsive = marker?.responsive === true;
  } catch {
    /* legacy staging without marker → fixed viewport */
  }
  const baseViewport = config.viewport ?? { width: 390, height: 844 };
  const configJson = {
    distDir,
    outDir,
    project,
    screensJsonName,
    viewport: baseViewport,
    viewportList: resolveCaptureViewports(config.viewports, responsive, baseViewport),
    // '#root' (not '#root > *'): screens commonly render overlays (bottom
    // sheets, dialogs) as FRAGMENT SIBLINGS of the screen shell — capturing
    // only #root's first child silently drops them from the IR.
    rootSelector: config.rootSelector ?? '#root',
    screens,
    captureLibPath,
    h2dBundlePath,
  };
  const runnerConfigPath = path.join(runnerDir, `figma-capture-config-${Date.now()}.json`);
  await fs.promises.writeFile(runnerConfigPath, JSON.stringify(configJson, null, 2));
  try {
    const r = await execBuffered(
      process.execPath,
      [path.join(runnerDir, 'run-figma-capture.mjs'), runnerConfigPath],
      { cwd: runnerDir, timeout: 10 * 60_000 },
    );
    const combined = [r.stdout, r.stderr].filter(Boolean).join('\n');
    const tail = combined.split('\n').slice(-30).join('\n');
    if (!r.ok) throw new Error(tail || 'playwright figma-capture run failed');
    const resultLine = combined.split('\n').reverse().find((l) => l.startsWith('__RESULT__'));
    let screensCount = 0;
    let markers = 0;
    if (resultLine) {
      try {
        const parsed = JSON.parse(resultLine.slice('__RESULT__'.length)) as { screens?: number; markers?: number };
        screensCount = Number(parsed.screens ?? 0);
        markers = Number(parsed.markers ?? 0);
      } catch {
        /* tail still carries the story */
      }
    }
    if (screensCount === 0) throw new Error(tail || 'capture không ra màn nào');
    return {
      screens: screensCount,
      markers,
      outDir,
      screensJson: path.join('figma-screens', screensJsonName),
      output: tail.replace(/^__RESULT__.*$/m, '').trimEnd(),
    };
  } finally {
    await fs.promises.rm(runnerConfigPath, { force: true }).catch(() => null);
  }
}
