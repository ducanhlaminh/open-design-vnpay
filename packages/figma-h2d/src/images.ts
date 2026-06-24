// Clean-room asset collector. See specs/current/h2d-serializer-spec.md §5.
// Gathers <img>/background/canvas/video assets as Blobs, keyed by URL (canvas/video get a
// synthetic "rasterized:<n>" key). avif/heif/heic are transcoded to webp via a canvas so Figma
// can read them. getBlobMap() resolves all in parallel; failures degrade to a null blob.

import type { Realm } from "./realm.js";
import type { AssetEntry } from "./types.js";

const UNSUPPORTED_MIME = new Set(["image/avif", "image/heif", "image/heic"]);
const FETCH_TIMEOUT_MS = 8000;

function isRemoteUrl(realm: Realm, url: string): boolean {
  const base = realm.win.location.href;
  if (url.startsWith("data:") || url.startsWith("blob:")) return false;
  if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("//")) {
    return isRemoteUrl(realm, base);
  }
  try {
    const host = new URL(url, base).hostname;
    return !(
      host === "0.0.0.0" ||
      host === "localhost" ||
      host.startsWith("127.") ||
      host === "[::1]" ||
      host === "::1"
    );
  } catch {
    return true;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Failed to create blob from canvas"))),
      "image/webp",
      1,
    );
  });
}

async function transcodeToWebp(realm: Realm, blob: Blob): Promise<Blob> {
  const url = realm.win.URL.createObjectURL(blob);
  try {
    const img = new realm.win.Image();
    img.src = url;
    await img.decode();
    const canvas = realm.doc.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get canvas context for image conversion");
    ctx.drawImage(img, 0, 0);
    return await canvasToBlob(canvas);
  } finally {
    realm.win.URL.revokeObjectURL(url);
  }
}

async function fetchImage(realm: Realm, url: string): Promise<AssetEntry> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await realm.win.fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Failed to fetch image: ${url} - ${res.status}`);
    let blob = await res.blob();
    if (UNSUPPORTED_MIME.has(blob.type)) blob = await transcodeToWebp(realm, blob);
    return { url, blob };
  } finally {
    clearTimeout(timer);
  }
}

export interface ImageCollectorOptions {
  skipRemoteAssetSerialization?: boolean;
}

export class ImageCollector {
  private promises = new Map<string, Promise<AssetEntry>>();
  private rasterizedId = 0;

  constructor(
    private readonly realm: Realm,
    private readonly options: ImageCollectorOptions,
  ) {}

  private add(key: string, promise: Promise<AssetEntry>): void {
    this.promises.set(
      key,
      promise.catch((err) => ({ url: key, blob: null, error: String(err) })),
    );
  }

  addImage(url: string | null | undefined): void {
    if (!url || this.promises.has(url)) return;
    const promise =
      this.options.skipRemoteAssetSerialization && isRemoteUrl(this.realm, url)
        ? Promise.resolve<AssetEntry>({ url, blob: null })
        : fetchImage(this.realm, url);
    this.add(url, promise);
  }

  addCanvas(canvas: HTMLCanvasElement): string {
    const key = `rasterized:${this.rasterizedId++}`;
    this.add(key, canvasToBlob(canvas).then((blob) => ({ url: key, blob })));
    return key;
  }

  /** Collect <img>, background-image url(...) and video poster for an element + its styles. */
  collectFor(el: Element, styles: Record<string, string>): void {
    if (el instanceof this.realm.win.HTMLImageElement) this.addImage(el.currentSrc);
    if (el instanceof this.realm.win.HTMLVideoElement && el.poster) this.addImage(el.poster);
    const bg = styles.backgroundImage;
    if (bg) {
      for (const m of bg.matchAll(/url\("(.*?)"\)/g)) this.addImage(m[1]);
    }
  }

  async getBlobMap(): Promise<Map<string, AssetEntry>> {
    const entries = await Promise.all(
      Array.from(this.promises, async ([key, p]) => [key, await p] as const),
    );
    return new Map(entries);
  }
}
