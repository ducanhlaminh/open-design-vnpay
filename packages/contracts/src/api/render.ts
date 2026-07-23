// POST /api/render/pdf — turn an HTML document into a PDF.
//
// The endpoint answers in ONE OF TWO shapes, and a caller must branch on the
// response Content-Type:
//
//   application/pdf   → the PDF bytes; the caller downloads them (browser path).
//   application/json  → `RenderPdfSavedResponse`; the DESKTOP runtime already
//                       wrote the file through a native Save dialog, so the
//                       caller must NOT try to download anything.
//
// Why two shapes: in the desktop app the PDF is produced by Electron's own
// `webContents.printToPDF`, which saves straight to the path the user picks —
// no npm, no Chromium download, works offline. Only the browser/CLI path falls
// back to provisioning headless Chromium.
export type RenderPdfSavedResponse = {
  /** Discriminator — always true on this shape. */
  saved: true;
  /** false when the user dismissed the native Save dialog. */
  ok: boolean;
  /** true when the user canceled; `ok` is false in that case. */
  canceled?: boolean;
  /** Absolute path the desktop runtime wrote the PDF to. */
  path?: string;
};
