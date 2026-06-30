import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// ── Proxy Configuration ───────────────────────────────────────────────────────
//
// MODE 1 — Gateway (default, production-like):
//   VITE_API_GATEWAY_URL=http://localhost:7456 (all /api/* → gateway → services)
//
// MODE 2 — Direct services (for local development without gateway):
//   VITE_USE_DIRECT_SERVICES=1
//   VITE_DS_SVC_URL=http://localhost:8086      # design-system-svc
//   VITE_SKILL_SVC_URL=http://localhost:8082   # skill-service (templates)
//   VITE_MEDIA_SVC_URL=http://localhost:8084   # media-service (prompt-templates)
//
const GATEWAY_URL = process.env.VITE_API_GATEWAY_URL ?? 'http://localhost:7456';
const USE_DIRECT  = process.env.VITE_USE_DIRECT_SERVICES === '1';

const DS_SVC_URL    = process.env.VITE_DS_SVC_URL    ?? 'http://localhost:8086';
const SKILL_SVC_URL = process.env.VITE_SKILL_SVC_URL ?? 'http://localhost:8082';
const MEDIA_SVC_URL = process.env.VITE_MEDIA_SVC_URL ?? 'http://localhost:8084';

// Proxy rewrite: strip /api prefix then add /api/v1
const rewriteToV1 = (path: string) => path.replace(/^\/api/, '/api/v1');

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },

  server: {
    port: 3000,
    proxy: USE_DIRECT
      ? {
          // B-34: Direct-service proxy — routes each path family to its service
          // Order matters: more-specific paths first
          '/api/design-systems': {
            target: DS_SVC_URL,
            changeOrigin: true,
            rewrite: rewriteToV1,
          },
          '/api/design-templates': {
            target: SKILL_SVC_URL,
            changeOrigin: true,
            rewrite: rewriteToV1,
          },
          '/api/skills': {
            target: SKILL_SVC_URL,
            changeOrigin: true,
            rewrite: rewriteToV1,
          },
          '/api/prompt-templates': {
            target: MEDIA_SVC_URL,
            changeOrigin: true,
            rewrite: rewriteToV1,
          },
          '/api/media': {
            target: MEDIA_SVC_URL,
            changeOrigin: true,
            rewrite: rewriteToV1,
          },
          // Fallback: remaining /api/* → gateway
          '/api': { target: GATEWAY_URL, changeOrigin: true },
          '/artifacts': { target: GATEWAY_URL, changeOrigin: true },
          '/frames': { target: GATEWAY_URL, changeOrigin: true },
        }
      : {
          // Default: all /api/* → gateway (gateway routes to individual services)
          '/api': { target: GATEWAY_URL, changeOrigin: true },
          '/artifacts': { target: GATEWAY_URL, changeOrigin: true },
          '/frames': { target: GATEWAY_URL, changeOrigin: true },
        },
  },

  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
