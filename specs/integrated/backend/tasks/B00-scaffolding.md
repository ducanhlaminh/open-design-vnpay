# B-01..B-04 — Scaffolding: `design-system-svc`

**Phase**: B0 | **Estimate**: ~2h | **Depends on**: nothing

---

## B-01 — Tạo cấu trúc thư mục

**Target**: `services/design-system-svc/`

```bash
mkdir -p services/design-system-svc/cmd
mkdir -p services/design-system-svc/internal/domain
mkdir -p services/design-system-svc/internal/usecase
mkdir -p services/design-system-svc/internal/infra/fs
mkdir -p services/design-system-svc/internal/adapter/http
```

**Kết quả mong đợi**:
```
services/design-system-svc/
├── cmd/
├── internal/
│   ├── domain/
│   ├── usecase/
│   ├── infra/
│   │   └── fs/
│   └── adapter/
│       └── http/
```

**Verify**: `ls -la services/design-system-svc/internal/`

---

## B-02 — Tạo `go.mod`

**Target**: `services/design-system-svc/go.mod`

```bash
cd services/design-system-svc && go mod init design-system-svc
```

**Nội dung file sau khi init + thêm dependencies thủ công**:

```go
module design-system-svc

go 1.22.0

require (
    github.com/gin-gonic/gin v1.10.0
    go.uber.org/zap v1.27.0
)
```

Chạy để resolve dependencies:
```bash
cd services/design-system-svc && go mod tidy
```

**Verify**: `cat services/design-system-svc/go.mod`

---

## B-03 — Thêm vào `go.work`

**Target**: `services/go.work`

Hiện tại file có comment `// use ./design-system-svc` — uncomment và kích hoạt:

```bash
cd services && go work edit -use ./design-system-svc
```

**Hoặc** sửa thủ công `services/go.work`:

```diff
 // ─── New Open Design services ───────────────────────────────────────────────
 use ./config-service
-// use ./design-system-svc
+use ./design-system-svc
 use ./plugin-service
```

**Verify**: `go work sync` từ `services/`

---

## B-04 — Tạo `Dockerfile`

**Target**: `services/design-system-svc/Dockerfile`

```dockerfile
# ── Build stage ─────────────────────────────────────────────────────────────
FROM golang:1.22-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache git

# Copy go.mod first for layer caching
COPY go.mod go.sum* ./
RUN go mod download

# Copy source
COPY . .

# Build binary
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o design-system-svc ./cmd/main.go

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM alpine:3.19

# Install ca-certs for HTTPS calls (future use)
RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/design-system-svc .

# Catalog directory — will be mounted from host
RUN mkdir -p /catalog

EXPOSE 8086

ENV DS_CATALOG_PATH=/catalog
ENV GIN_MODE=release
ENV PORT=8086

CMD ["./design-system-svc"]
```

**Verify**: `docker build -t design-system-svc:test services/design-system-svc/` (sau khi có source)

---

## Checklist B0

- [x] B-01: `services/design-system-svc/` directory tree tạo xong
- [x] B-02: `go.mod` với `module design-system-svc` + dependencies
- [x] B-03: `go.work` có `use ./design-system-svc` (uncommented)
- [x] B-04: `Dockerfile` multi-stage tạo xong
