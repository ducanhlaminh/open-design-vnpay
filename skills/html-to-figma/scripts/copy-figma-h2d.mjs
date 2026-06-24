#!/usr/bin/env node
// copy-figma-h2d — HTML → Figma "HTML to Design" (figh2d) clipboard payload, no plugin/MCP.
//
//   node copy-figma-h2d.mjs <input.html> [<input2.html> ...] [--out-dir <dir>] [--json]
//
// Renders each HTML in headless Chromium (Playwright), injects the clean-room
// @open-design/figma-h2d serializer (dist/figma-h2d.global.js), and captures each to a figh2d
// document. Multiple inputs are combined into ONE payload (the figh2d blob is a document array) —
// paste once → every screen lands in Figma as sibling frames. This is the "copy all màn" path for
// the CLI, and the engine matches the web "Copy to Figma" button. See
// specs/current/h2d-serializer-spec.md.
//
// Output beside the first input (or --out-dir):
//   <name>.figma.html   raw clipboard payload (text/html)
//   <name>.copy.html    one-click "Copy to Figma" page
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(SKILL_DIR, "..", "..");
const H2D_GLOBAL = join(REPO_ROOT, "packages", "figma-h2d", "dist", "figma-h2d.global.js");

function parseArgs(argv) {
  const args = { inputs: [], outDir: null, json: false, width: 430 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--width") args.width = Number(argv[++i]) || 430;
    else if (a && !a.startsWith("-")) args.inputs.push(a);
  }
  return args;
}

// Playwright is an optional peer (same as assets/extract.js). Resolve it from a few likely roots.
async function loadPlaywright() {
  const candidates = [SKILL_DIR, join(SKILL_DIR, "scripts"), REPO_ROOT];
  for (const root of candidates) {
    try {
      const req = createRequire(join(root, "noop.js"));
      const path = req.resolve("playwright");
      return await import(pathToFileURL(path));
    } catch {
      /* keep trying */
    }
  }
  try {
    return await import("playwright");
  } catch {
    throw new Error(
      `Thiếu Playwright. cd ${SKILL_DIR} && npm i playwright && npx playwright install chromium`,
    );
  }
}

// In-page: serialize the artifact root to a figh2d document JSON string (blobs → data URLs).
const IN_PAGE_CAPTURE = `async () => {
  const root = document.body.firstElementChild ?? document.body;
  const doc = await window.figmaH2D.captureElement(root, { skipRemoteAssetSerialization: false });
  return await window.figmaH2D.serializeDocument(doc);
}`;

function base64Utf8(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

// Assemble the clipboard text/html from already-serialized document JSON strings (Node-side, no
// DOM): mirror @open-design/figma-h2d's clipboard wrapper. dataType "h2d", figh2d blob = array.
function assembleClipboard(docJsonStrings, capturedAtIso) {
  const source = "open-design";
  const meta = {
    dataType: "h2d",
    source,
    capturedAtIso,
    h2d: { v: 1, origin: { source, capturedAtIso } },
  };
  const dataB64 = base64Utf8(`[${docJsonStrings.join(",\n")}]`);
  const metaB64 = base64Utf8(JSON.stringify(meta));
  return (
    `<span data-metadata="<!--(figmeta)${metaB64}(/figmeta)-->"></span>` +
    `<span data-h2d="<!--(figh2d)${dataB64}(/figh2d)-->"></span>`
  );
}

function copyPageHTML(payload, name) {
  const b64 = base64Utf8(payload);
  return `<!DOCTYPE html><meta charset="utf-8"><title>Copy to Figma — ${name}</title>
<body style="font:15px/1.5 system-ui;max-width:640px;margin:48px auto;padding:0 16px">
<h1 style="font-size:20px">Copy to Figma — ${name}</h1>
<p>Bấm nút, rồi sang Figma <b>Cmd/Ctrl+V</b>. Ra node editable, không cần plugin.</p>
<button onclick="cp()" style="font:600 16px system-ui;padding:14px 28px;border:0;border-radius:10px;background:#0d99ff;color:#fff;cursor:pointer">⧉ Copy to Figma</button>
<div id="s" style="margin-top:16px;font-family:monospace;color:#0c7a35"></div>
<script>const p=atob("${b64}");async function cp(){try{await navigator.clipboard.write([new ClipboardItem({"text/html":new Blob([p],{type:"text/html"})})]);s.textContent="\\u2713 copied "+p.length+" bytes";}catch(e){s.textContent="\\u2717 "+e.message}}</script>`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.inputs.length === 0) {
    console.error("Usage: node copy-figma-h2d.mjs <input.html> [<input2.html> ...] [--out-dir <dir>] [--width <px>] [--json]");
    process.exit(1);
  }
  if (!existsSync(H2D_GLOBAL)) {
    throw new Error(`Không tìm thấy ${H2D_GLOBAL}. Chạy: pnpm --filter @open-design/figma-h2d build`);
  }
  const inputs = args.inputs.map((p) => resolve(p));
  for (const input of inputs) {
    if (!existsSync(input)) throw new Error(`Không thấy file: ${input}`);
  }

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const docJsonStrings = [];
  try {
    const context = await browser.newContext({
      viewport: { width: Math.max(320, Math.round(args.width)), height: 2000 },
      deviceScaleFactor: 1,
    });
    for (const input of inputs) {
      const page = await context.newPage();
      try {
        await page.setContent(readFileSync(input, "utf8"), { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts?.ready).catch(() => {});
        await page.addScriptTag({ path: H2D_GLOBAL });
        const json = await page.evaluate(IN_PAGE_CAPTURE);
        if (typeof json === "string" && json.trim()) docJsonStrings.push(json);
      } catch (err) {
        console.error(`[copy-figma-h2d] bỏ qua ${basename(input)}: ${err?.message ?? err}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  if (docJsonStrings.length === 0) throw new Error("Không trích xuất được màn nào");

  // Deterministic timestamp is fine here; the CLI runs ad hoc (web uses Date.now()).
  const capturedAtIso = new Date().toISOString();
  const payload = assembleClipboard(docJsonStrings, capturedAtIso);

  const outDir = args.outDir ? resolve(args.outDir) : dirname(inputs[0]);
  mkdirSync(outDir, { recursive: true });
  const name = basename(inputs[0], extname(inputs[0])) + (inputs.length > 1 ? `+${inputs.length - 1}` : "");
  const payloadPath = join(outDir, `${name}.figma.html`);
  const copyPath = join(outDir, `${name}.copy.html`);
  writeFileSync(payloadPath, payload);
  writeFileSync(copyPath, copyPageHTML(payload, name));

  if (args.json) {
    process.stdout.write(
      JSON.stringify({ payloadPath, copyPath, bytes: payload.length, screens: docJsonStrings.length }) + "\n",
    );
  } else {
    console.log(`✓ ${docJsonStrings.length} màn → ${payloadPath}`);
    console.log(`  mở ${copyPath} rồi bấm "Copy to Figma" (hoặc cat ${payloadPath} vào clipboard).`);
  }
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
