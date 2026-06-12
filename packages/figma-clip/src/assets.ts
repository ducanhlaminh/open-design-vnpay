// Locate the pinned data assets (glyph atlas + schema/scaffold snapshot). They live at
// <pkg>/assets in source (vitest runs from src/) and at <pkg>/dist/assets after the esbuild
// copy step. Resolving relative to this module's URL covers both layouts via candidate paths.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function resolveAssetDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "assets"), join(here, "..", "assets")];
  for (const dir of candidates) {
    if (existsSync(join(dir, "snapshot.json"))) return dir;
  }
  throw new Error(
    `figma-clip: không tìm thấy thư mục assets (đã thử: ${candidates.join(", ")})`,
  );
}

const ASSET_DIR = resolveAssetDir();

export function readAssetJSON<T>(name: string): T {
  return JSON.parse(readFileSync(join(ASSET_DIR, name), "utf8")) as T;
}
