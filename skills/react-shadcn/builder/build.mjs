// Build-once: bundle the verbatim components/ui closure into one self-contained
// IIFE. React + ReactDOM + Base UI + radix + lucide + every ui/*.tsx are bundled
// in; the result exposes window.{React, createRoot, UI, Lucide, cn}. The skill
// inlines dist/components.bundle.js into assets/shell.html.
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "src");

await esbuild.build({
  entryPoints: [resolve(src, "entry.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  jsx: "automatic",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  // Tailwind v4 input CSS lives in src/styles and is fed to @tailwindcss/browser
  // at runtime, NOT bundled here — so the bundle is JS-only.
  define: { "process.env.NODE_ENV": '"production"' },
  alias: { "@": src },
  outfile: resolve(here, "dist/components.bundle.js"),
  logLevel: "info",
});

console.log("[react-shadcn-builder] dist/components.bundle.js written");
