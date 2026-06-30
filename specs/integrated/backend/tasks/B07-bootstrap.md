# B-29..B-32 — Bootstrap & Wire-up

**Phase**: B5 | **Estimate**: ~4.5h | **Depends on**: B4 (handlers)

---

## B-29 — `design-system-svc/cmd/main.go`

**Target**: `services/design-system-svc/cmd/main.go`  
**Estimate**: 1.5h

```go
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	adapthttp "design-system-svc/internal/adapter/http"
	"design-system-svc/internal/infra/fs"
	"design-system-svc/internal/usecase"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

func main() {
	// ─── Logger ────────────────────────────────────────────
	logger, _ := zap.NewProduction()
	defer logger.Sync()
	logger.Info("design-system-svc starting...")

	// ─── Config ────────────────────────────────────────────
	httpPort    := getEnv("PORT", "8086")
	catalogPath := getEnv("DS_CATALOG_PATH", "./design-systems")
	ginMode     := getEnv("GIN_MODE", "debug")

	gin.SetMode(ginMode)

	// ─── Infrastructure ────────────────────────────────────
	loader     := fs.NewManifestLoader(catalogPath)
	fileServer := fs.NewDiskFileServer(loader)

	// Pre-warm catalog at startup
	logger.Info("loading design systems catalog...", zap.String("path", catalogPath))
	if err := loader.Reload(); err != nil {
		logger.Warn("catalog pre-load failed", zap.Error(err))
	} else {
		// Count loaded DS
		all, _ := loader.List("", "", "")
		logger.Info("catalog loaded", zap.Int("count", len(all)))
	}

	// ─── Use Cases ─────────────────────────────────────────
	catalogUC := usecase.NewCatalogUseCase(loader, fileServer)

	// ─── HTTP Server ───────────────────────────────────────
	r := gin.New()
	r.Use(gin.Recovery())

	handler := adapthttp.NewDSHandler(catalogUC, logger)
	handler.RegisterRoutes(r)

	srv := &http.Server{
		Addr:    ":" + httpPort,
		Handler: r,
	}

	// ─── Graceful Shutdown ─────────────────────────────────
	go func() {
		logger.Info("design-system-svc listening", zap.String("port", httpPort))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatal("listen error", zap.Error(err))
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	logger.Info("shutting down...")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("shutdown error", zap.Error(err))
	}
	logger.Info("design-system-svc stopped")
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// ensure fmt is used
var _ = fmt.Sprintf
```

**Test ngay sau khi tạo**:
```bash
cd services/design-system-svc
DS_CATALOG_PATH=../../ui/open-design-vnpay/design-systems go run ./cmd/main.go
# Expected: "catalog loaded count=152" (hoặc tương tự)
curl http://localhost:8086/health
# Expected: {"status":"ok","service":"design-system-svc"}
```

---

## B-30 — Cập nhật `skill-service/cmd/main.go`

**Target**: `services/skill-service/cmd/main.go`  
**Estimate**: 1h

Thêm wire-up cho `TemplateLoader` và `TemplateUseCase`. Dựa trên main.go hiện tại:

```go
// Thêm imports:
import (
    // ... existing imports ...
    "skill-service/internal/usecase"  // đã có
)

// Trong func main(), sau phần tạo loader và catalogUC:

// ─── Design Templates ──────────────────────────────────
templatesPath := getEnv("DESIGN_TEMPLATES_PATH", "./design-templates")
templateLoader := fs.NewTemplateLoader(templatesPath)

// Pre-warm templates cache
templates, err := templateLoader.LoadAll()  // hoặc List("","","")
if err != nil {
    logger.Warn("failed to pre-load design templates", zap.Error(err))
} else {
    logger.Info("design templates loaded", zap.Int("count", len(templates)))
}

templateUC := usecase.NewTemplateUseCase(templateLoader)

// ─── Handler (cập nhật để truyền templateUC) ───────────
handler := adapthttp.NewSkillHandler(catalogUC, templateUC, logger)  // thêm templateUC
```

> **Lưu ý**: `TemplateLoader` cần method `LoadAll() ([]*domain.DesignTemplate, error)` — thêm vào template_loader.go nếu chưa có (hoặc dùng `List("","","")` thay thế).

**Verify**: `cd services/skill-service && go build ./...`

---

## B-31 — Cập nhật `media-service/cmd/main.go`

**Target**: `services/media-service/cmd/main.go`  
**Estimate**: 1h

Thêm wire-up cho `PromptTemplateLoader` và `TemplateUseCase`:

```go
// Thêm imports:
import (
    // ... existing imports ...
    mediafs "media-service/internal/infra/fs"  // tách biệt với infra/db/fs nếu có conflict
)

// Trong func main(), sau phần tạo imageUC:

// ─── Prompt Templates ──────────────────────────────────
imagePTPath := getEnv("PROMPT_TEMPLATES_IMAGE_PATH", "./prompt-templates/image")
videoPTPath := getEnv("PROMPT_TEMPLATES_VIDEO_PATH", "./prompt-templates/video")
ptLoader    := mediafs.NewPromptTemplateLoader(imagePTPath, videoPTPath)

// Pre-warm
if err := ptLoader.Reload(); err != nil {
    logger.Warn("failed to pre-load prompt templates", zap.Error(err))
} else {
    all, _ := ptLoader.List("", "", "", "")
    logger.Info("prompt templates loaded", zap.Int("count", len(all)))
}

templateUC := usecase.NewTemplateUseCase(ptLoader, imageUC, logger)

// ─── Handler (cập nhật) ────────────────────────────────
handler := adapthttp.NewMediaHandler(imageUC, audioUC, jobUC, templateUC, logger)
```

> **Quan trọng**: Package `mediafs` (infra/fs) phải không conflict với package `db` (cũng trong infra/).  
> Nếu conflict: dùng import alias `mediafs "media-service/internal/infra/fs"`.

**Verify**: `cd services/media-service && go build ./...`

---

## B-32 — Verify `go build ./...` tất cả 3 services

**Estimate**: 1h

```bash
# 1. design-system-svc
cd /Users/binhnt/Work/blockchain/vnp-design-platform/services/design-system-svc
go build ./...
echo "design-system-svc: $?"

# 2. skill-service
cd /Users/binhnt/Work/blockchain/vnp-design-platform/services/skill-service
go build ./...
echo "skill-service: $?"

# 3. media-service
cd /Users/binhnt/Work/blockchain/vnp-design-platform/services/media-service
go build ./...
echo "media-service: $?"

# 4. Toàn bộ workspace (optional)
cd /Users/binhnt/Work/blockchain/vnp-design-platform/services
go build ./design-system-svc/... ./skill-service/... ./media-service/...
```

**Expected**: Tất cả exit code 0, không có compile error.

### Common errors và cách fix

| Error | Nguyên nhân | Fix |
|-------|-------------|-----|
| `undefined: usecase.NewTemplateUseCase` | Chưa tạo template_usecase.go | Tạo file B-20/B-21 |
| `too many arguments in call to NewSkillHandler` | Constructor chưa update | Cập nhật B-26 |
| `cannot use ptLoader (type *fs.PromptTemplateLoader) as type domain.PromptTemplateCatalog` | Loader chưa implement interface | Kiểm tra method signatures |
| `package fs: import cycle` | Import cycle giữa fs packages | Dùng import alias |

---

## Checklist B5

- [x] B-29: `design-system-svc/cmd/main.go` — graceful shutdown, pre-warm OK, `go build ./...` clean
- [x] B-30: `skill-service/cmd/main.go` — templateLoader wire-up, `go build ./...` clean
- [x] B-31: `media-service/cmd/main.go` — ptLoader wire-up, no import conflict
- [x] B-32: Tất cả 3 services `go build ./...` → exit 0 ✓
