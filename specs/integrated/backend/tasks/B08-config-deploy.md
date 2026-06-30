# B-33..B-36 — Config & Deploy

**Phase**: B6 | **Estimate**: ~5h | **Depends on**: B5 (tất cả services build clean)

---

## B-33 — Cập nhật `docker-compose.server.yaml`

**Target**: `deploy/dev/docker-compose.server.yaml`  
**Estimate**: 1.5h

### Thêm service `design-system-svc`

```yaml
# Thêm vào phần services:
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
      # Mount design-systems directory (read-only — không cho service ghi vào)
      - ../../ui/open-design-vnpay/design-systems:/catalog:ro
    networks:
      - open-design-net
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8086/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    labels:
      - "com.opendesign.service=design-system-svc"
      - "com.opendesign.version=1.0.0"
```

### Cập nhật `skill-service` — thêm volume và env

Tìm block `skill-service:` trong file và thêm:

```yaml
  skill-service:
    # ... existing config không thay đổi ...
    environment:
      # Existing env vars (giữ nguyên)
      - HTTP_PORT=8082
      - SKILLS_PATH=/skills
      # ← THÊM MỚI
      - DESIGN_TEMPLATES_PATH=/design-templates
    volumes:
      # Existing volume (giữ nguyên)
      - ../../ui/open-design-vnpay/skills:/skills:ro
      # ← THÊM MỚI
      - ../../ui/open-design-vnpay/design-templates:/design-templates:ro
```

### Cập nhật `media-service` — thêm volume và env

```yaml
  media-service:
    # ... existing config không thay đổi ...
    environment:
      # Existing env vars (giữ nguyên)
      - HTTP_PORT=8084
      - STORAGE_PATH=/media-storage
      # ← THÊM MỚI
      - PROMPT_TEMPLATES_IMAGE_PATH=/prompt-templates/image
      - PROMPT_TEMPLATES_VIDEO_PATH=/prompt-templates/video
    volumes:
      # Existing volumes (giữ nguyên)
      - media_storage:/media-storage
      # ← THÊM MỚI
      - ../../ui/open-design-vnpay/prompt-templates:/prompt-templates:ro
```

### Verify docker-compose syntax

```bash
cd deploy/dev
docker compose -f docker-compose.server.yaml config --quiet && echo "Config OK"
```

---

## B-34 — Cập nhật `vite.config.ts`

**Target**: `ui/open-design-vnpay/ui/vite.config.ts`  
**Estimate**: 0.5h

Thêm proxy rules cho local development:

```typescript
// Thêm vào server.proxy:
proxy: {
  // EXISTING (giữ nguyên — chỉ thêm mới)
  '/api/skills': {
    target: 'http://localhost:8082',
    changeOrigin: true,
    rewrite: (path) => path.replace('/api/', '/api/v1/'),
  },
  '/api/media': {
    target: 'http://localhost:8084',
    changeOrigin: true,
    rewrite: (path) => path.replace('/api/', '/api/v1/'),
  },

  // ← THÊM MỚI: Design Systems
  '/api/design-systems': {
    target: 'http://localhost:8086',
    changeOrigin: true,
    rewrite: (path) => path.replace('/api/', '/api/v1/'),
  },

  // ← THÊM MỚI: Design Templates (via skill-service)
  '/api/design-templates': {
    target: 'http://localhost:8082',
    changeOrigin: true,
    rewrite: (path) => path.replace('/api/', '/api/v1/'),
  },

  // ← THÊM MỚI: Prompt Templates (via media-service)
  '/api/prompt-templates': {
    target: 'http://localhost:8084',
    changeOrigin: true,
    rewrite: (path) => path.replace('/api/', '/api/v1/'),
  },
},
```

**Lưu ý về thứ tự proxy rules**: Vite match theo thứ tự, rule cụ thể hơn phải đứng trên.  
Thứ tự đúng: `/api/design-systems` → `/api/design-templates` → `/api/skills` → `/api/media`

**Verify**:
```bash
cd ui/open-design-vnpay/ui
pnpm dev &
curl http://localhost:5173/api/design-systems | jq '.total'
```

---

## B-35 — Gateway Config

**Target**: `deploy/dev/configs/` (tùy gateway type)  
**Estimate**: 1h

### Trước tiên: Kiểm tra gateway config hiện tại

```bash
ls deploy/dev/configs/
cat deploy/dev/configs/gateway.yaml 2>/dev/null || cat deploy/dev/configs/nginx.conf 2>/dev/null
```

### Nếu dùng Nginx upstream config

```nginx
# Thêm upstream mới
upstream design-system-svc {
    server design-system-svc:8086;
}

# Thêm location block
location /api/design-systems {
    proxy_pass http://design-system-svc/api/v1/design-systems;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    # Allow iframe embedding
    add_header X-Frame-Options "SAMEORIGIN";
}

location /api/design-templates {
    proxy_pass http://skill-service/api/v1/design-templates;
    proxy_set_header Host $host;
}

location /api/prompt-templates {
    proxy_pass http://media-service/api/v1/prompt-templates;
    proxy_set_header Host $host;
}

location /api/media/generate-from-template {
    proxy_pass http://media-service/api/v1/media/generate-from-template;
    proxy_set_header Host $host;
}
```

### Nếu dùng YAML config (preview-gateway)

```yaml
routes:
  - match: /api/design-systems
    methods: [GET, POST, OPTIONS]
    upstream:
      name: design-system-svc
      url: http://design-system-svc:8086
    path_rewrite:
      strip: /api
      prefix: /api/v1

  - match: /api/design-templates
    methods: [GET, POST, OPTIONS]
    upstream:
      name: skill-service
      url: http://skill-service:8082
    path_rewrite:
      strip: /api
      prefix: /api/v1

  - match: /api/prompt-templates
    methods: [GET, POST, OPTIONS]
    upstream:
      name: media-service
      url: http://media-service:8084
    path_rewrite:
      strip: /api
      prefix: /api/v1

  - match: /api/media/generate-from-template
    methods: [POST]
    upstream:
      name: media-service
      url: http://media-service:8084
    path_rewrite:
      strip: /api
      prefix: /api/v1
```

---

## B-36 — End-to-End Smoke Test

**Estimate**: 2h

### Step 1: Start tất cả services

```bash
cd deploy/dev
docker compose -f docker-compose.server.yaml up -d design-system-svc skill-service media-service

# Hoặc start trực tiếp (cho development):
cd services

# Terminal 1: design-system-svc
DS_CATALOG_PATH=../ui/open-design-vnpay/design-systems \
PORT=8086 go run ./design-system-svc/cmd/main.go

# Terminal 2: skill-service
SKILLS_PATH=../ui/open-design-vnpay/skills \
DESIGN_TEMPLATES_PATH=../ui/open-design-vnpay/design-templates \
HTTP_PORT=8082 go run ./skill-service/cmd/main.go

# Terminal 3: media-service
PROMPT_TEMPLATES_IMAGE_PATH=../ui/open-design-vnpay/prompt-templates/image \
PROMPT_TEMPLATES_VIDEO_PATH=../ui/open-design-vnpay/prompt-templates/video \
HTTP_PORT=8084 go run ./media-service/cmd/main.go
```

### Step 2: Smoke tests

```bash
#!/bin/bash
echo "=== design-system-svc ==="
echo -n "Health: "; curl -sf http://localhost:8086/health | jq -r .status
echo -n "Total DS: "; curl -sf http://localhost:8086/api/v1/design-systems | jq .total
echo -n "airbnb name: "; curl -sf http://localhost:8086/api/v1/design-systems/airbnb | jq -r .name
echo -n "tokens.css size: "; curl -sf http://localhost:8086/api/v1/design-systems/airbnb/tokens.css | wc -c
echo -n "categories count: "; curl -sf http://localhost:8086/api/v1/design-systems/-/categories | jq '.categories | length'

echo ""
echo "=== skill-service (templates) ==="
echo -n "Health: "; curl -sf http://localhost:8082/health | jq -r .status
echo -n "Total skills: "; curl -sf http://localhost:8082/api/v1/skills | jq .total
echo -n "Total templates: "; curl -sf http://localhost:8082/api/v1/design-templates | jq .total
echo -n "blog-post inputs: "; curl -sf http://localhost:8082/api/v1/design-templates/blog-post | jq '.inputs | length'

echo ""
echo "=== media-service (prompt templates) ==="
echo -n "Health: "; curl -sf http://localhost:8084/health | jq -r .status
echo -n "Total jobs: "; curl -sf http://localhost:8084/api/v1/media/jobs | jq '.total // length'
echo -n "Total prompt templates: "; curl -sf http://localhost:8084/api/v1/prompt-templates | jq .total
echo -n "Image templates: "; curl -sf "http://localhost:8084/api/v1/prompt-templates?surface=image" | jq .total
echo -n "Video templates: "; curl -sf "http://localhost:8084/api/v1/prompt-templates?surface=video" | jq .total
echo -n "3d-staircase args: "; curl -sf http://localhost:8084/api/v1/prompt-templates/3d-stone-staircase-evolution-infographic | jq .argumentCount
```

### Step 3: Expected output

```
=== design-system-svc ===
Health: ok
Total DS: 152
airbnb name: "Airbnb Design System"
tokens.css size: [> 0]
categories count: [> 5]

=== skill-service (templates) ===
Health: ok
Total skills: [> 0]
Total templates: 111
blog-post inputs: [>= 0]

=== media-service (prompt templates) ===
Health: ok
Total prompt templates: 103
Image templates: 46
Video templates: 57
3d-staircase args: [>= 0]
```

### Step 4: Frontend integration check

```bash
# Start Vite dev server
cd ui/open-design-vnpay/ui && pnpm dev &

# Test proxy routing
curl -sf http://localhost:5173/api/design-systems | jq '.total'
curl -sf http://localhost:5173/api/design-templates | jq '.total'
curl -sf http://localhost:5173/api/prompt-templates | jq '.total'
```

---

## Checklist B6

- [x] B-33: `docker-compose.server.yaml` — design-system-svc thêm, skill-service + media-service volumes cập nhật, YAML valid
- [x] B-34: `vite.config.ts` — dual-mode proxy (gateway mode + direct mode với VITE_USE_DIRECT_SERVICES=1)
- [x] B-35: `nginx-b5-openledger.conf` — 3 upstream + 4 location blocks, thứ tự đúng (trước /api/ catch-all)
- [x] B-36: Smoke test script tạo tại `services/smoke_test.sh`, hỗ trợ cả direct + nginx gateway mode
