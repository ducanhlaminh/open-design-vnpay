// Clean-room figh2d/figmeta clipboard wrapper. See specs/current/h2d-serializer-spec.md §1.
// Serializes captured documents (blobs -> data URLs), wraps them as the (figh2d) + (figmeta)
// comment blobs Figma reads from text/html, and writes them to the clipboard.

import type { AssetEntry, ClipboardMeta, H2DDocument, SerializedAsset } from "./types.js";

const FIGH2D_OPEN = "<!--(figh2d)";
const FIGH2D_CLOSE = "(/figh2d)-->";
const FIGMETA_OPEN = "<!--(figmeta)";
const FIGMETA_CLOSE = "(/figmeta)-->";

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** UTF-8 string -> base64 (chunk-free, via a Blob data URL so large payloads are safe). */
async function base64Utf8(text: string): Promise<string> {
  const dataUrl = await blobToDataUrl(
    new File([new TextEncoder().encode(text)], "", { type: "application/octet-stream" }),
  );
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/** Resolve a captured document's asset blobs to data URLs and return its JSON string. */
export async function serializeDocument(doc: H2DDocument): Promise<string> {
  const assets: Record<string, SerializedAsset> = {};
  const entries: Iterable<[string, AssetEntry]> =
    doc.assets instanceof Map ? doc.assets : Object.entries(doc.assets as Record<string, AssetEntry>);
  for (const [key, asset] of entries) {
    assets[key] = {
      url: asset.url,
      blob: asset.blob ? await blobToDataUrl(asset.blob) : null,
      ...(asset.error ? { error: asset.error } : {}),
    };
  }
  return JSON.stringify({ ...doc, assets, fonts: doc.fonts });
}

function defaultMeta(source: string, capturedAtIso: string): ClipboardMeta {
  return {
    dataType: "h2d",
    source,
    capturedAtIso,
    h2d: { v: 1, origin: { source, capturedAtIso } },
  };
}

export interface ClipboardPayload {
  html: string;
  plain: string;
}

export interface ToClipboardOptions {
  source?: string;
  capturedAtIso?: string;
  plain?: string;
}

/** Build the text/html (+ text/plain) clipboard payload from captured documents. */
export async function toFigmaClipboardHtml(
  docs: H2DDocument[],
  options: ToClipboardOptions = {},
): Promise<ClipboardPayload> {
  const source = options.source ?? "open-design";
  const capturedAtIso = options.capturedAtIso ?? new Date().toISOString();
  const docJson = await Promise.all(docs.map(serializeDocument));
  const docArray = `[${docJson.join(",\n")}]`;

  const metaB64 = await base64Utf8(JSON.stringify(defaultMeta(source, capturedAtIso)));
  const dataB64 = await base64Utf8(docArray);

  const metaSpan = `<span data-metadata="${FIGMETA_OPEN}${metaB64}${FIGMETA_CLOSE}"></span>`;
  const dataSpan = `<span data-h2d="${FIGH2D_OPEN}${dataB64}${FIGH2D_CLOSE}"></span>`;
  return { html: metaSpan + dataSpan, plain: options.plain ?? "" };
}

/** Write captured documents to the clipboard as Figma-pasteable text/html. Needs a user gesture. */
export async function writeFigmaClipboard(
  docs: H2DDocument[],
  options: ToClipboardOptions = {},
): Promise<void> {
  const { html, plain } = await toFigmaClipboardHtml(docs, options);
  await navigator.clipboard.write([
    new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([plain], { type: "text/plain" }),
    }),
  ]);
}
