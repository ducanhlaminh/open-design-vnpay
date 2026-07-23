// Render every page of a multi-page draw.io diagram to PNG.
//
// Confluence stores a server-rendered preview PNG only for a diagram's FIRST
// page, so a multi-page diagram (each page = a "slide") loses pages 2..N when we
// localize its single preview. To recover them we render the diagram ourselves:
// split the `.drawio` mxfile into one single-page mxfile per `<diagram>`, load
// draw.io's static viewer in headless Chromium, and screenshot each page.
//
// Chromium is provisioned exactly like react-demo.ts — playwright pinned into an
// isolated runner dir outside the pnpm workspace, chromium fetched into the
// shared user cache on first use (a no-op afterwards). Fully local: only the
// viewer JS is fetched from the CDN; the diagram data never leaves this machine.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const PLAYWRIGHT_VERSION = '1.54.2';
const VIEWER_URL = 'https://viewer.diagrams.net/js/viewer-static.min.js';

const IS_WINDOWS = process.platform === 'win32';

function execBuffered(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; shell?: boolean },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeout ?? 120_000,
        maxBuffer: 16 * 1024 * 1024,
        // ELECTRON_RUN_AS_NODE: in the packaged app `process.execPath` is the
        // Electron binary, so a child that must behave like `node` needs this.
        // The packaged sidecar already sets it, but a spawn must not DEPEND on
        // inheriting it.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        shell: opts.shell === true,
      },
      (err, stdout, stderr) => resolve({
        ok: !err,
        stdout: String(stdout),
        // execFile's error (ENOENT / EINVAL) never reaches stderr — without it
        // a missing `npm` on Windows surfaced as an empty "failed" message.
        stderr: `${String(stderr)}${err ? `\n${err.message}` : ''}`,
      }),
    );
  });
}

/** Run a Node script with whatever runtime this daemon is (node, or Electron in
 *  node mode). Never goes through a `.bin` shim — those are `.cmd` files on
 *  Windows, which `execFile` cannot launch (Node ≥18.20 rejects .bat/.cmd
 *  without a shell). */
function execNodeScript(script: string, args: string[], opts: { cwd?: string; timeout?: number }) {
  return execBuffered(process.execPath, [script, ...args], opts);
}

let ensured: Promise<string> | null = null;
/** Provision (once) the playwright runner + chromium; returns the runner dir. */
function ensureRunner(runtimeDataDir: string): Promise<string> {
  if (ensured) return ensured;
  ensured = (async () => {
    const runnerDir = path.join(runtimeDataDir, 'drawio-render-runner');
    await fs.promises.mkdir(runnerDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(runnerDir, 'package.json'),
      JSON.stringify({ name: 'od-drawio-render-runner', private: true, dependencies: { playwright: PLAYWRIGHT_VERSION } }, null, 2),
    );
    if (!fs.existsSync(path.join(runnerDir, 'node_modules', 'playwright', 'package.json'))) {
      // `npm` is `npm.cmd` on Windows — execFile cannot launch it directly, so
      // the command must go through a shell there (the shell also resolves the
      // PATHEXT extension). No argument contains a space, so shell quoting is
      // not a concern; `cwd` is applied by the process API, not the shell.
      const r = await execBuffered('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
        cwd: runnerDir,
        timeout: 5 * 60_000,
        shell: IS_WINDOWS,
      });
      if (!r.ok) {
        const tail = (r.stderr || r.stdout).split('\n').slice(-6).join('\n');
        const hint = /ENOENT|not recognized|not found/i.test(tail)
          ? '\n\nKhông tìm thấy `npm`. Máy này cần cài Node.js (kèm npm) thì bước render PDF/draw.io mới provision được Chromium.'
          : '';
        throw new Error(`npm install playwright failed:\n${tail}${hint}`);
      }
    }
    // playwright's own CLI entry, NOT `node_modules/.bin/playwright` — that shim
    // is `playwright.cmd` on Windows and execFile refuses `.cmd`.
    const pwCli = path.join(runnerDir, 'node_modules', 'playwright', 'cli.js');
    const r2 = await execNodeScript(pwCli, ['install', 'chromium'], { cwd: runnerDir, timeout: 10 * 60_000 });
    if (!r2.ok) throw new Error(`playwright install chromium failed:\n${(r2.stderr || r2.stdout).split('\n').slice(-6).join('\n')}`);
    return runnerDir;
  })().catch((err) => {
    ensured = null; // let a later call retry after a transient failure
    throw err;
  });
  return ensured;
}

/** Split a draw.io mxfile into one single-page mxfile per `<diagram>` element,
 *  preserving each diagram's attributes/content (compressed or plain). */
export function splitMxfilePages(xml: string): string[] {
  const header = /<mxfile\b[^>]*>/i.exec(xml);
  const open = header ? header[0] : '<mxfile>';
  const pages: string[] = [];
  for (const m of xml.matchAll(/<diagram\b[^>]*>[\s\S]*?<\/diagram>/gi)) {
    pages.push(`${open}${m[0]}</mxfile>`);
  }
  // Self-closing <diagram .../> (rare) or a single un-tagged model.
  if (pages.length === 0) pages.push(xml);
  return pages;
}

const RUNNER_MJS = String.raw`// GENERATED by open-design (drawio-render.ts) — do not edit.
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const cfg = JSON.parse(await fsp.readFile(process.argv[2], 'utf8'));
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.setContent(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;background:#fff}.mxgraph{display:inline-block;background:#fff;padding:8px}</style></head>' +
      '<body><script src="' + cfg.viewerUrl + '"></' + 'script></body></html>',
    { waitUntil: 'load', timeout: 60000 },
  );
  await page.waitForFunction(() => !!window.GraphViewer, null, { timeout: 30000 });
  // Build one .mxgraph div per page, then let the viewer render them all.
  await page.evaluate((mxfiles) => {
    for (let i = 0; i < mxfiles.length; i++) {
      const d = document.createElement('div');
      d.className = 'mxgraph';
      d.id = 'g' + i;
      d.setAttribute('data-mxgraph', JSON.stringify({ xml: mxfiles[i], toolbar: null, lightbox: false, nav: false, resize: true, border: 8 }));
      document.body.appendChild(d);
    }
    window.GraphViewer.processElements();
  }, cfg.mxfiles);
  await page
    .waitForFunction((n) => document.querySelectorAll('.mxgraph svg').length >= n, cfg.mxfiles.length, { timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(400);
  const out = [];
  for (let i = 0; i < cfg.outPaths.length; i++) {
    const el = await page.$('#g' + i);
    if (!el) { out.push(false); continue; }
    try { await el.screenshot({ path: cfg.outPaths[i] }); out.push(true); }
    catch { out.push(false); }
  }
  await fsp.writeFile(cfg.resultPath, JSON.stringify(out));
} finally {
  await browser.close();
}
`;

/** Render each page of a draw.io mxfile to a PNG at the matching outPath.
 *  Returns the subset of outPaths that were written. Best-effort — throws only
 *  if Chromium can't be provisioned; per-page failures are skipped. */
export async function renderDrawioPages(
  xml: string,
  outPaths: string[],
  runtimeDataDir: string,
): Promise<string[]> {
  const mxfiles = splitMxfilePages(xml);
  if (mxfiles.length !== outPaths.length) {
    // Caller sized outPaths to the page count; guard against a mismatch.
    const n = Math.min(mxfiles.length, outPaths.length);
    mxfiles.length = n;
    outPaths = outPaths.slice(0, n);
  }
  const runnerDir = await ensureRunner(runtimeDataDir);
  const runnerMjs = path.join(runnerDir, 'render-drawio.mjs');
  await fs.promises.writeFile(runnerMjs, RUNNER_MJS);
  const cfgPath = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'od-drawio-')), 'cfg.json');
  const resultPath = `${cfgPath}.result.json`;
  await fs.promises.writeFile(
    cfgPath,
    JSON.stringify({ viewerUrl: VIEWER_URL, mxfiles, outPaths, resultPath }),
  );
  const r = await execNodeScript(runnerMjs, [cfgPath], { cwd: runnerDir, timeout: 4 * 60_000 });
  if (!r.ok) throw new Error(`drawio render runner failed:\n${(r.stderr || r.stdout).split('\n').slice(-8).join('\n')}`);
  let flags: boolean[] = [];
  try {
    flags = JSON.parse(await fs.promises.readFile(resultPath, 'utf8')) as boolean[];
  } catch {
    flags = outPaths.map(() => false);
  }
  return outPaths.filter((_, i) => flags[i]);
}

const PDF_RUNNER_MJS = String.raw`// GENERATED by open-design (drawio-render.ts) — do not edit.
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const cfg = JSON.parse(await fsp.readFile(process.argv[2], 'utf8'));
const html = await fsp.readFile(cfg.htmlPath, 'utf8');
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: cfg.outPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
  });
} finally {
  await browser.close();
}
`;

/** Render a full HTML document to a PDF buffer via headless Chromium. The HTML
 *  must be self-contained (inline CSS + data-URI images) — setContent loads no
 *  network. Reuses the same chromium runner as the diagram renderer. */
export async function renderHtmlToPdf(html: string, runtimeDataDir: string): Promise<Buffer> {
  const runnerDir = await ensureRunner(runtimeDataDir);
  const runnerMjs = path.join(runnerDir, 'render-pdf.mjs');
  await fs.promises.writeFile(runnerMjs, PDF_RUNNER_MJS);
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'od-pdf-'));
  const htmlPath = path.join(tmp, 'doc.html');
  const outPath = path.join(tmp, 'out.pdf');
  await fs.promises.writeFile(htmlPath, html, 'utf8');
  await fs.promises.writeFile(path.join(tmp, 'cfg.json'), JSON.stringify({ htmlPath, outPath }));
  const r = await execNodeScript(runnerMjs, [path.join(tmp, 'cfg.json')], { cwd: runnerDir, timeout: 4 * 60_000 });
  if (!r.ok) throw new Error(`pdf render runner failed:\n${(r.stderr || r.stdout).split('\n').slice(-8).join('\n')}`);
  return fs.promises.readFile(outPath);
}
