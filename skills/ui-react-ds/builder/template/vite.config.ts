import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Per-project build config (lives in the project CWD → isolated per project).
// Same multi-entry shape as the ui-react template (dist/index.html full app +
// dist/screens/<slug>.html per screen for the all-screens canvas), minus
// Tailwind — styling comes exclusively from the design system's globals.css
// (CSS-variable tokens + single-declaration tk-* classes) staged at src/ds/.
const root = fileURLToPath(new URL('.', import.meta.url))
const srcScreens = resolve(root, 'src/screens')
const genDir = resolve(root, 'screens') // generated per-screen entries → dist/screens/*

function screenEntries(): Record<string, string> {
  const input: Record<string, string> = { index: resolve(root, 'index.html') }
  if (!existsSync(srcScreens)) return input
  mkdirSync(genDir, { recursive: true })
  for (const file of readdirSync(srcScreens)) {
    if (!/\.tsx$/.test(file) || file.startsWith('.')) continue
    const slug = file.replace(/\.tsx$/, '')
    const entryTsx = resolve(genDir, `${slug}-entry.tsx`)
    const entryHtml = resolve(genDir, `${slug}.html`)
    // Standalone pages still wrap the screen in a HashRouter (screens use
    // useNavigate()/<Link>); a catch-all route renders THIS screen for any
    // hash so in-screen navigation stays inert on the canvas page.
    writeFileSync(
      entryTsx,
      `import { StrictMode } from 'react'\n` +
        `import { createRoot } from 'react-dom/client'\n` +
        `import { HashRouter, Routes, Route } from 'react-router-dom'\n` +
        `import '../src/index.css'\n` +
        `import Screen from '../src/screens/${slug}'\n` +
        `createRoot(document.getElementById('root')!).render(\n` +
        `  <StrictMode><HashRouter><Routes><Route path="*" element={<Screen />} /></Routes></HashRouter></StrictMode>,\n` +
        `)\n`,
    )
    writeFileSync(
      entryHtml,
      `<!doctype html>\n<html lang="vi"><head><meta charset="UTF-8" />` +
        `<meta name="viewport" content="width=device-width, initial-scale=1.0" />` +
        `<title>${slug}</title></head><body><div id="root"></div>` +
        `<script type="module" src="./${slug}-entry.tsx"></script></body></html>\n`,
    )
    input[`screens/${slug}`] = entryHtml
  }
  return input
}

export default defineConfig({
  // Relative asset paths so each built page (index.html + screens/*.html)
  // resolves its ./assets/* when URL-loaded from a media/project file URL.
  // public/assets/ (the design system's icon SVGs, staged by the daemon)
  // copies into dist/assets/ alongside the build chunks — which is exactly
  // where the ds runtime's ASSET_BASE ("../assets/" from a chunk URL) points.
  base: './',
  plugins: [react()],
  resolve: { alias: { '@': resolve(root, 'src') } },
  cacheDir: process.env.VITE_CACHE_DIR || '.vite-cache',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input: screenEntries() },
  },
})
