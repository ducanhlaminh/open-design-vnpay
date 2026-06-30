import { build } from "esbuild";

// Browser target: the serializer needs DOM/getComputedStyle/canvas, so this bundle runs in the
// web app (and the preview iframe). We emit two shapes:
//   - dist/index.mjs        ESM, imported by apps/web
//   - dist/figma-h2d.global.js  IIFE (window.figmaH2D), injected into a Playwright page by the
//                               daemon/CLI via page.addScriptTag — same engine, no DOM in Node.
const common = {
  bundle: true,
  entryPoints: ["./src/index.ts"],
  platform: "browser",
  target: "es2022",
};

await build({ ...common, format: "esm", outfile: "./dist/index.mjs" });
await build({ ...common, format: "iife", globalName: "figmaH2D", outfile: "./dist/figma-h2d.global.js" });
