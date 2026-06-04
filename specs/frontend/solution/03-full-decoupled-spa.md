# Giải pháp 03 — Full Decoupled SPA + API Gateway

> **Độ phức tạp**: Cao  
> **Rủi ro**: Cao  
> **Thời gian ước tính**: 16–20 tuần  
> **Phạm vi thay đổi**: `apps/web` (deploy mode) + Go API Gateway + Tất cả Go Services

---

## 1. Mô tả

Trạng thái cuối cùng của migration — frontend và backend **hoàn toàn độc lập**:

```
┌─────────────────────────────────────────────────────────────────┐
│   FRONTEND DEPLOYMENT (Vercel / CDN / Nginx)                    │
│   apps/web → Next.js Server (SSR) hoặc Static Export           │
│   URL: https://app.opendesign.example.com                       │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTPS (CORS)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│   API GATEWAY (Go — Docker / K8s)                               │
│   URL: https://api.opendesign.example.com (port 7456)          │
│                                                                  │
│   Auth → Rate Limit → Route → Go Services                       │
└──────┬─────────┬──────────┬──────────┬──────────┬──────────────┘
       │         │          │          │          │
       ▼         ▼          ▼          ▼          ▼
  Project    Agent     Design    Skill     Config
  Service    Service   System    Service   Service
  :8081      :8082     :8083     :8088     :8089

  ──────── NATS JetStream (Event Bus) ────────────
       │
       ▼
  Telemetry  Memory   Plugin    MCP
  :8090      :8087    :8085     :8086
```

---

## 2. Thay đổi Frontend (`apps/web`)

### 2.1 Deployment Mode: Server (không phải static export)

Hiện tại `apps/web` build dưới dạng `output: 'export'` và daemon phục vụ static files. Sau migration, frontend là **Next.js Server** tự serve:

```typescript
// apps/web/next.config.ts — TRƯỚC
const shouldStaticExport = isProd && !isServerOutput;
// isProd=true, isServerOutput=false → static export

// apps/web/next.config.ts — SAU
// OD_WEB_OUTPUT_MODE=server → Next.js Server mode
// Frontend tự phục vụ, proxy /api/ sang API Gateway
```

```typescript
// Thêm vào next.config.ts cho server mode:
async rewrites() {
  // Production: proxy API calls sang Go API Gateway
  const API_GATEWAY_URL = process.env.NEXT_PUBLIC_API_GATEWAY_URL
    ?? 'http://localhost:7456';
  return [
    { source: '/api/:path*', destination: `${API_GATEWAY_URL}/api/:path*` },
    { source: '/artifacts/:path*', destination: `${API_GATEWAY_URL}/artifacts/:path*` },
    { source: '/frames/:path*', destination: `${API_GATEWAY_URL}/frames/:path*` },
  ];
}
```

### 2.2 Environment Variables

```bash
# .env.production (frontend)
NEXT_PUBLIC_API_GATEWAY_URL=https://api.opendesign.example.com

# .env.local (dev)
NEXT_PUBLIC_API_GATEWAY_URL=http://localhost:7456
```

### 2.3 CORS — Frontend là Origin khác

Vì frontend và API Gateway ở **domain khác** trong full decoupled mode, cần:

**Frontend side** — thêm `credentials: 'include'` khi cần:
```typescript
// apps/web/src/api/client.ts
protected async post<T>(path: string, body?: unknown): Promise<T> {
  const resp = await fetch(`${this.baseUrl}${path}`, {
    method: 'POST',
    credentials: 'include',    // Gửi cookies cross-domain
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // ...
}
```

**Gateway side** — cấu hình CORS:
```go
// gateway/internal/middleware/cors.go
func CORSMiddleware(allowedOrigins []string) echo.MiddlewareFunc {
    return middleware.CORSWithConfig(middleware.CORSConfig{
        AllowOrigins:     allowedOrigins,
        AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
        AllowHeaders:     []string{"Authorization", "Content-Type", "X-OD-Client"},
        AllowCredentials: true,
        MaxAge:           86400,
    })
}
```

### 2.4 Authentication — Không còn "local trust"

Daemon hiện cho phép local access (127.0.0.1) không cần auth. Trong full decoupled, mọi request phải có JWT:

```typescript
// apps/web/src/api/client.ts
protected async post<T>(path: string, body?: unknown): Promise<T> {
  const token = this.authStore.getToken(); // JWT từ auth flow
  const resp = await fetch(`${this.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
```

### 2.5 Auth Store (mới)

```typescript
// apps/web/src/auth/store.ts — [NEW]
export interface AuthStore {
  getToken(): string | null;
  setToken(token: string): void;
  clearToken(): void;
  isAuthenticated(): boolean;
}

// Implementation: JWT trong memory + refresh token trong httpOnly cookie
export class JwtAuthStore implements AuthStore {
  private accessToken: string | null = null;

  getToken(): string | null {
    return this.accessToken;
  }

  setToken(token: string): void {
    this.accessToken = token;
  }

  clearToken(): void {
    this.accessToken = null;
  }

  isAuthenticated(): boolean {
    if (!this.accessToken) return false;
    try {
      const payload = JSON.parse(atob(this.accessToken.split('.')[1]!));
      return Date.now() / 1000 < payload.exp;
    } catch { return false; }
  }
}
```

---

## 3. Thay đổi API Gateway

### 3.1 Auth — JWT Issuance

Trong local mode, daemon không có auth. Trong full decoupled mode, Gateway phát JWT:

```go
// gateway/internal/delivery/http/auth_handler.go

// POST /api/auth/desktop — Desktop app lấy JWT
func (h *AuthHandler) DesktopAuth(c echo.Context) error {
    var req struct {
        DesktopToken string `json:"desktopToken"`
    }
    if err := c.Bind(&req); err != nil {
        return echo.ErrBadRequest
    }
    // Validate desktop token (từ Electron app)
    if !h.config.ValidateDesktopToken(req.DesktopToken) {
        return echo.ErrUnauthorized
    }
    token, err := h.issueJWT(JWTClaims{
        Subject: "desktop",
        Scope:   "full",
    })
    if err != nil {
        return echo.ErrInternalServerError
    }
    return c.JSON(200, map[string]string{"token": token})
}

// GET /api/auth/refresh — Refresh token rotation
func (h *AuthHandler) RefreshToken(c echo.Context) error {
    // Đọc refresh token từ httpOnly cookie
    // Phát access token mới
    refreshToken, err := c.Cookie("refresh_token")
    // ...
}
```

### 3.2 SSE Streaming qua CORS

SSE streaming cần điều chỉnh khi cross-origin:

```go
// gateway/internal/proxy/sse_proxy.go

func (p *SSEProxy) ProxyRunEvents(c echo.Context) error {
    runID := c.Param("id")
    lastEventID := c.Request().Header.Get("Last-Event-ID")

    // CORS headers cho SSE (cross-origin)
    c.Response().Header().Set("Content-Type", "text/event-stream")
    c.Response().Header().Set("Cache-Control", "no-cache")
    c.Response().Header().Set("X-Accel-Buffering", "no")
    c.Response().Header().Set("Access-Control-Allow-Origin",
        c.Request().Header.Get("Origin"))
    c.Response().Header().Set("Access-Control-Allow-Credentials", "true")
    c.Response().WriteHeader(http.StatusOK)

    // Proxy từ Agent Service gRPC stream
    stream, err := p.agentClient.StreamRunEvents(
        c.Request().Context(),
        &agentpb.StreamRequest{
            RunId:       runID,
            LastEventId: lastEventID,
        },
    )
    if err != nil {
        return err
    }

    flusher := c.Response().Writer.(http.Flusher)
    for {
        event, err := stream.Recv()
        if err == io.EOF {
            break
        }
        if err != nil {
            break
        }
        fmt.Fprintf(c.Response(), "id: %s\nevent: %s\ndata: %s\n\n",
            event.Id, event.Type, event.Data)
        flusher.Flush()
    }
    return nil
}
```

---

## 4. Static File Serving — Giải pháp cho `/artifacts/*` và `/frames/*`

Đây là thách thức khi phân tách: artifact files lưu trên disk ở server, nhưng frontend cần serve chúng qua `<iframe>`.

### Option A: Project Service Serve Files (Recommended)

```go
// project-service/internal/delivery/http/artifact_handler.go

func (h *ArtifactHandler) ServeArtifact(c echo.Context) error {
    path := c.Param("*")
    // Security: validate path không traverse ra ngoài workspace
    cleanPath := filepath.Clean(path)
    if strings.Contains(cleanPath, "..") {
        return echo.ErrForbidden
    }
    fullPath := filepath.Join(h.config.WorkspacePath, "artifacts", cleanPath)
    return c.File(fullPath)
}
```

**API Gateway routing:**
```go
e.GET("/artifacts/*", r.project.ServeArtifact)
e.GET("/frames/*", r.project.ServeFrame)
```

### Option B: CDN / Object Storage

Khi scale lớn — upload artifacts lên S3/R2:
```go
// Khi agent tạo artifact, project service upload lên S3
// Frontend nhận URL: https://cdn.opendesign.example.com/artifacts/{id}/index.html
// Không cần proxy qua API Gateway
```

---

## 5. Local Development — Docker Compose

```yaml
# deploy/dev/docker-compose.full.yml

version: "3.9"

services:
  # ─── Frontend ───────────────────────────────────────
  web:
    build:
      context: ../../apps/web
      target: development
    ports: ["3000:3000"]
    environment:
      NEXT_PUBLIC_API_GATEWAY_URL: "http://localhost:7456"
      NODE_ENV: "development"
    volumes:
      - ../../apps/web:/app
    command: pnpm dev

  # ─── API Gateway ─────────────────────────────────────
  gateway:
    build: ../../services/gateway
    ports: ["7456:7456"]
    environment:
      PROJECT_SERVICE_URL: "project-service:8081"
      AGENT_SERVICE_URL: "agent-service:8082"
      DESIGN_SYSTEM_SERVICE_URL: "design-system-service:8083"
      SKILL_SERVICE_URL: "skill-service:8088"
      CONFIG_SERVICE_URL: "config-service:8089"
      MCP_SERVICE_URL: "mcp-service:8086"
      MEMORY_SERVICE_URL: "memory-service:8087"
      REDIS_URL: "redis://redis:6379"
      JWT_SECRET: "local-dev-secret"
      ALLOWED_ORIGINS: "http://localhost:3000,http://127.0.0.1:3000"
    depends_on: [redis, project-service, agent-service]

  # ─── Core Services ───────────────────────────────────
  project-service:
    build: ../../services/project-service
    environment:
      DATABASE_URL: "postgres://od:od@postgres:5432/open_design?sslmode=disable"
      WORKSPACE_PATH: "/workspace"
      NATS_URL: "nats://nats:4222"
    volumes:
      - workspace:/workspace
    depends_on: [postgres, nats]

  agent-service:
    build: ../../services/agent-service
    environment:
      REDIS_URL: "redis://redis:6379"
      NATS_URL: "nats://nats:4222"
      PROJECT_SERVICE_URL: "project-service:8081"
      WORKSPACE_PATH: "/workspace"
    volumes:
      - workspace:/workspace
    depends_on: [redis, nats, project-service]

  design-system-service:
    build: ../../services/design-system-service
    environment:
      DATABASE_URL: "postgres://od:od@postgres:5432/open_design?sslmode=disable"
      DESIGN_SYSTEMS_PATH: "/design-systems"
    volumes:
      - ../../design-systems:/design-systems:ro

  skill-service:
    build: ../../services/skill-service
    environment:
      SKILLS_PATH: "/skills"
    volumes:
      - ../../skills:/skills:ro

  config-service:
    build: ../../services/config-service
    environment:
      DATABASE_URL: "postgres://od:od@postgres:5432/open_design?sslmode=disable"
      ENCRYPTION_KEY: "local-dev-key-32-chars-minimum!!"

  mcp-service:
    build: ../../services/mcp-service
    environment:
      DATABASE_URL: "postgres://od:od@postgres:5432/open_design?sslmode=disable"
      REDIS_URL: "redis://redis:6379"

  memory-service:
    build: ../../services/memory-service
    environment:
      DATABASE_URL: "postgres://od:od@postgres:5432/open_design?sslmode=disable"
      # pgvector extension required for production
      # SQLite+sqlite-vec for local

  # ─── Infrastructure ───────────────────────────────────
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: od
      POSTGRES_PASSWORD: od
      POSTGRES_DB: open_design
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ./init-db.sql:/docker-entrypoint-initdb.d/init.sql

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data

  nats:
    image: nats:2.10-alpine
    command: "-js"  # Enable JetStream
    ports: ["4222:4222"]

volumes:
  workspace:
  postgres-data:
  redis-data:
```

---

## 6. Frontend Build & Deploy Pipeline

### 6.1 Vercel Deploy (Frontend Only)

```json
// vercel.json — TRƯỚC (proxy qua daemon)
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "http://daemon:7456/api/$1" }
  ]
}

// vercel.json — SAU (proxy qua Go API Gateway)
{
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://api.opendesign.example.com/api/:path*" },
    { "source": "/artifacts/:path*", "destination": "https://api.opendesign.example.com/artifacts/:path*" },
    { "source": "/frames/:path*", "destination": "https://api.opendesign.example.com/frames/:path*" }
  ],
  "env": {
    "NEXT_PUBLIC_API_GATEWAY_URL": "@api_gateway_url"
  }
}
```

### 6.2 Docker Build — Frontend

```dockerfile
# apps/web/Dockerfile — [NEW]

# ── Stage 1: Build ──────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace root (for pnpm workspace packages)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/ packages/
COPY apps/web/ apps/web/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @open-design/web build

# ── Stage 2: Runtime ─────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
```

---

## 7. Electron Desktop — Điều chỉnh

Desktop Electron vẫn muốn "local-first" — bundle Go services trong app:

```
Electron App
├── main/ (Electron main process)
│   ├── launch-gateway.ts    ← [NEW] Start bundled Go gateway
│   ├── launch-services.ts   ← [NEW] Start bundled Go services
│   └── launcher.ts          ← [MODIFY] Remove daemon startup
│
└── bundled-binaries/
    ├── gateway              ← Go binary (cross-compiled)
    ├── project-service      ← Go binary
    ├── agent-service        ← Go binary
    └── ...
```

```typescript
// apps/desktop/src/main/launch-gateway.ts — [NEW]
import { spawn, ChildProcess } from 'child_process';
import path from 'path';

export async function launchGateway(options: {
  port: number;
  workspacePath: string;
}): Promise<ChildProcess> {
  const binaryPath = path.join(process.resourcesPath, 'gateway');
  return spawn(binaryPath, [], {
    env: {
      GATEWAY_PORT: String(options.port),
      PROJECT_SERVICE_URL: 'localhost:8081',
      AGENT_SERVICE_URL: 'localhost:8082',
      // ... other services
    },
    detached: false,
  });
}
```

---

## 8. Thay đổi Quan trọng trong `apps/web`

### 8.1 Loại bỏ "Daemon Live" check

Hiện tại `App.tsx` check `daemonIsLive()` trước khi load data. Sau migration, check đổi thành "API Gateway Live":

```typescript
// src/providers/registry.ts — MODIFY
export async function daemonIsLive(): Promise<boolean> {
  // Tên function giữ nguyên để tránh refactor lớn
  // Nhưng check /api/health của Go API Gateway
  try {
    const resp = await fetch('/api/health');
    return resp.ok;
  } catch {
    return false;
  }
}
```

### 8.2 Config Persistence — Chuyển sang Config Service

```typescript
// src/state/config.ts — Daemon-owned config fields

// TRƯỚC: gọi PUT /api/app-config → daemon lưu vào app-config.json
export async function syncConfigToDaemon(config: AppConfig): Promise<boolean> {
  const resp = await fetch('/api/app-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(extractDaemonConfig(config)),
  });
  return resp.ok;
}

// SAU: Endpoint giống nhau, nhưng Go Config Service xử lý
// (không thay đổi frontend code — API contract preserved)
```

### 8.3 Installation ID — Managed by Config Service

```typescript
// TRƯỚC: installationId lưu trong daemon's app-config.json
// SAU: Go Config Service quản lý, nhưng API endpoint /api/app-config giữ nguyên
```

---

## 9. Features Cần Xử lý Đặc biệt

### 9.1 Agent CLI Execution

Agent Service (Go) cần spawn CLI processes (`claude`, `codex`, `gemini`):

```go
// agent-service/internal/usecase/run_usecase.go
func (uc *RunUseCase) ExecuteRun(ctx context.Context, run *domain.Run) error {
    cmd := exec.CommandContext(ctx, run.AgentBin, run.AgentArgs...)
    cmd.Dir = run.ProjectPath  // cwd = project folder
    cmd.Env = append(os.Environ(), run.EnvVars...)
    
    stdout, _ := cmd.StdoutPipe()
    stderr, _ := cmd.StderrPipe()
    
    // Stream stdout → SSE events
    go uc.streamOutput(ctx, run.ID, stdout, "stdout")
    go uc.streamError(ctx, run.ID, stderr, "stderr")
    
    return cmd.Start()
}
```

### 9.2 MCP Server — Protocol Passthrough

MCP endpoint `/mcp/*` cần passthrough protocol đặc biệt:

```go
// gateway/internal/router/router.go
// MCP: passthrough to MCP Service (WebSocket or SSE)
e.Any("/mcp/*", r.mcp.Passthrough)
```

### 9.3 Plugin Sandbox

Plugin Service cần sandbox execution environment:

```go
// plugin-service: Dùng gVisor hoặc WASM sandbox
// Tương đương với apps/daemon/src/plugins/ logic
```

---

## 10. Risk Matrix

| Rủi ro | Xác suất | Ảnh hưởng | Chiến lược |
|--------|---------|----------|------------|
| Agent CLI spawning permissions | Trung bình | Cao | Test trên mọi OS sớm |
| Desktop bundled binary size | Trung bình | Trung bình | Cross-compile + strip debug symbols |
| Auth UX thay đổi (cần login) | Cao | Cao | Transparent auto-auth cho desktop |
| Plugin sandbox compatibility | Thấp | Cao | Test với existing plugins trước |
| Config migration (SQLite → PG) | Trung bình | Trung bình | One-time migration tool |
| SSE CORS headers | Thấp | Cao | E2E test cross-origin SSE early |

---

## 11. Success Criteria (Full Decoupled)

- [ ] `apps/web` deploy lên Vercel không cần daemon
- [ ] Go API Gateway là single entry point (port 7456)
- [ ] Tất cả 10 Go microservices hoạt động
- [ ] Daemon TypeScript được retired
- [ ] Electron Desktop vẫn hoạt động với bundled Go binaries
- [ ] SSE streaming hoạt động qua CORS
- [ ] Agent CLI execution (claude, codex, gemini) hoạt động
- [ ] MCP protocol endpoint hoạt động
- [ ] Plugin execution hoạt động
- [ ] Zero regression trong frontend UX
