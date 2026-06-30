#!/usr/bin/env node
// copy-figma-h2d — HTML → Figma "HTML to Design" (figh2d) clipboard payload, no plugin/MCP.
//
//   node copy-figma-h2d.mjs <input.html> [<input2.html> ...] [--out-dir <dir>] [--json]
//
// SIZING & TIMING:
//   --width <px>   per-screen viewport width (default 430, iPhone-class).
//   --height <px>  per-screen viewport height (default 932). A `min-height:100vh`
//                  screen resolves to this; taller content still grows the frame.
//   --settle <ms>  pause before each capture (default 500) so CSS entry/transition
//                  animations finish — without it the frame is grabbed at page-load
//                  (pre-animation). The CLI also awaits in-flight animations' end
//                  (capped) so finite reveals land in their final state. The JS
//                  demo-player stays frozen regardless (see __H2D_CAPTURE below).
//
// Renders each HTML in headless Chromium (Playwright), injects the clean-room
// @open-design/figma-h2d serializer (dist/figma-h2d.global.js), and captures each to a figh2d
// document. Multiple inputs are combined into ONE payload (the figh2d blob is a document array) —
// paste once → every screen lands in Figma as sibling frames. This is the "copy all màn" path for
// the CLI, and the engine matches the web "Copy to Figma" button. See
// specs/current/h2d-serializer-spec.md.
//
// MULTI-STATE (multistep / show-hide screens): if a `<input-basename>.states.json` recipe sits
// beside an input (or is passed via --states), the page is driven through EACH listed state and a
// frame is captured per state — so one multistep HTML file copies as N frames (every step). The
// recipe is `[{ label, actions }]`; actions run in order, CUMULATIVELY, on a single render:
//   { "click": "[data-action='next']" }   click an element (CSS; use single quotes inside)
//   { "wait": 250 }                         pause N ms (let a transition settle)
//   { "set": { "selector": ".screen", "attr": "data-state", "value": "step-2" } }  set an attribute
// The first state is usually the initial load with empty `actions`. The CLI freezes the page's own
// auto-advance during capture by setting `window.__H2D_CAPTURE = true` before the page scripts run,
// so a looping demo-player can't shift the state mid-capture (the generated HTML must gate its
// auto-advance on `!window.__H2D_CAPTURE`).
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
  const args = { inputs: [], outDir: null, json: false, width: 430, height: 932, settle: 500, states: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--width") args.width = Number(argv[++i]) || 430;
    else if (a === "--height") args.height = Number(argv[++i]) || 932;
    else if (a === "--settle") args.settle = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--states") args.states = argv[++i];
    else if (a && !a.startsWith("-")) args.inputs.push(a);
  }
  return args;
}

// Max time (ms) to wait for in-flight CSS/WAAPI animations to finish before a
// capture. Finite reveal/transition animations resolve before this; an infinite
// looping animation (e.g. a scanning spinner) never finishes, so the cap stops
// the wait and we capture whatever frame is current.
const ANIM_SETTLE_MAX_MS = 2000;

// Measure the artifact root's content height (real fn — `page.evaluate(string)`
// would eval the source as an expression and return the function itself, not its
// result; see the captureFrame note). A `position:sticky;bottom:0` bottom nav is
// what makes this matter: if the screen content overflows the capture viewport, the
// nav pins to the VIEWPORT edge while the captured frame spans the full (taller)
// box — leaving a gap below the nav in Figma.
const measureRootHeight = (page) =>
  page
    .evaluate(() =>
      Math.ceil((document.body.firstElementChild ?? document.body).getBoundingClientRect().height),
    )
    .catch(() => 0);

// Resize the viewport to the screen's content height ("hug") so it never overflows
// — then a sticky/fixed bottom nav sits at its natural flow position (flush with
// the frame bottom) instead of pinned to a too-short viewport. We reset to the base
// mobile viewport first (a prior multistep state's taller hug must not inflate this
// one via `min-height:100vh`) and iterate because resizing changes `100vh`, which
// can re-grow the screen.
async function hugViewport(page, baseW, baseH) {
  const vp = page.viewportSize();
  if (vp && (vp.width !== baseW || vp.height !== baseH)) {
    await page.setViewportSize({ width: baseW, height: baseH }).catch(() => {});
    await page.waitForTimeout(40);
  }
  for (let i = 0; i < 3; i++) {
    const rootH = await measureRootHeight(page);
    const cur = page.viewportSize();
    if (!rootH || !cur || Math.abs(rootH - cur.height) <= 1) break;
    await page.setViewportSize({ width: cur.width, height: rootH }).catch(() => {});
    await page.waitForTimeout(60); // let layout reflow against the new height
  }
}

// Let entry/transition animations finish before capturing. The JS demo-player
// stays frozen (window.__H2D_CAPTURE === true, set at init) so it never shifts
// state — this only waits out CSS @keyframes / transitions, which are NOT gated
// on that flag. Order: a fixed `settleMs` pause (covers JS-timed reveals and lets
// a just-applied state's transition kick off), then HUG the viewport to content
// height (sticky bottom nav flush), then await every running animation's `.finished`,
// bounded by ANIM_SETTLE_MAX_MS so an infinite loop can't hang the run.
async function settleBeforeCapture(page, settleMs, baseW, baseH) {
  if (settleMs > 0) await page.waitForTimeout(settleMs);
  await hugViewport(page, baseW, baseH);
  await page
    .evaluate(async (maxMs) => {
      const running = (document.getAnimations ? document.getAnimations() : []).filter(
        (a) => a.playState === "running",
      );
      if (running.length) {
        await Promise.race([
          Promise.all(running.map((a) => a.finished.catch(() => {}))),
          new Promise((r) => setTimeout(r, maxMs)),
        ]);
      }
      await (document.fonts ? document.fonts.ready : Promise.resolve());
    }, ANIM_SETTLE_MAX_MS)
    .catch(() => {});
}

// Multi-state recipe driving N captures of ONE multistep HTML. Looks for an
// explicit --states file, else `<input-basename>.states.json` beside the input.
// Returns an array of { label, actions } or null when there's no recipe.
function loadStatesRecipe(input, explicit) {
  const candidate = explicit
    ? resolve(explicit)
    : join(dirname(input), basename(input, extname(input)) + ".states.json");
  if (!existsSync(candidate)) return null;
  try {
    const recipe = JSON.parse(readFileSync(candidate, "utf8"));
    if (Array.isArray(recipe) && recipe.length > 0) return recipe;
    console.error(`[copy-figma-h2d] states recipe rỗng/không phải mảng: ${basename(candidate)}`);
  } catch (err) {
    console.error(`[copy-figma-h2d] states recipe lỗi parse (${basename(candidate)}): ${err?.message ?? err}`);
  }
  return null;
}

// Apply one recipe action to the live page. Unknown actions are ignored. A
// failing action is logged but does not abort the run (capture best-effort).
async function applyAction(page, action) {
  if (!action || typeof action !== "object") return;
  try {
    if (typeof action.click === "string") {
      await page.click(action.click, { timeout: 5000 });
    } else if (typeof action.wait === "number") {
      await page.waitForTimeout(Math.max(0, action.wait));
    } else if (action.set && typeof action.set === "object" && action.set.selector) {
      const { selector, attr = "data-state", value = "" } = action.set;
      await page.$eval(
        selector,
        (el, payload) => el.setAttribute(payload.attr, payload.value),
        { attr, value },
      );
    }
  } catch (err) {
    console.error(`[copy-figma-h2d]   action ${JSON.stringify(action)} lỗi: ${err?.message ?? err}`);
  }
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

// page.evaluate(string) evaluates the string as an EXPRESSION — a bare
// `async () => {…}` resolves to the (non-serializable) function, not its result.
// Wrap it as an IIFE so the capture actually runs and returns the JSON string.
const captureFrame = (page) => page.evaluate(`(${IN_PAGE_CAPTURE})()`);

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
    console.error("Usage: node copy-figma-h2d.mjs <input.html> [<input2.html> ...] [--out-dir <dir>] [--width <px>] [--height <px>] [--settle <ms>] [--states <recipe.json>] [--json]");
    process.exit(1);
  }
  if (!existsSync(H2D_GLOBAL)) {
    throw new Error(`Không tìm thấy ${H2D_GLOBAL}. Chạy: pnpm --filter @open-design/figma-h2d build`);
  }
  const inputs = args.inputs.map((p) => resolve(p));
  for (const input of inputs) {
    if (!existsSync(input)) throw new Error(`Không thấy file: ${input}`);
  }

  const pw = await loadPlaywright();
  // CJS→ESM interop: some resolutions surface exports under `.default`.
  const chromium = pw.chromium ?? pw.default?.chromium;
  if (!chromium) throw new Error("Playwright: không tìm thấy export 'chromium'");
  const browser = await chromium.launch();
  const docJsonStrings = [];
  // Mobile-sized base viewport: a screen with `min-height:100vh` resolves to this
  // height (default 932 ≈ iPhone @430w) instead of the old hardcoded 2000px that
  // left every frame far too tall. Each capture then hugs the viewport to the
  // screen's content height (settleBeforeCapture → hugViewport). Tune with --height.
  const baseW = Math.max(320, Math.round(args.width));
  const baseH = Math.max(480, Math.round(args.height));
  try {
    const context = await browser.newContext({
      viewport: { width: baseW, height: baseH },
      deviceScaleFactor: 1,
    });
    for (const input of inputs) {
      const page = await context.newPage();
      try {
        // Freeze the page's own auto-advance so the recipe — not a looping demo
        // player — controls which state is captured. addInitScript alone is NOT
        // enough: it does not reliably run for page.setContent(), so a player that
        // toggles state on a timer would still fire and (now that we wait for
        // animations to settle, > its interval) shift the frame. Belt-and-braces:
        // keep the init hook AND re-assert the flags right after setContent so any
        // already-scheduled interval is killed on its next tick before it toggles.
        await page.addInitScript(() => {
          window.__H2D_CAPTURE = true;
          window.__stop = true;
        });
        await page.setContent(readFileSync(input, "utf8"), { waitUntil: "networkidle" });
        await page
          .evaluate(() => {
            window.__H2D_CAPTURE = true;
            window.__stop = true;
          })
          .catch(() => {});
        await page.evaluate(() => document.fonts?.ready).catch(() => {});
        await page.addScriptTag({ path: H2D_GLOBAL });

        const recipe = loadStatesRecipe(input, inputs.length === 1 ? args.states : null);
        if (recipe) {
          // Multistep: drive each state (actions are cumulative on this one render)
          // and capture ONE frame per state.
          let n = 0;
          for (const state of recipe) {
            const actions = Array.isArray(state?.actions) ? state.actions : [];
            for (const action of actions) await applyAction(page, action);
            await settleBeforeCapture(page, args.settle, baseW, baseH);
            const json = await captureFrame(page);
            if (typeof json === "string" && json.trim()) {
              docJsonStrings.push(json);
              n += 1;
              console.error(`[copy-figma-h2d]   ${basename(input)} · state "${state?.label ?? n}" ✓`);
            }
          }
        } else {
          await settleBeforeCapture(page, args.settle, baseW, baseH);
          const json = await captureFrame(page);
          if (typeof json === "string" && json.trim()) docJsonStrings.push(json);
        }
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
