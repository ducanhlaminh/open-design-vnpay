import { cpSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

await build({
  bundle: true,
  entryNames: "[dir]/[name]",
  entryPoints: ["./src/index.ts"],
  format: "esm",
  outbase: "./src",
  outdir: "./dist",
  outExtension: { ".js": ".mjs" },
  packages: "external",
  platform: "node",
  target: "node24",
});

// Pinned data assets (glyph atlas + schema/scaffold snapshot) ship beside dist/index.mjs;
// resolveAssetDir() in src/assets.ts finds them via candidate paths in both src and dist.
mkdirSync("./dist/assets", { recursive: true });
cpSync("./assets", "./dist/assets", { recursive: true });
