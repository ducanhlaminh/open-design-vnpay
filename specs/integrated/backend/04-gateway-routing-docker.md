# 04 — Gateway Routing & Docker Compose

> Cấu hình routing cho `preview-gateway` và Docker Compose volumes.

---

## 1. Gateway Routing

> **Lưu ý**: `preview-gateway` là external service — KHÔNG sửa code.  
> Chỉ cập nhật **config files** tại `deploy/dev/configs/`.

### Route mapping cần thêm

| Frontend request | Target service | Backend path |
|-----------------|---------------|-------------|
| `GET /api/design-systems*` | `design-system-svc:8086` | `/api/v1/design-systems*` |
| `GET /api/design-templates*` | `skill-service:8082` | `/api/v1/design-templates*` |
| `GET /api/skills*` | `skill-service:8082` | `/api/v1/skills*` (existing) |
| `GET /api/prompt-templates*` | `media-service:8084` | `/api/v1/prompt-templates*` |
| `POST /api/media/generate-from-template` | `media-service:8084` | `/api/v1/media/generate-from-template` |
| `GET /api/media*` | `media-service:8084` | `/api/v1/media*` (existing) |

### Config file (nếu gateway dùng reverse proxy YAML)

```yaml
# deploy/dev/configs/gateway.yaml hoặc nginx.conf

upstream:
  design-system-svc:
    url: http://design-system-svc:8086

routes:
  # NEW: Design Systems
  - match: /api/design-systems
    methods: [GET, POST, DELETE]
    upstream: design-system-svc
    strip_prefix: /api
    add_prefix: /api/v1

  # NEW: Design Templates (via skill-service)
  - match: /api/design-templates
    methods: [GET, POST]
    upstream: skill-service
    strip_prefix: /api
    add_prefix: /api/v1

  # EXISTING: Skills (unchanged)
  - match: /api/skills
    upstream: skill-service
    strip_prefix: /api
    add_prefix: /api/v1

  # NEW: Prompt Templates (via media-service)
  - match: /api/prompt-templates
    methods: [GET, POST]
    upstream: media-service
    strip_prefix: /api
    add_prefix: /api/v1

  # NEW: Generate from template
  - match: /api/media/generate-from-template
    methods: [POST]
    upstream: media-service
    strip_prefix: /api
    add_prefix: /api/v1

  # EXISTING: Media jobs (unchanged)
  - match: /api/media
    upstream: media-service
    strip_prefix: /api
    add_prefix: /api/v1
```

---

## 2. Docker Compose (`deploy/dev/docker-compose.server.yaml`)

### Thêm service mới `design-system-svc`

```yaml
services:
  # ─── MỚI: Design System Service ─────────────────────────────────────────────
  design-system-svc:
    build:
      context: ../../services/design-system-svc
      dockerfile: Dockerfile
    container_name: design-system-svc
    restart: unless-stopped
    ports:
      - "8086:8086"
    environment:
      - PORT=8086
      - DS_CATALOG_PATH=/catalog
      - GIN_MODE=release
    volumes:
      # Mount design-systems directory read-only
      - ../../ui/open-design-vnpay/design-systems:/catalog:ro
    networks:
      - open-design-net
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8086/health"]
      interval: 30s
      timeout: 5s
      retries: 3
```

### Cập nhật `skill-service` — thêm volume + env

```yaml
  skill-service:
    # ... existing config ...
    environment:
      - SKILLS_PATH=/skills
      - DESIGN_TEMPLATES_PATH=/design-templates   # ← THÊM
      - PORT=8082
    volumes:
      - ../../ui/open-design-vnpay/skills:/skills:ro       # existing
      - ../../ui/open-design-vnpay/design-templates:/design-templates:ro  # ← THÊM
```

### Cập nhật `media-service` — thêm volume + env

```yaml
  media-service:
    # ... existing config ...
    environment:
      - PORT=8084
      - PROMPT_TEMPLATES_IMAGE_PATH=/prompt-templates/image   # ← THÊM
      - PROMPT_TEMPLATES_VIDEO_PATH=/prompt-templates/video   # ← THÊM
    volumes:
      # existing volumes...
      - ../../ui/open-design-vnpay/prompt-templates:/prompt-templates:ro  # ← THÊM
```

---

## 3. Vite Dev Proxy (`ui/vite.config.ts`)

Thêm proxy rules cho dev environment:

```typescript
// ui/vite.config.ts
export default defineConfig({
  server: {
    proxy: {
      // Existing
      '/api/skills': { target: 'http://localhost:8082', rewrite: p => p.replace('/api/', '/api/v1/') },
      '/api/media': { target: 'http://localhost:8084', rewrite: p => p.replace('/api/', '/api/v1/') },

      // ← MỚI
      '/api/design-systems': {
        target: 'http://localhost:8086',
        rewrite: path => path.replace('/api/', '/api/v1/'),
      },
      '/api/design-templates': {
        target: 'http://localhost:8082',
        rewrite: path => path.replace('/api/', '/api/v1/'),
      },
      '/api/prompt-templates': {
        target: 'http://localhost:8084',
        rewrite: path => path.replace('/api/', '/api/v1/'),
      },
    },
  },
});
```

---

## 4. `go.work` — Thêm `design-system-svc`

```
// services/go.work
use ./design-system-svc   // ← THÊM
```

---

## 5. Port allocation

| Service | Port | Ghi chú |
|---------|------|---------|
| preview-gateway | 8080 | API Gateway |
| preview-project | 8081 | Existing |
| skill-service | 8082 | Existing + design-templates |
| config-service | 8083 | Existing |
| media-service | 8084 | Existing + prompt-templates |
| plugin-service | 8085 | Existing |
| **design-system-svc** | **8086** | **MỚI** |
| mcp-service | 8087 | Existing |
| memory-service | 8088 | Existing |
| telemetry-service | 8089 | Existing |

---

## Implementation Status

> **Cập nhật**: 2026-06-04 — **HOÀN THÀNH** ✅

### §1 — Gateway Routing

> **Thực tế**: `preview-gateway` là external service (không modify code).  
> Routing được implement qua **nginx** (b5.openledger.vn) thay vì gateway YAML config.

| Route | Upstream | File | Status |
|-------|----------|------|--------|
| `/api/design-systems*` → `design-system-svc:18086` | `vnp_design_system_svc` | `nginx-b5-openledger.conf` | ✅ |
| `/api/design-templates*` → `skill-service:18082` | `vnp_skill_svc` | `nginx-b5-openledger.conf` | ✅ |
| `/api/prompt-templates*` → `media-service:18084` | `vnp_media_svc` | `nginx-b5-openledger.conf` | ✅ |
| `/api/media/generate-from-template` → `media-service:18084` | `vnp_media_svc` | `nginx-b5-openledger.conf` | ✅ |

### §2 — Docker Compose

| Service | Container | Port | Status |
|---------|-----------|------|--------|
| `design-system-svc` | `design-system-svc-server` | host:18086 → :8086 | ✅ Binary mount |
| `skill-service` | `skill-service-server` | host:18082 → :8082 | ✅ +design-templates volume |
| `media-service` | `media-service-server` | host:18084 → :8084 | ✅ +prompt-templates volume |

Volume mounts đúng spec:
- `../../ui/open-design-vnpay/design-systems:/catalog:ro`
- `../../ui/open-design-vnpay/design-templates:/design-templates:ro`
- `../../ui/open-design-vnpay/prompt-templates:/prompt-templates:ro`

### §3 — Vite Dev Proxy

Implement với **dual-mode** (tốt hơn spec):
- **Gateway mode** (default): tất cả `/api/*` → gateway `:7456`
- **Direct mode** (`VITE_USE_DIRECT_SERVICES=1`): route từng path tới service cụ thể

### §4 — go.work

```
# services/go.work
use ./design-system-svc  ← ĐÃ THÊM ✅
```

### §5 — Port Allocation

| Service | Port (internal) | Host port | Status |
|---------|-----------------|-----------|--------|
| design-system-svc | 8086 | 18086 | ✅ |
| skill-service | 8082 | 18082 | ✅ |
| media-service | 8084 | 18084 | ✅ |

### Deploy script

`deploy/dev/deploy.sh` đã thêm 3 services vào `GO_SERVICES`:
```bash
"design-system-svc:services/design-system-svc:./cmd"
"skill-service:services/skill-service:./cmd"
"media-service:services/media-service:./cmd"
```
