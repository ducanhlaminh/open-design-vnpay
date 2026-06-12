#!/usr/bin/env node
// copy-figma — HTML (Contract-clean) → Figma clipboard payload, no plugin/MCP.
//
//   node copy-figma.mjs <input.html> [--selector "<css>"] [--out-dir <dir>] [--json]
//
// Pipeline: assets/extract.js (Playwright → IR) → @open-design/figma-clip (irToClip) →
//   <name>.figma.html  (raw clipboard payload — `cat` into a file, or serve + copy)
//   <name>.copy.html   (a one-click "Copy to Figma" page you open in a browser)
//
// Only run this on html-prototype output (Contract-clean). react-shadcn artifacts are NOT
// supported here (grid/sticky/multi-font/portal); see references/contract.md.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(SKILL_DIR, "..", "..");

function parseArgs(argv) {
  const args = { input: null, selector: null, outDir: null, json: false, irOnly: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selector") args.selector = argv[++i];
    else if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--ir-only") args.irOnly = true;
    else if (!args.input) args.input = a;
  }
  return args;
}

// Resolve @open-design/figma-clip without requiring the skill to be a workspace member:
// prefer a normal module resolution, fall back to the in-repo dist by path.
async function loadFigmaClip() {
  try {
    return await import("@open-design/figma-clip");
  } catch {
    const dist = join(REPO_ROOT, "packages", "figma-clip", "dist", "index.mjs");
    if (!existsSync(dist)) {
      throw new Error(
        `Không tìm thấy @open-design/figma-clip. Chạy: pnpm --filter @open-design/figma-clip build`,
      );
    }
    return import(pathToFileURL(dist));
  }
}

function pathToFileURL(p) {
  return new URL(`file://${resolve(p)}`);
}

// extract.js does `require("playwright")`. Make it resolvable from a few likely roots without
// hardcoding an absolute path (per spec). Returns a NODE_PATH string or null.
function resolvePlaywrightNodePath() {
  const candidates = [
    SKILL_DIR,
    join(SKILL_DIR, "scripts"),
    REPO_ROOT,
    join(REPO_ROOT, "node_modules", ".pnpm"),
  ];
  for (const root of candidates) {
    try {
      const req = createRequire(join(root, "noop.js"));
      req.resolve("playwright");
      return join(root, "node_modules");
    } catch {
      /* keep trying */
    }
  }
  return null;
}

function runExtractor(input, selector) {
  const extract = join(SKILL_DIR, "assets", "extract.cjs");
  if (!existsSync(extract)) throw new Error(`Thiếu extractor: ${extract}`);
  const nodePath = resolvePlaywrightNodePath();
  const env = { ...process.env };
  if (nodePath) env.NODE_PATH = nodePath + (env.NODE_PATH ? `:${env.NODE_PATH}` : "");
  const cliArgs = [extract, input];
  if (selector) cliArgs.push("--selector", selector);
  const res = spawnSync(process.execPath, cliArgs, { env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) {
    throw new Error(
      `extract.js thoát mã ${res.status}. Nếu thiếu Playwright: cd ${SKILL_DIR} && npm i playwright && npx playwright install chromium`,
    );
  }
  return JSON.parse(res.stdout);
}

function copyPageHTML(payload, name) {
  const b64 = Buffer.from(payload, "utf8").toString("base64");
  return `<!DOCTYPE html><meta charset="utf-8"><title>Copy to Figma — ${name}</title>
<body style="font:15px/1.5 system-ui;max-width:640px;margin:48px auto;padding:0 16px">
<h1 style="font-size:20px">Copy to Figma — ${name}</h1>
<p>Bấm nút, rồi sang Figma <b>Cmd/Ctrl+V</b>. Ra node Auto Layout editable, không cần plugin.</p>
<button onclick="cp()" style="font:600 16px system-ui;padding:14px 28px;border:0;border-radius:10px;background:#0d99ff;color:#fff;cursor:pointer">⧉ Copy to Figma</button>
<div id="s" style="margin-top:16px;font-family:monospace;color:#0c7a35"></div>
<script>const p=atob("${b64}");async function cp(){try{await navigator.clipboard.write([new ClipboardItem({"text/html":new Blob([p],{type:"text/html"})})]);s.textContent="\\u2713 copied "+p.length+" bytes";}catch(e){s.textContent="\\u2717 "+e.message}}</script>`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.input) {
    console.error("Usage: node copy-figma.mjs <input.html> [--selector <css>] [--out-dir <dir>] [--json]");
    process.exit(1);
  }
  const input = resolve(args.input);
  if (!existsSync(input)) throw new Error(`Không thấy file: ${input}`);

  // --ir-only: extract HTML→IR and print the IR JSON (the `od` CLI pipes this to the daemon's
  // /api/artifacts/figma-clipboard so the daemon owns the IR→.fig transform — see AGENTS.md).
  if (args.irOnly) {
    const ir = runExtractor(input, args.selector);
    process.stdout.write(JSON.stringify(ir) + "\n");
    return;
  }

  const { irToClip } = await loadFigmaClip();
  const ir = runExtractor(input, args.selector);
  const { html, warnings } = irToClip(ir);

  const outDir = args.outDir ? resolve(args.outDir) : dirname(input);
  mkdirSync(outDir, { recursive: true });
  const name = basename(input, extname(input));
  const payloadPath = join(outDir, `${name}.figma.html`);
  const copyPath = join(outDir, `${name}.copy.html`);
  writeFileSync(payloadPath, html);
  writeFileSync(copyPath, copyPageHTML(html, name));

  if (args.json) {
    process.stdout.write(JSON.stringify({ payloadPath, copyPath, bytes: html.length, warnings }) + "\n");
  } else {
    console.error(`✓ payload: ${payloadPath} (${html.length} bytes)`);
    console.error(`✓ paste page: ${copyPath} — mở trong browser, bấm "Copy to Figma"`);
    if (warnings.length) {
      console.error(`⚠️  ${warnings.length} cảnh báo:`);
      for (const w of warnings) console.error("   - " + w);
    }
  }
}

main().catch((e) => {
  console.error("✗ " + (e?.message ?? e));
  process.exit(1);
});
