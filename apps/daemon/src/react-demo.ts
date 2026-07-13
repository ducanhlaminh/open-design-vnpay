// react-demo — the PROTOTYPE auto-demo of the docs→React workflow: drive the
// BUILT app (react/dist) through its flow.json use cases with Playwright and
// record what a real user would see (fixed headers, scroll, dialogs, route
// transitions — everything a wireframe cannot express). TOOL-ONLY: use cases
// derive deterministically from flow.json (same walk as the studio simulator)
// and every step is a click on the skill's `data-flow-action` contract — no
// LLM anywhere.
//
// Runtime layout (host Node, no Docker):
//   <runtimeDataDir>/react-demo-runner/   — self-contained npm env holding the
//     pinned `playwright` package + the generated run-demo.mjs. Kept OUTSIDE
//     the pnpm workspace on purpose: npm-installing playwright inside the
//     workspace is a known failure mode. Browsers land in Playwright's own
//     user cache; `playwright install chromium` is a no-op when present.
//   <reactDir>/prototype-demo/<case>/demo.webm + steps/NN.png + steps.json
//     — the deliverables (under react/, so they sync to the media store and
//     pipeline-studio can play them).

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// Pinned so the runner env is reproducible; bump deliberately.
const PLAYWRIGHT_VERSION = '1.54.2';

export interface DemoFlowEdge {
  from: string;
  to: string;
  label?: string;
  type?: string;
  overlay?: string;
}

export type DemoStepKind = 'scroll' | 'tap' | 'hold';
/** One planned interaction in a screen's demo. `target` (tap/hold) names the
 * element by its VISIBLE text or `data-flow-action` — the runner resolves it
 * flexibly. `note` is the Vietnamese caption shown on the touch overlay. */
export interface DemoStepSpec {
  do: DemoStepKind;
  target?: string;
  note?: string;
}
/** One demo per SCREEN: the Playwright runner loads the screen and replays its
 * steps (scroll / tap / hold) — no cross-screen navigation (that flow lives in
 * the UX Spec flowchart now). Steps come from `react/demo.json` (LLM-reasoned
 * by the ui-react agent — it knows every interaction it built) when present,
 * else are derived deterministically from flow.json's in-screen edges. */
export interface DemoUseCase {
  id: string;
  /** Output folder name == the screen slug (1:1 with the built screen). */
  dir: string;
  /** The screen this demo exercises. */
  slug: string;
  title: string;
  platform: 'mobile' | 'web';
  steps: DemoStepSpec[];
  /** 'llm' = react/demo.json (agent-reasoned); 'flow' = derived from flow.json. */
  source: 'llm' | 'flow';
}

const isInPlaceEdge = (e: DemoFlowEdge) =>
  e.type === 'dialog' || e.type === 'dismiss' || e.type === 'alert';

/** Fallback (no react/demo.json): ONE demo per built screen, derived from
 * flow.json's in-screen edges (overlay open/dismiss where `to === from`). Every
 * screen gets a leading scroll pass; screens with in-place edges also tap each.
 * Deterministic — used when the agent didn't reason a scenario. */
export function deriveScreenDemos(
  slugs: string[],
  titles: Map<string, string>,
  flow: DemoFlowEdge[],
  layouts: Record<string, 'mobile' | 'web'>,
): DemoUseCase[] {
  const slugSet = new Set(slugs);
  const tapsBySlug = new Map<string, DemoStepSpec[]>();
  const seen = new Set<string>();
  for (const e of flow) {
    if (!isInPlaceEdge(e) || e.from !== e.to || !slugSet.has(e.from) || !e.label) continue;
    const key = `${e.from}|${e.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tapsBySlug.set(e.from, [...(tapsBySlug.get(e.from) ?? []), { do: 'tap', target: e.label, note: e.label }]);
  }
  return slugs.map((slug) => ({
    id: slug,
    dir: slug,
    slug,
    title: titles.get(slug) ?? slug,
    platform: layouts[slug] === 'web' ? 'web' : 'mobile',
    steps: [{ do: 'scroll' as const, note: 'Cuộn xem toàn màn' }, ...(tapsBySlug.get(slug) ?? [])],
    source: 'flow' as const,
  }));
}

/** Parse `react/demo.json` (LLM-reasoned scenarios) into per-screen demos. The
 * agent reasons a realistic interaction scenario for EACH screen — including
 * ones flow.json never captured. Shape (per screen slug):
 *   { "title"?: string, "steps": [{ "do": "scroll|tap|hold", "target"?: string, "note"?: string }] }
 * Only screens that were actually built are kept; a built screen missing from
 * demo.json falls back to a scroll-through so no screen is silently dropped. */
export function parseDemoScenarios(
  raw: unknown,
  slugs: string[],
  titles: Map<string, string>,
  layouts: Record<string, 'mobile' | 'web'>,
): DemoUseCase[] {
  const byScreen = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const normKind = (v: unknown): DemoStepKind =>
    v === 'scroll' || v === 'hold' ? v : 'tap';
  return slugs.map((slug) => {
    const entry = byScreen[slug];
    const rawSteps = entry && typeof entry === 'object' ? (entry as { steps?: unknown }).steps : undefined;
    const title =
      (entry && typeof entry === 'object' && typeof (entry as { title?: unknown }).title === 'string'
        ? ((entry as { title: string }).title)
        : undefined) ?? titles.get(slug) ?? slug;
    let steps: DemoStepSpec[] = Array.isArray(rawSteps)
      ? (rawSteps as Array<Record<string, unknown>>)
          .filter((s) => s && typeof s === 'object')
          .map((s) => ({
            do: normKind(s.do),
            ...(typeof s.target === 'string' && s.target ? { target: s.target } : {}),
            ...(typeof s.note === 'string' && s.note ? { note: s.note } : {}),
          }))
          .filter((s) => s.do === 'scroll' || s.target) // tap/hold need a target
      : [];
    // Built screen the agent didn't script → still show it (scroll-through).
    if (steps.length === 0) steps = [{ do: 'scroll', note: 'Cuộn xem toàn màn' }];
    return {
      id: slug,
      dir: slug,
      slug,
      title,
      platform: layouts[slug] === 'web' ? 'web' : 'mobile',
      steps,
      source: 'llm' as const,
    };
  });
}

function execBuffered(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeout ?? 120_000, maxBuffer: 16 * 1024 * 1024, env: opts.env ?? process.env },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

/** One-time (then no-op) runner env: npm-install the pinned playwright into an
 * isolated dir outside the workspace, then make sure chromium is present. */
async function ensureRunnerEnv(runnerDir: string): Promise<void> {
  await fs.promises.mkdir(runnerDir, { recursive: true });
  const pkgPath = path.join(runnerDir, 'package.json');
  await fs.promises.writeFile(
    pkgPath,
    JSON.stringify(
      { name: 'od-react-demo-runner', private: true, dependencies: { playwright: PLAYWRIGHT_VERSION } },
      null,
      2,
    ),
  );
  const installed = fs.existsSync(path.join(runnerDir, 'node_modules', 'playwright', 'package.json'));
  if (!installed) {
    const r = await execBuffered('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: runnerDir,
      timeout: 5 * 60_000,
    });
    if (!r.ok) {
      throw new Error(
        `npm install playwright thất bại trong ${runnerDir}:\n${(r.stderr || r.stdout).split('\n').slice(-10).join('\n')}`,
      );
    }
  }
  // Idempotent: downloads chromium on first run, instant no-op afterwards.
  const pwBin = path.join(runnerDir, 'node_modules', '.bin', 'playwright');
  const r2 = await execBuffered(pwBin, ['install', 'chromium'], { cwd: runnerDir, timeout: 10 * 60_000 });
  if (!r2.ok) {
    throw new Error(
      `playwright install chromium thất bại:\n${(r2.stderr || r2.stdout).split('\n').slice(-10).join('\n')}`,
    );
  }
}

// The generated runner (plain Node ESM, executed with the host `node` from the
// runner dir so `playwright` resolves from its node_modules). Serves the built
// dist itself over 127.0.0.1 (file:// would break the app) and records one
// video + per-step screenshots per use case.
const RUN_DEMO_MJS = String.raw`// GENERATED by open-design (react-demo.ts) — do not edit.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { promises as fsp, createReadStream, existsSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const cfg = JSON.parse(await fsp.readFile(process.argv[2], 'utf8'));

// Injected into every page BEFORE app scripts: a visible TOUCH overlay so the
// recorded video shows what the user is doing — a pointer dot that moves, a
// press/ripple on tap, and a pill label ("Cuộn" / "Chạm: …" / "Giữ"). Playwright
// records the DOM, so this overlay appears in the video and step screenshots.
// pointer-events:none → it never blocks the real clicks. No template literals
// (this whole runner is a String.raw template).
function __odInstallCursor() {
  var C = '__od_cursor', L = '__od_label';
  function make() {
    if (document.getElementById(C)) return;
    var css = document.createElement('style');
    css.textContent =
      '#' + C + '{position:fixed;left:-100px;top:-100px;width:38px;height:38px;margin:-19px 0 0 -19px;border-radius:50%;background:rgba(0,102,179,.22);border:2px solid rgba(0,102,179,.95);z-index:2147483647;pointer-events:none;opacity:0;transition:left .3s cubic-bezier(.23,1,.32,1),top .3s cubic-bezier(.23,1,.32,1),transform .12s ease,opacity .2s}' +
      '#' + C + '.s{opacity:1}' +
      '#' + C + '.press{transform:scale(.55);background:rgba(0,102,179,.5)}' +
      '#' + C + '.ripple::after{content:"";position:absolute;inset:-4px;border-radius:50%;border:2px solid rgba(0,102,179,.6);animation:odr .55s ease-out forwards}' +
      '@keyframes odr{from{transform:scale(.5);opacity:.85}to{transform:scale(2.4);opacity:0}}' +
      '#' + L + '{position:fixed;left:-100px;top:-100px;z-index:2147483647;pointer-events:none;background:rgba(17,24,39,.92);color:#fff;font:600 12px/1.25 -apple-system,system-ui,sans-serif;padding:4px 11px;border-radius:999px;transform:translate(-50%,0);white-space:nowrap;opacity:0;transition:opacity .2s,left .3s ease,top .3s ease;max-width:260px;overflow:hidden;text-overflow:ellipsis}' +
      '#' + L + '.s{opacity:1}';
    (document.head || document.documentElement).appendChild(css);
    var dot = document.createElement('div'); dot.id = C;
    var lab = document.createElement('div'); lab.id = L;
    document.documentElement.appendChild(dot);
    document.documentElement.appendChild(lab);
    window.__od = {
      move: function (x, y) { dot.classList.add('s'); dot.style.left = x + 'px'; dot.style.top = y + 'px'; },
      say: function (x, y, t) { if (!t) { lab.classList.remove('s'); return; } lab.textContent = t; lab.style.left = x + 'px'; lab.style.top = (y + 30) + 'px'; lab.classList.add('s'); },
      press: function () { dot.classList.add('press'); },
      release: function () { dot.classList.remove('press'); dot.classList.remove('ripple'); void dot.offsetWidth; dot.classList.add('ripple'); },
      hide: function () { dot.classList.remove('s'); lab.classList.remove('s'); },
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', make);
  else make();
  try { new MutationObserver(function () { if (!document.getElementById(C)) make(); }).observe(document.documentElement, { childList: true }); } catch (e) { /* ignore */ }
}
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};
const root = path.resolve(cfg.distDir);
const srv = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let p = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
  if (!p.startsWith(root)) { res.writeHead(403).end(); return; }
  if (!existsSync(p)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream' });
  createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

const browser = await chromium.launch();
const index = [];
// One demo PER SCREEN: load it, scroll it (reveals fixed headers / scroll
// behaviour a wireframe can't), then click each in-screen action in order.
// No cross-screen navigation — that flow is the flowchart's job.
for (const uc of cfg.cases) {
  const size = uc.platform === 'web' ? { width: 1280, height: 800 } : { width: 390, height: 844 };
  const caseOut = path.join(cfg.outDir, uc.dir);
  await fsp.mkdir(path.join(caseOut, 'steps'), { recursive: true });
  const ctx = await browser.newContext({ viewport: size, recordVideo: { dir: caseOut, size } });
  const page = await ctx.newPage();
  await page.addInitScript(__odInstallCursor);
  const steps = [];
  const shoot = async (i, label, ok) => {
    const shot = 'steps/' + String(i).padStart(2, '0') + '.png';
    await page.screenshot({ path: path.join(caseOut, shot) }).catch(() => {});
    steps.push({ i, slug: uc.slug, ...(label ? { label } : {}), ok, shot });
  };
  let failedAt = null;
  try {
    await page.goto('http://127.0.0.1:' + port + '/screens/' + uc.slug + '.html', { waitUntil: 'networkidle', timeout: 15000 });
  } catch { /* first paint may still be usable */ }
  await page.waitForTimeout(700);
  await shoot(0, null, true);
  // Replay the planned steps (scroll / tap / hold), each narrated by the touch
  // overlay so the video shows WHAT the user is doing — not a silent state jump.
  let stepNo = 0;
  for (const st of uc.steps) {
    stepNo++;
    const note = st.note || (st.target ? (st.do === 'hold' ? 'Giữ: ' + st.target : 'Chạm: ' + st.target) : 'Cuộn');
    if (st.do === 'scroll') {
      // Scroll pass — what a wireframe can't show (fixed header staying put,
      // content scrolling under it); finger swipes as it scrolls.
      await page.evaluate(async (label) => {
        const w = window.innerWidth, h = window.innerHeight;
        if (window.__od) { window.__od.move(w / 2, h * 0.62); window.__od.say(w / 2, h * 0.62, label); }
        await new Promise((r) => setTimeout(r, 350));
        const max = Math.max(0, document.body.scrollHeight - h);
        const stepPx = Math.max(160, Math.floor(h / 2));
        for (let y = 0; y <= max; y += stepPx) {
          window.scrollTo({ top: y });
          if (window.__od) window.__od.move(w / 2, h * (y % (stepPx * 2) ? 0.4 : 0.62));
          await new Promise((r) => setTimeout(r, 200));
        }
        window.scrollTo({ top: 0 });
        if (window.__od) window.__od.hide();
      }, note).catch(() => {});
      await page.waitForTimeout(350);
      await shoot(stepNo, note, true);
      continue;
    }
    // tap / hold — resolve the target flexibly: data-flow-action first, then
    // visible text (button/link/[role]), then aria-label. Robust to screens
    // the agent scripted by visible label without a data-flow-action.
    const want = st.target ?? '';
    const pos = await page.evaluate((wantRaw) => {
      const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
      const w = norm(wantRaw);
      const rectOf = (el) => { el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
      // 1) data-flow-action exact.
      let el = [...document.querySelectorAll('[data-flow-action]')].find((e) => norm(e.getAttribute('data-flow-action') ?? '') === w);
      // 2) aria-label exact.
      if (!el) el = [...document.querySelectorAll('[aria-label]')].find((e) => norm(e.getAttribute('aria-label') ?? '') === w);
      // 3) clickable whose visible text equals, then contains, the target.
      if (!el) {
        const clickable = [...document.querySelectorAll('button,a,[role="button"],[role="menuitem"],[role="tab"],[role="option"],label,summary')];
        el = clickable.find((e) => norm(e.textContent ?? '') === w) || clickable.find((e) => norm(e.textContent ?? '').includes(w) && w.length >= 3);
      }
      if (!el) return null;
      return rectOf(el);
    }, want).catch(() => null);
    if (!pos) {
      if (!failedAt) failedAt = { i: stepNo, label: want };
      await shoot(stepNo, note, false);
      continue;
    }
    await page.evaluate((a) => { if (window.__od) { window.__od.move(a.x, a.y); window.__od.say(a.x, a.y, a.n); } }, { x: pos.x, y: pos.y, n: note });
    await page.waitForTimeout(520);
    await page.evaluate(() => { if (window.__od) window.__od.press(); });
    // A hold visibly presses longer before releasing.
    await page.waitForTimeout(st.do === 'hold' ? 1100 : 150);
    await page.evaluate(() => { if (window.__od) window.__od.release(); });
    // The real activation, resolving the target the same way.
    const clicked = await page.evaluate((wantRaw) => {
      const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
      const w = norm(wantRaw);
      let el = [...document.querySelectorAll('[data-flow-action]')].find((e) => norm(e.getAttribute('data-flow-action') ?? '') === w);
      if (!el) el = [...document.querySelectorAll('[aria-label]')].find((e) => norm(e.getAttribute('aria-label') ?? '') === w);
      if (!el) {
        const clickable = [...document.querySelectorAll('button,a,[role="button"],[role="menuitem"],[role="tab"],[role="option"],label,summary')];
        el = clickable.find((e) => norm(e.textContent ?? '') === w) || clickable.find((e) => norm(e.textContent ?? '').includes(w) && w.length >= 3);
      }
      if (!el) return false;
      el.click();
      return true;
    }, want).catch(() => false);
    await page.waitForTimeout(850);
    await shoot(stepNo, note, clicked);
    await page.evaluate(() => { if (window.__od) window.__od.say(0, 0, ''); });
    if (!clicked && !failedAt) failedAt = { i: stepNo, label: want };
  }
  await page.close();
  await ctx.close();
  // recordVideo drops a random-named .webm in caseOut — give it a stable name.
  const files = await fsp.readdir(caseOut);
  const vid = files.find((f) => f.endsWith('.webm') && f !== 'demo.webm');
  if (vid) await fsp.rename(path.join(caseOut, vid), path.join(caseOut, 'demo.webm')).catch(() => {});
  const interactions = uc.steps.filter((s) => s.do !== 'scroll').length;
  await fsp.writeFile(
    path.join(caseOut, 'steps.json'),
    JSON.stringify({ id: uc.id, title: uc.title, slug: uc.slug, platform: uc.platform, source: uc.source, failedAt, steps }, null, 2),
  );
  index.push({ dir: uc.dir, id: uc.id, slug: uc.slug, title: uc.title, platform: uc.platform, source: uc.source, interactions, ok: !failedAt });
  console.log('[demo] màn "' + uc.slug + '" (' + uc.source + ') — ' + interactions + ' tương tác' + (failedAt ? ' (không thấy "' + failedAt.label + '")' : ''));
}
await browser.close();
srv.close();
await fsp.writeFile(path.join(cfg.outDir, 'index.json'), JSON.stringify(index, null, 2));
console.log('[demo] xong: ' + index.length + ' màn → ' + cfg.outDir);
`;

export interface ReactDemoResult {
  cases: number;
  output: string;
}

/** Generate the Playwright auto-demos for a built react/ dir. Throws with a
 * user-actionable message when the dist / flow.json are missing. */
export async function buildReactDemo(reactDir: string, runtimeDataDir: string): Promise<ReactDemoResult> {
  const distScreens = path.join(reactDir, 'dist', 'screens');
  const flowPath = path.join(reactDir, 'flow.json');
  if (!fs.existsSync(distScreens)) {
    throw new Error('react/dist chưa có — bấm Build app (hoặc `od pipeline build`) trước khi dựng demo.');
  }
  const slugs = (await fs.promises.readdir(distScreens))
    .filter((f) => /\.html?$/i.test(f))
    .map((f) => f.replace(/\.html?$/i, ''));
  // flow.json is OPTIONAL now: it only supplies the per-screen in-screen
  // actions. A screen with none still gets a scroll-through demo.
  let flow: DemoFlowEdge[] = [];
  if (fs.existsSync(flowPath)) {
    const flowRaw = JSON.parse(await fs.promises.readFile(flowPath, 'utf8')) as unknown;
    if (Array.isArray(flowRaw)) {
      flow = (flowRaw as DemoFlowEdge[]).filter((e) => e && typeof e.from === 'string' && typeof e.to === 'string');
    }
  }
  let layouts: Record<string, 'mobile' | 'web'> = {};
  try {
    const raw = JSON.parse(await fs.promises.readFile(path.join(reactDir, 'layout.json'), 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (v === 'mobile' || v === 'web') layouts[k] = v;
      }
    }
  } catch {
    layouts = {};
  }
  const titles = new Map(slugs.map((s) => [s, s.replace(/[-_]+/g, ' ')]));
  // Prefer the AGENT-REASONED scenarios (react/demo.json) — an LLM plan of
  // realistic per-screen interactions, covering screens flow.json never
  // captured. Fall back to the deterministic flow.json derivation when the
  // agent didn't emit one (older projects / skipped step).
  let cases: DemoUseCase[];
  const demoJsonPath = path.join(reactDir, 'demo.json');
  if (fs.existsSync(demoJsonPath)) {
    let demoRaw: unknown = {};
    try {
      demoRaw = JSON.parse(await fs.promises.readFile(demoJsonPath, 'utf8'));
    } catch {
      demoRaw = {};
    }
    cases = parseDemoScenarios(demoRaw, slugs, titles, layouts);
  } else {
    cases = deriveScreenDemos(slugs, titles, flow, layouts);
  }
  if (cases.length === 0) {
    throw new Error('không có screen nào trong react/dist/screens để dựng demo.');
  }

  const runnerDir = path.join(runtimeDataDir, 'react-demo-runner');
  await ensureRunnerEnv(runnerDir);
  await fs.promises.writeFile(path.join(runnerDir, 'run-demo.mjs'), RUN_DEMO_MJS);

  const outDir = path.join(reactDir, 'prototype-demo');
  await fs.promises.rm(outDir, { recursive: true, force: true }).catch(() => null);
  await fs.promises.mkdir(outDir, { recursive: true });
  const configPath = path.join(runnerDir, `config-${Date.now()}.json`);
  await fs.promises.writeFile(
    configPath,
    JSON.stringify({ distDir: path.join(reactDir, 'dist'), outDir, cases }, null, 2),
  );
  try {
    const r = await execBuffered(process.execPath, [path.join(runnerDir, 'run-demo.mjs'), configPath], {
      cwd: runnerDir,
      timeout: 10 * 60_000,
    });
    const tail = [r.stdout, r.stderr].filter(Boolean).join('\n').split('\n').slice(-30).join('\n');
    if (!r.ok) throw new Error(tail || 'playwright demo run failed');
    return { cases: cases.length, output: tail };
  } finally {
    await fs.promises.rm(configPath, { force: true }).catch(() => null);
  }
}
