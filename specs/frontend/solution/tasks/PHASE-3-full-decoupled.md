# PHASE 3 — Full Decoupled Deployment (React CSR + Vite)

> **Tuần**: 19–20  
> **Phạm vi**: `ui/` — React SPA thuần client-side, không có Next.js  
> **Mục tiêu**: Frontend độc lập hoàn toàn — Static SPA deploy Nginx/S3/CDN, không cần server  
> **Stack**: React 18 + Vite + React Router v6 + TypeScript  
> **Ref**: [03-full-decoupled-spa.md](../03-full-decoupled-spa.md)

---

## Tuần 19 — Vite SPA Config + Deploy Mode

---

### T01 — Vite Environment Config cho Production

**File**: `ui/vite.config.ts`, `ui/.env.production`  
**Effort**: 3h  
**Assignee**: Frontend Dev  
**Depends on**: Phase 2 complete  
**Status**: `[ ]`

**Mô tả**: Vite SPA gọi API Gateway trực tiếp qua `VITE_API_GATEWAY_URL`. Không có server-side proxy — tất cả calls đều từ browser.

```typescript
// ui/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  
  // Dev server: proxy /api/* sang Gateway để tránh CORS khi dev
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: process.env.VITE_API_GATEWAY_URL ?? 'http://localhost:7456',
        changeOrigin: true,
      },
      '/artifacts': {
        target: process.env.VITE_API_GATEWAY_URL ?? 'http://localhost:7456',
        changeOrigin: true,
      },
      '/frames': {
        target: process.env.VITE_API_GATEWAY_URL ?? 'http://localhost:7456',
        changeOrigin: true,
      },
    },
  },
  
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // Code splitting theo route
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          ui: ['@radix-ui/react-dialog', '@radix-ui/react-tooltip'],
        },
      },
    },
  },
}));
```

```bash
# ui/.env
VITE_API_GATEWAY_URL=http://localhost:7456

# ui/.env.production
VITE_API_GATEWAY_URL=https://api.opendesign.example.com
```

**Checklist**:
- [ ] `VITE_API_GATEWAY_URL` env var được đọc đúng trong runtime
- [ ] Dev mode: `vite` proxy `/api/*` sang gateway (không CORS error)
- [ ] Build: `npm run build` → `dist/` folder static files
- [ ] `dist/index.html` là entry point cho SPA
- [ ] `.env`, `.env.production`, `.env.local` trong `.gitignore` (trừ `.env.example`)

---

### T02 — API Client — Direct Browser HTTP (không proxy)

**File**: `ui/src/api/client.ts`  
**Effort**: 4h  
**Assignee**: Frontend Dev  
**Depends on**: T01  
**Status**: `[ ]`

**Mô tả**: Trong React CSR, browser gọi thẳng API Gateway. Khi production, `VITE_API_GATEWAY_URL` là absolute URL, cần CORS. Khi dev, Vite proxy handle.

```typescript
// ui/src/api/client.ts
const API_BASE = import.meta.env.VITE_API_GATEWAY_URL ?? '';
// Dev: '' → Vite proxy /api/* → http://localhost:7456/api/*
// Prod: 'https://api.opendesign.example.com'

export class BaseApiClient {
  protected readonly baseUrl: string;
  
  constructor(baseUrl: string = API_BASE) {
    this.baseUrl = baseUrl;
  }
  
  protected async get<T>(path: string, opts?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...opts?.headers,
      },
      credentials: 'include',  // CORS với credentials
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return res.json();
  }
  
  // post, put, patch, del tương tự...
  
  // SSE streaming (trực tiếp từ browser — không qua proxy)
  protected connectSSE(path: string, signal?: AbortSignal): EventSource {
    const url = `${this.baseUrl}${path}`;
    // EventSource không hỗ trợ custom headers → dùng fetch API thay thế
    return this.fetchSSEStream(url, signal);
  }
}
```

**Acceptance Criteria**:
- [ ] `import.meta.env.VITE_API_GATEWAY_URL` được dùng (không dùng `process.env`)
- [ ] CORS `credentials: 'include'` cho cross-origin requests (production)
- [ ] SSE dùng `fetch()` streaming (không dùng `EventSource` vì không có custom headers)
- [ ] Không có hardcode `localhost`

---

### T03 — React Router v6 Setup

**File**: `ui/src/router.tsx`, `ui/src/main.tsx`  
**Effort**: 3h  
**Assignee**: Frontend Dev  
**Depends on**: T01  
**Status**: `[ ]`

**Mô tả**: React Router v6 thay thế Next.js file-based routing. SPA với `createBrowserRouter`.

```typescript
// ui/src/router.tsx
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { RootLayout } from './layouts/RootLayout';
import { HomePage } from './pages/HomePage';
import { ProjectPage } from './pages/ProjectPage';
import { SettingsPage } from './pages/SettingsPage';
import { DesignSystemsPage } from './pages/DesignSystemsPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { ErrorPage } from './pages/ErrorPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    errorElement: <ErrorPage />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'projects/:id', element: <ProjectPage /> },
      { path: 'design-systems', element: <DesignSystemsPage /> },
      { path: 'design-systems/:id', element: <DesignSystemDetailPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'onboarding', element: <OnboardingPage /> },
    ],
  },
]);

// ui/src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
```

**Checklist**:
- [ ] Tất cả routes từ Next.js `app/` → React Router routes
- [ ] 404 handling với catch-all `*` route
- [ ] History API fallback (SPA routing) — cần cấu hình Nginx và Vite
- [ ] `<Link>` từ `react-router-dom` (không còn `next/link`)
- [ ] `useNavigate()` thay `useRouter()` từ Next.js

---

### T04 — Migrate `next/image`, `next/font`, Next.js APIs

**File**: `ui/src/` (nhiều files)  
**Effort**: 6h  
**Assignee**: Frontend Dev  
**Depends on**: T03  
**Status**: `[ ]`

**Mô tả**: Loại bỏ toàn bộ Next.js-specific imports.

**Replace table**:

| Next.js | React/Standard |
|---------|---------------|
| `import Image from 'next/image'` | `<img>` thuần hoặc custom `<Image>` |
| `import Link from 'next/link'` | `import { Link } from 'react-router-dom'` |
| `import { useRouter } from 'next/navigation'` | `import { useNavigate, useParams } from 'react-router-dom'` |
| `import { useSearchParams } from 'next/navigation'` | `import { useSearchParams } from 'react-router-dom'` |
| `import { usePathname } from 'next/navigation'` | `import { useLocation } from 'react-router-dom'` |
| `'use client'` directive | Xóa bỏ (tất cả là CSR) |
| `'use server'` directive | Xóa bỏ (không có server) |
| `next/headers` | Không dùng (CSR) |
| `next/dynamic` | `React.lazy()` + `Suspense` |
| `getServerSideProps` | Xóa bỏ → dùng `useEffect` + `useState` |
| `getStaticProps` | Xóa bỏ → dùng `useEffect` |
| `metadata` export | `<Helmet>` từ `react-helmet-async` |

```typescript
// Ví dụ thay thế dynamic import:
// TRƯỚC (Next.js):
const HeavyComponent = dynamic(() => import('./HeavyComponent'));

// SAU (React):
const HeavyComponent = React.lazy(() => import('./HeavyComponent'));
// Dùng: <Suspense fallback={<Spinner />}><HeavyComponent /></Suspense>
```

**Checklist**:
- [ ] `grep -r "next/" ui/src/` → 0 results sau khi hoàn thành
- [ ] `grep -r "'use client'" ui/src/` → 0 results
- [ ] `grep -r "'use server'" ui/src/` → 0 results
- [ ] SEO meta tags dùng `react-helmet-async`
- [ ] `<title>` và `<meta>` set đúng per-page

---

### T05 — Frontend Dockerfile (Nginx Static Serving)

**File**: `ui/Dockerfile`  
**Effort**: 3h  
**Assignee**: DevOps / Frontend Dev  
**Depends on**: T01  
**Status**: `[ ]`

**Mô tả**: Multi-stage build — Vite build → Nginx static serving. Không cần Node.js runtime.

```dockerfile
# ui/Dockerfile

# ── Stage 1: Build ────────────────────────────────────────────────
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /workspace

# Dependencies
COPY package.json pnpm-lock.yaml ./
COPY ui/package.json ./ui/
RUN pnpm install --frozen-lockfile --filter @open-design/ui...

# Build
COPY ui/ ./ui/
ARG VITE_API_GATEWAY_URL=https://api.opendesign.example.com
ENV VITE_API_GATEWAY_URL=$VITE_API_GATEWAY_URL

RUN pnpm --filter @open-design/ui build

# ── Stage 2: Nginx ────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runner

# Custom nginx config cho SPA (history API fallback)
COPY ui/nginx.conf /etc/nginx/conf.d/default.conf

# Copy static build
COPY --from=builder /workspace/ui/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

```nginx
# ui/nginx.conf
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;
    
    # Gzip compression
    gzip on;
    gzip_types text/css application/javascript application/json;
    
    # SPA: fallback tất cả routes về index.html
    location / {
        try_files $uri $uri/ /index.html;
    }
    
    # Cache static assets
    location ~* \.(js|css|png|jpg|svg|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
    
    # API và artifacts: reverse proxy sang Go Gateway
    location /api/ {
        proxy_pass http://gateway:7456;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        
        # SSE support
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600;
        chunked_transfer_encoding on;
    }
    
    location /artifacts/ {
        proxy_pass http://gateway:7456;
    }
    
    location /frames/ {
        proxy_pass http://gateway:7456;
    }
}
```

**Checklist**:
- [ ] `docker build --build-arg VITE_API_GATEWAY_URL=https://... -t open-design/ui .`
- [ ] Image dựa trên Nginx Alpine — không có Node.js (nhỏ hơn ~150MB vs 500MB)
- [ ] SPA routing: `/projects/abc` → trả về `index.html` (không 404)
- [ ] SSE `/api/runs/:id/events` không bị Nginx buffer (proxy_buffering off)
- [ ] Static assets có `Cache-Control: immutable`
- [ ] `.dockerignore`: `node_modules/`, `dist/`, `.env.local`

---

### T06 — Static Deploy Config (Nginx / S3 / CDN)

**File**: `ui/nginx.conf`, `deploy/dev/docker-compose.yaml`  
**Effort**: 2h  
**Assignee**: DevOps  
**Depends on**: T05  
**Status**: `[ ]`

**Thêm vào Docker Compose**:
```yaml
# deploy/dev/docker-compose.yaml
services:
  ui:
    build:
      context: ../../
      dockerfile: ui/Dockerfile
      args:
        VITE_API_GATEWAY_URL: "http://gateway:7456"
    ports:
      - "3000:80"
    depends_on:
      - gateway
    profiles: [od]
```

**Deploy alternatives**:
- **Local dev**: `pnpm dev` → Vite dev server với proxy
- **Docker**: `docker compose --profile od up ui` → Nginx container
- **S3/CDN**: Upload `dist/` → S3, CloudFront, hoặc Cloudflare Pages
- **Electron**: Bundle `dist/` trực tiếp (không cần Nginx)

---

## Tuần 19 — Electron Desktop Update

---

### T07 — Electron: Load React SPA trực tiếp

**File**: `apps/desktop/src/main/`  
**Effort**: 8h  
**Assignee**: Frontend Dev (Desktop)  
**Depends on**: T05  
**Status**: `[ ]`

**Mô tả**: Electron load React SPA từ `dist/` (không cần server). Go Gateway và services chạy như background processes.

```typescript
// apps/desktop/src/main/window.ts

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  
  if (app.isPackaged) {
    // Production: load từ bundled dist/
    win.loadFile(path.join(process.resourcesPath, 'ui/dist/index.html'));
  } else {
    // Development: load từ Vite dev server
    win.loadURL('http://localhost:3000');
  }
}
```

```typescript
// apps/desktop/src/main/gateway-launcher.ts — Go binary launcher
// (thay thế daemon-startup.ts)

export async function startGoGateway(): Promise<void> {
  const binaryPath = app.isPackaged
    ? path.join(process.resourcesPath, 'bin/gateway')
    : path.join(__dirname, '../../../../services/preview-gateway/dist/gateway');
  
  const gatewayProcess = spawn(binaryPath, [], {
    env: {
      ...process.env,
      OD_GATEWAY_PORT: '7456',
      OD_WORKSPACE_ROOT: getWorkspacePath(),
    },
  });
  
  // Wait for gateway health check
  await waitForHealth('http://localhost:7456/api/health', 10_000);
}
```

**Checklist**:
- [ ] Production: load `dist/index.html` trực tiếp (no server)
- [ ] Development: Vite dev server (`localhost:3000`)
- [ ] Electron `loadFile()` không cần Nginx
- [ ] `api/` calls trong browser → `http://localhost:7456/api/` (Go Gateway trên cùng máy)
- [ ] Go binaries cross-compile: darwin-arm64, darwin-amd64, win32-x64

---

### T08 — Electron: Inter-Process Communication (IPC)

**File**: `apps/desktop/src/main/ipc.ts`, `ui/src/lib/electron.ts`  
**Effort**: 6h  
**Assignee**: Frontend Dev  
**Depends on**: T07  
**Status**: `[ ]`

**Mô tả**: Một số tính năng Electron cần IPC (open file dialog, open external URL, etc.).

```typescript
// apps/desktop/src/main/ipc.ts
import { ipcMain, dialog, shell } from 'electron';

ipcMain.handle('open-external', async (_, url: string) => {
  await shell.openExternal(url);
});

ipcMain.handle('open-file-dialog', async (_, opts) => {
  const result = await dialog.showOpenDialog(opts);
  return result;
});

ipcMain.handle('get-gateway-url', () => {
  return 'http://localhost:7456';
});

// ui/src/lib/electron.ts — bridge cho React code
export const electronAPI = {
  isElectron: () => !!(window as any).electronAPI,
  
  openExternal: async (url: string) => {
    if (electronAPI.isElectron()) {
      return (window as any).electronAPI.openExternal(url);
    }
    window.open(url, '_blank');
  },
  
  getGatewayUrl: async (): Promise<string> => {
    if (electronAPI.isElectron()) {
      return (window as any).electronAPI.getGatewayUrl();
    }
    return import.meta.env.VITE_API_GATEWAY_URL ?? '';
  },
};
```

---

## Tuần 20 — Final Validation & Hardening

---

### T09 — E2E Test Suite — React SPA + Playwright

**File**: `ui/tests/e2e/`  
**Effort**: 16h  
**Assignee**: Frontend Dev  
**Depends on**: T01–T08  
**Status**: `[ ]`

**Playwright config cho Vite**:
```typescript
// ui/playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  use: {
    baseURL: 'http://localhost:3000',
  },
  webServer: {
    command: 'pnpm dev',      // Vite dev server
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
});
```

**Test scenarios bắt buộc**:

```typescript
// tests/e2e/onboarding.spec.ts
test('Onboarding flow', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /welcome/i })).toBeVisible();
  await page.getByRole('button', { name: /get started/i }).click();
  await expect(page).toHaveURL('/');
});

// tests/e2e/project.spec.ts
test('Create project', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /new project/i }).click();
  await page.getByPlaceholder(/project name/i).fill('Test Project');
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page.getByText('Test Project')).toBeVisible();
});

// tests/e2e/agent-run.spec.ts
test('Agent run SSE streaming', async ({ page }) => {
  await page.goto('/projects/test-id');
  await page.getByRole('textbox').fill('Create a button component');
  await page.getByRole('button', { name: /run/i }).click();
  
  // Wait for SSE streaming to show events
  await expect(page.getByTestId('run-status')).toContainText('running', { timeout: 10_000 });
  await expect(page.getByTestId('run-status')).toContainText('completed', { timeout: 60_000 });
});
```

**Test coverage**:
- [ ] Onboarding flow
- [ ] Project CRUD (create, open, delete)
- [ ] Agent run → SSE events → completed
- [ ] Cancel run
- [ ] Design systems list
- [ ] Settings → config save → reload → persists
- [ ] React Router navigation (no page reload)
- [ ] 404 page

---

### T10 — Load Test API Gateway từ Browser

**File**: `ui/tests/load/`  
**Effort**: 4h  
**Assignee**: DevOps  
**Depends on**: T05  
**Status**: `[ ]`

**Tool**: k6 Browser (headless Chrome)

```javascript
// ui/tests/load/browser.js
import { browser } from 'k6/browser';
import { check } from 'k6';

export const options = {
  scenarios: {
    ui: {
      executor: 'constant-vus',
      options: { browser: { type: 'chromium' } },
      vus: 10,
      duration: '3m',
    },
  },
  thresholds: {
    'browser_http_req_duration': ['p(95)<3000'],  // page load < 3s
  },
};

export default async function () {
  const page = await browser.newPage();
  await page.goto('http://localhost:3000');
  
  // Measure initial load
  const title = page.locator('h1');
  check(title, { 'page loaded': async (el) => await el.isVisible() });
  
  await page.close();
}
```

---

### T11 — Build Optimization + Bundle Analysis

**File**: `ui/vite.config.ts`  
**Effort**: 4h  
**Assignee**: Frontend Dev  
**Depends on**: T01  
**Status**: `[ ]`

**Checklist**:
- [ ] Bundle analyzer: `vite-bundle-visualizer`
  ```bash
  pnpm --filter @open-design/ui build --report
  ```
- [ ] Lazy load heavy components (`React.lazy`)
- [ ] Tree-shaking kiểm tra: `@radix-ui/*` chỉ bundle components được dùng
- [ ] Vendor chunk split: `react`, `react-dom`, `react-router-dom` tách riêng
- [ ] CSS: bỏ unused styles (nếu dùng Tailwind/PostCSS → purge)
- [ ] Target bundle size: `dist/assets/index-*.js` < 500KB (gzipped < 150KB)

---

### T12 — Security Headers + CSP

**File**: `ui/nginx.conf`  
**Effort**: 2h  
**Assignee**: DevOps  
**Depends on**: T05  
**Status**: `[ ]`

```nginx
# Thêm security headers vào nginx.conf:
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Content-Security-Policy "
  default-src 'self';
  script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com;
  img-src 'self' data: blob:;
  connect-src 'self' http://localhost:7456 https://api.opendesign.example.com;
" always;
```

---

### T13 — Documentation Update + Phase 3 Sign-off

**Effort**: 4h  
**Assignee**: Frontend Dev + DevOps  
**Depends on**: T09–T12  
**Status**: `[ ]`

**Checklist**:
- [ ] `ui/README.md` — setup, dev, build, Docker
- [ ] `ui/QUICKSTART.md` — developer onboarding
- [ ] `.github/workflows/ui.yml` — CI: `pnpm install → pnpm test → pnpm build`
- [ ] `deploy/dev/docker-compose.yaml` — final với Go services + Nginx SPA

---

## Acceptance Criteria Phase 3

- [ ] `pnpm --filter @open-design/ui dev` → Vite dev server, app hoạt động
- [ ] `pnpm --filter @open-design/ui build` → `dist/` static files
- [ ] `docker compose --profile od up` → Nginx SPA + Go Gateway hoạt động
- [ ] Electron: load từ `dist/index.html` + Go binary backend
- [ ] React Router: `/projects/abc` → đúng page (không 404)
- [ ] SPA không có server component, không có SSR
- [ ] E2E tests: 100% pass
- [ ] Bundle size < 500KB (gzipped < 150KB)
- [ ] Không có `next/` imports trong codebase

---

## Summary — Phase 3 Deliverables

| Deliverable | Task | Ghi chú |
|-------------|------|---------|
| `ui/vite.config.ts` | T01 | Vite config + dev proxy |
| `ui/src/api/client.ts` (CSR) | T02 | Direct browser HTTP |
| `ui/src/router.tsx` | T03 | React Router v6 |
| `ui/src/main.tsx` | T03 | SPA entry point |
| `ui/Dockerfile` (Nginx) | T05 | Multi-stage: Vite + Nginx |
| `ui/nginx.conf` | T05, T12 | SPA fallback + SSE proxy |
| `apps/desktop` — loadFile() | T07 | Electron load static SPA |
| `ui/tests/e2e/` | T09 | Playwright E2E suite |
| `ui/playwright.config.ts` | T09 | Playwright với Vite |

> **Bỏ hoàn toàn**:
> - `next.config.ts` ← không còn cần thiết
> - `next/image`, `next/link`, `next/navigation` ← thay bằng React native
> - Next.js server (`node ui/server.js`) ← thay bằng Nginx static serving
> - Vercel serverless functions ← không có server, chỉ static + Go backend
