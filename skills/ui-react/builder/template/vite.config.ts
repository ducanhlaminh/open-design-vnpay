import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Per-project build config (lives in the project CWD → isolated per project).
const root = fileURLToPath(new URL('.', import.meta.url))
const srcScreens = resolve(root, 'src/screens')
const genDir = resolve(root, 'screens') // generated per-screen entries → dist/screens/*

// Discover agent-authored screens (each DEFAULT-exports a component) and generate a
// standalone HTML + mount entry per screen, so Vite emits one
// `dist/screens/<slug>.html` per screen (for the all-screens canvas) ALONGSIDE
// `dist/index.html` (the full app + HashRouter). Chunks are shared across every page
// (no singlefile) → small total; each page URL-loads its relative ./assets/*.
function screenEntries(): Record<string, string> {
  const input: Record<string, string> = { index: resolve(root, 'index.html') }
  if (!existsSync(srcScreens)) return input
  mkdirSync(genDir, { recursive: true })
  for (const file of readdirSync(srcScreens)) {
    if (!/\.tsx$/.test(file) || file.startsWith('.')) continue
    const slug = file.replace(/\.tsx$/, '')
    const entryTsx = resolve(genDir, `${slug}-entry.tsx`)
    const entryHtml = resolve(genDir, `${slug}.html`)
    // The standalone page still wraps the screen in a HashRouter: screens are
    // authored with useNavigate()/<Link> (the full app wires real routes), and
    // rendering them router-less crashes with "useNavigate() may be used only
    // in the context of a <Router>". A catch-all route renders THIS screen for
    // any hash, so in-screen navigation stays inert on the canvas page instead
    // of crashing.
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
  // Relative asset paths so each built page (index.html + screens/*.html) resolves
  // its ./assets/* when URL-loaded from a media/project file URL (iframe preview).
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve(root, 'src') } },
  // node_modules is the shared read-only toolkit; keep Vite's cache OUTSIDE it.
  cacheDir: process.env.VITE_CACHE_DIR || '.vite-cache',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input: screenEntries() },
  },
})
