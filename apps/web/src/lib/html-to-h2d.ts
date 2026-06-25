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

async function withArtifactIframe<T>(
  html: string,
  width: number,
  height: number,
  fn: (root: Element) => Promise<T>,
): Promise<T> {
  const w = Math.max(320, Math.round(width));
  // Render at the real preview viewport height so `100vh`/`%` resolve like the user sees them —
  // a fixed oversized height (e.g. 5000px) inflates vh-based layouts and the captured frame comes
  // out absurdly tall instead of hugging its content.
  const h0 = Math.max(200, Math.round(height) || 812);
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText =
    `position:fixed;left:-100000px;top:0;width:${w}px;height:${h0}px;` +
    "border:0;visibility:hidden;pointer-events:none;";
  document.body.appendChild(frame);
  try {
    await new Promise<void>((res) => {
      frame.onload = () => res();
      frame.srcdoc = html;
    });
    const doc = frame.contentDocument;
    if (!doc) throw new Error("Không tạo được iframe trích xuất");
    try {
      await (doc.fonts?.ready ?? Promise.resolve());
    } catch {
      /* fonts best-effort */
    }
    await new Promise((r) => setTimeout(r, 180)); // let layout settle after fonts (and any step script)
    // Hug: size the iframe to the artifact root's rendered height, then re-settle so vh/%
    // recompute against that height. Short content shrinks; tall/scrolling content grows.
    const root = doc.body.firstElementChild ?? doc.body;
    const rootH = Math.ceil(root.getBoundingClientRect().height);
    if (rootH > 0 && Math.abs(rootH - h0) > 1) {
      frame.style.height = `${rootH}px`;
      await raf();
      await raf();
    }
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
