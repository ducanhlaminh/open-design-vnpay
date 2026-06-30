// In-browser HTML → Figma "HTML to Design" (figh2d) clipboard payload for the web "Copy to
// Figma" buttons. Renders each artifact HTML string into a throwaway offscreen same-origin
// iframe (the live preview iframe is cross-origin/unreadable), then runs the clean-room
// @open-design/figma-h2d serializer against that real DOM and assembles the clipboard text/html.
//
// Unlike the older IR→.fig path (extractIRFromHTML + /api/artifacts/figma-clipboard), this is
// fully client-side: Figma builds the nodes from the figh2d JSON on paste, so there is no daemon
// round-trip. See specs/current/h2d-serializer-spec.md.

import { captureElement, toFigmaClipboardHtml, type H2DDocument } from "@open-design/figma-h2d";

const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

// Offscreen same-origin iframe sized to a real preview viewport. A fixed oversized height (e.g.
// 5000px) would inflate `100vh`/`%` layouts and the captured frame comes out absurdly tall instead
// of hugging its content, so we start at the preview height and `settleAndHug` shrinks/grows to fit.
function makeArtifactIframe(width: number, height: number): HTMLIFrameElement {
  const w = Math.max(320, Math.round(width));
  const h0 = Math.max(200, Math.round(height) || 812);
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText =
    `position:fixed;left:-100000px;top:0;width:${w}px;height:${h0}px;` +
    "border:0;visibility:hidden;pointer-events:none;";
  return frame;
}

async function loadSrcdoc(frame: HTMLIFrameElement, html: string): Promise<Document> {
  await new Promise<void>((res) => {
    frame.onload = () => res();
    frame.srcdoc = html;
  });
  const doc = frame.contentDocument;
  if (!doc) throw new Error("Không tạo được iframe trích xuất");
  return doc;
}

// Wait for fonts + a layout tick, then size the iframe to the artifact root's rendered height so
// vh/% recompute against that height (short content shrinks, tall/scrolling content grows). Called
// after the initial load AND after each multistep state's DOM changes.
async function settleAndHug(frame: HTMLIFrameElement, doc: Document): Promise<void> {
  try {
    await (doc.fonts?.ready ?? Promise.resolve());
  } catch {
    /* fonts best-effort */
  }
  await new Promise((r) => setTimeout(r, 180));
  const root = doc.body.firstElementChild ?? doc.body;
  const rootH = Math.ceil(root.getBoundingClientRect().height);
  const curH = Math.round(parseFloat(frame.style.height) || 0);
  if (rootH > 0 && Math.abs(rootH - curH) > 1) {
    frame.style.height = `${rootH}px`;
    await raf();
    await raf();
  }
}

async function withArtifactIframe<T>(
  html: string,
  width: number,
  height: number,
  fn: (root: Element) => Promise<T>,
): Promise<T> {
  const frame = makeArtifactIframe(width, height);
  document.body.appendChild(frame);
  try {
    const doc = await loadSrcdoc(frame, html);
    await settleAndHug(frame, doc);
    return await fn(doc.body.firstElementChild ?? doc.body);
  } finally {
    frame.remove();
  }
}

async function captureHtml(html: string, width: number, height: number): Promise<H2DDocument> {
  return withArtifactIframe(html, width, height, (root) =>
    captureElement(root, { skipRemoteAssetSerialization: false }),
  );
}

/** One artifact → a paste-ready Figma clipboard text/html payload. */
export async function htmlToFigmaClipboard(html: string, width = 430, height = 812): Promise<string> {
  if (typeof html !== "string" || !html.trim()) {
    throw new Error("Không có nội dung artifact để trích xuất");
  }
  const doc = await captureHtml(html, width, height);
  const { html: payload } = await toFigmaClipboardHtml([doc], { source: "open-design" });
  return payload;
}

/**
 * Capture an ALREADY-rendered element (e.g. the live preview iframe's body) directly into a
 * Figma clipboard payload. Unlike htmlToFigmaClipboard (which re-renders from the source HTML and
 * thus resets to the script's default state), this preserves runtime state — the active step/tab
 * the artifact's own JS has switched to. Only usable when the element is readable (same-origin
 * iframe); callers fall back to htmlToFigmaClipboard for cross-origin/opaque previews.
 */
export async function elementToFigmaClipboard(root: Element): Promise<string> {
  if (!root) throw new Error("Không có phần tử để trích xuất");
  const doc = await captureElement(root, { skipRemoteAssetSerialization: false });
  const { html: payload } = await toFigmaClipboardHtml([doc], { source: "open-design" });
  return payload;
}

export interface ScreenHtml {
  html: string;
  /** Optional preview width per screen (defaults to `width`). */
  width?: number;
  /** Optional preview viewport height per screen (defaults to `height`). */
  height?: number;
}

/**
 * Many screens → one combined payload. Pasting once drops every screen into Figma as sibling
 * frames (the figh2d blob is an array of documents). Screens are captured sequentially so each
 * gets a clean offscreen layout; a screen that fails to capture is skipped (with a console warn)
 * rather than failing the whole batch.
 */
export async function htmlsToFigmaClipboard(
  screens: ScreenHtml[],
  width = 430,
  height = 812,
): Promise<string> {
  const usable = screens.filter((s) => typeof s.html === "string" && s.html.trim());
  if (usable.length === 0) throw new Error("Không có màn nào để trích xuất");
  const docs: H2DDocument[] = [];
  for (const screen of usable) {
    try {
      docs.push(await captureHtml(screen.html, screen.width ?? width, screen.height ?? height));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[Copy all to Figma] bỏ qua một màn:", err);
    }
  }
  if (docs.length === 0) throw new Error("Không trích xuất được màn nào");
  const { html: payload } = await toFigmaClipboardHtml(docs, { source: "open-design" });
  return payload;
}

// ── Multistep "copy all" (parity with the CLI scripts/copy-figma-h2d.mjs) ──────────────────────
// A prototype screen can ship a `<stem>.states.json` recipe: drive the page through each listed
// state and capture ONE frame per state (scanning → success → error, etc.). Actions run in order,
// CUMULATIVELY, on a single render — the same contract as the CLI.

export interface H2DAction {
  /** Click the first element matching this CSS selector. */
  click?: string;
  /** Pause N ms (let a transition settle). */
  wait?: number;
  /** Set an attribute (default `data-state`) on the first element matching `selector`. */
  set?: { selector: string; attr?: string; value?: string };
}

export interface H2DRecipeState {
  label?: string;
  actions?: H2DAction[];
}

export interface ScreenSpec {
  html: string;
  /** Optional preview width (defaults to the call's `width`). */
  width?: number;
  /** Optional preview viewport height (defaults to the call's `height`). */
  height?: number;
  /** Optional multistep recipe (parsed `.states.json`); one frame captured per state. */
  states?: H2DRecipeState[] | null;
}

// Run before the page's own scripts so a looping demo-player (`if(!window.__H2D_CAPTURE){…}`) never
// starts — the recipe (or the page's initial markup) decides what each frame shows. Mirrors the
// CLI's addInitScript freeze.
function injectFreeze(html: string): string {
  const flag = "<script>window.__H2D_CAPTURE=true;window.__stop=true;</script>";
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + flag);
  return flag + html;
}

async function applyAction(doc: Document, action: H2DAction): Promise<void> {
  try {
    if (typeof action.click === "string") {
      (doc.querySelector(action.click) as HTMLElement | null)?.click();
    } else if (typeof action.wait === "number") {
      const ms = Math.max(0, action.wait);
      await new Promise((r) => setTimeout(r, ms));
    } else if (action.set && typeof action.set === "object" && action.set.selector) {
      doc
        .querySelector(action.set.selector)
        ?.setAttribute(action.set.attr ?? "data-state", action.set.value ?? "");
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[Copy all to Figma] action lỗi:", err);
  }
}

// One screen → one or more figh2d documents (one per recipe state; one total when no recipe). The
// page is frozen and driven on a single live iframe so cumulative actions behave like the CLI.
async function captureScreenSpec(
  spec: ScreenSpec,
  defW: number,
  defH: number,
): Promise<H2DDocument[]> {
  const states: H2DRecipeState[] =
    spec.states && spec.states.length ? spec.states : [{ actions: [] }];
  const frame = makeArtifactIframe(spec.width ?? defW, spec.height ?? defH);
  document.body.appendChild(frame);
  const out: H2DDocument[] = [];
  try {
    const doc = await loadSrcdoc(frame, injectFreeze(spec.html));
    await settleAndHug(frame, doc);
    for (const state of states) {
      for (const action of state.actions ?? []) await applyAction(doc, action);
      await settleAndHug(frame, doc);
      try {
        out.push(
          await captureElement(doc.body.firstElementChild ?? doc.body, {
            skipRemoteAssetSerialization: false,
          }),
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[Copy all to Figma] bỏ qua một state:", err);
      }
    }
  } finally {
    frame.remove();
  }
  return out;
}

/**
 * Many prototype screens (each optionally multistep) → ONE combined payload, the in-browser
 * equivalent of the CLI's `copy-figma-h2d.mjs <screens> --out-dir …`. Pasting once drops every
 * screen — and every state of a multistep screen — into Figma as sibling frames. A screen that
 * fails to capture is skipped (console warn) rather than failing the whole batch.
 */
export async function screensToFigmaClipboard(
  specs: ScreenSpec[],
  width = 430,
  height = 932,
): Promise<string> {
  const docs: H2DDocument[] = [];
  for (const spec of specs) {
    if (typeof spec.html !== "string" || !spec.html.trim()) continue;
    try {
      docs.push(...(await captureScreenSpec(spec, width, height)));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[Copy all to Figma] bỏ qua một màn:", err);
    }
  }
  if (docs.length === 0) throw new Error("Không trích xuất được màn nào");
  const { html: payload } = await toFigmaClipboardHtml(docs, { source: "open-design" });
  return payload;
}
