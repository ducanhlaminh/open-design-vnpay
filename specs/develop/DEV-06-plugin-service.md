# DEV-06 — Plugin Service: Tái sử dụng một phần từ `prompt-registry-service`

> **Chiến lược**: 🔄 **Tái sử dụng một phần** — `prompt-registry-service` cung cấp pattern cho registry  
> **Nguồn**: `services/prompt-registry-service/` (partial)  
> **Spec tham chiếu**: `specs/services/06-plugin-service.md`

---

## 1. Phân tích Codebase Hiện có

### 1.1 `prompt-registry-service` — Phần Tái Sử Dụng

```
internal/
├── domain/          ← Prompt entity, versioning
├── handler/         ← HTTP handlers (CRUD + activation)
├── infra/           ← Postgres, filesystem
├── repo/            ← Repository layer
└── service/         ← Business logic
```

**Tương đồng với Plugin Service:**
- Cả hai đều là **registry** (danh mục có versioning)
- Cả hai cần **CRUD + activation/deactivation**
- Database pattern (id, key, version, content, active, created_at) tái sử dụng được

**Khác nhau:**
- Plugin Service còn cần: sandbox execution, Composio integration
- Prompt Registry chỉ là key-value store cho prompts

### 1.2 Gateway Proxy Hiện Có

`preview-gateway` đã có `prompt_registry_proxy_handler.go` routing `/api/v1/admin/prompts/*` đến `prompt-registry-service`. Cần **không phá vỡ** route này.

---

## 2. Chiến lược: Plugin Service Mới + Giữ Prompt Registry

```
services/
├── prompt-registry-service/    ← GIỮ NGUYÊN (không chạm)
└── plugin-service/             ← TẠO MỚI (tham khảo pattern từ prompt-registry)
```

---

## 3. Cấu trúc Plugin Service (Mới)

```
services/plugin-service/
├── cmd/
│   └── main.go
├── internal/
│   ├── domain/
│   │   ├── plugin.go            ← Plugin entity + PluginSpec (YAML)
│   │   ├── plugin_instance.go   ← Installed plugin instance
│   │   ├── composio.go          ← Composio connector entity
│   │   └── repository.go
│   │
│   ├── usecase/
│   │   ├── registry_usecase.go  ← ListPlugins, GetPlugin (từ catalog)
│   │   ├── install_usecase.go   ← InstallPlugin, UninstallPlugin
│   │   ├── execute_usecase.go   ← ExecuteTool (sandbox)
│   │   └── composio_usecase.go  ← ConnectApp, GetTools, ExecuteComposioTool
│   │
│   ├── infra/
│   │   ├── db/
│   │   │   ├── postgres.go
│   │   │   ├── plugin_repo.go
│   │   │   ├── instance_repo.go
│   │   │   └── composio_repo.go
│   │   ├── catalog/
│   │   │   └── local_catalog.go ← Load built-in plugins từ filesystem
│   │   ├── composio/
│   │   │   └── composio_client.go ← Composio API client (tham khảo prompt-registry HTTP client pattern)
│   │   └── sandbox/
│   │       └── subprocess_sandbox.go ← Plugin execution (Phase 1: subprocess, Phase 2: WASM)
│   │
│   └── adapter/
│       ├── grpc/
│       │   └── handler.go
│       └── http/
│           └── health.go
│
├── api/proto/plugin/v1/
│   └── plugin.proto
├── migrations/
├── configs/
├── Dockerfile
└── go.mod
```

---

## 4. Plugin Spec — Từ YAML

```go
// internal/domain/plugin.go
type PluginSpec struct {
    ID          string        `yaml:"id"`
    Name        string        `yaml:"name"`
    Description string        `yaml:"description"`
    Kind        PluginKind    `yaml:"kind"`    // "scenario" | "tool"
    Version     string        `yaml:"version"`
    Author      string        `yaml:"author"`
    Inputs      []PluginInput `yaml:"inputs"`
    Tools       []PluginTool  `yaml:"tools"`
}

type PluginInput struct {
    ID       string `yaml:"id"`
    Label    string `yaml:"label"`
    Type     string `yaml:"type"`    // "secret" | "text" | "select"
    Required bool   `yaml:"required"`
}

type PluginTool struct {
    Name        string         `yaml:"name"`
    Description string         `yaml:"description"`
    InputSchema map[string]any `yaml:"input_schema"`
}

// Installed instance (per user/workspace)
type PluginInstance struct {
    ID         string
    PluginID   string
    ConfigJSON map[string]any // user-provided inputs (secrets encrypted)
    InstalledAt time.Time
}
```

---

## 5. Composio Integration

Tham khảo pattern từ `preview-mcp/client/` (HTTP client pattern):

```go
// internal/infra/composio/composio_client.go
type ComposioClient struct {
    baseURL    string
    httpClient *http.Client
}

// List 100+ available apps
func (c *ComposioClient) ListApps(ctx context.Context, apiKey string) ([]*ComposioApp, error) {
    // GET https://backend.composio.dev/api/v1/apps
}

// Get tools for a connected app
func (c *ComposioClient) GetTools(ctx context.Context, apiKey, appName string) ([]*ComposioTool, error) {
    // GET https://backend.composio.dev/api/v1/actions?apps={appName}
}

// Execute a Composio tool
func (c *ComposioClient) ExecuteTool(ctx context.Context, apiKey, actionName string, params map[string]any) (map[string]any, error) {
    // POST https://backend.composio.dev/api/v1/actions/{actionName}/execute
}
```

---

## 6. Plugin Execution (Sandbox)

**Phase 1**: Subprocess execution (đơn giản, an toàn trong localhost context):

```go
// internal/infra/sandbox/subprocess_sandbox.go
type SubprocessSandbox struct {
    pluginsPath string
    timeout     time.Duration
}

func (s *SubprocessSandbox) Execute(ctx context.Context, pluginID, toolName string, input map[string]any, secrets map[string]string) (map[string]any, error) {
    // Tìm plugin binary hoặc script
    // Spawn subprocess với input qua stdin
    // Đọc output từ stdout (JSON)
    // Timeout sau s.timeout
}
```

**Phase 2** (future): WASM sandbox với `wazero`.

---

## 7. Plugin Catalog (Built-in)

```
plugins/                  ← mount từ monorepo
├── _official/
│   ├── github-integration/
│   │   ├── plugin.yaml
│   │   └── tools/
│   │       └── create_issue.sh
│   ├── notion-integration/
│   │   └── plugin.yaml
│   └── ...
└── community/
    └── ...
```

---

## 8. gRPC Protocol

```protobuf
service PluginService {
    rpc ListPlugins(ListPluginsRequest) returns (ListPluginsResponse);
    rpc GetPlugin(GetPluginRequest) returns (Plugin);
    rpc InstallPlugin(InstallPluginRequest) returns (PluginInstance);
    rpc UninstallPlugin(UninstallRequest) returns (google.protobuf.Empty);
    rpc ListInstalledPlugins(Empty) returns (ListInstalledResponse);
    rpc ExecuteTool(ExecuteToolRequest) returns (ExecuteToolResponse);

    // Composio
    rpc ListComposioApps(ListComposioAppsRequest) returns (ListComposioAppsResponse);
    rpc ConnectComposioApp(ConnectComposioRequest) returns (ComposioConnector);
    rpc GetComposioConnectors(Empty) returns (GetComposioConnectorsResponse);
    rpc GetComposioTools(GetComposioToolsRequest) returns (GetComposioToolsResponse);
    rpc ExecuteComposioTool(ExecuteComposioToolRequest) returns (ExecuteComposioToolResponse);
}
```

---

## 9. Database Schema

```sql
CREATE TABLE od_plugins (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    kind        TEXT NOT NULL DEFAULT 'tool',
    version     TEXT,
    author      TEXT,
    spec_json   JSONB,
    source      TEXT NOT NULL DEFAULT 'community',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE od_plugin_instances (
    id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    plugin_id     TEXT NOT NULL REFERENCES od_plugins(id),
    config_json   JSONB DEFAULT '{}',
    installed_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE od_composio_connectors (
    id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    app_name     TEXT NOT NULL,
    account_id   TEXT,
    api_key_tail TEXT,
    tools_json   JSONB,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 10. Không Thay đổi

- ✅ `prompt-registry-service` giữ nguyên
- ✅ `/api/v1/admin/prompts/*` routes giữ nguyên
- ✅ Gateway proxy handler `prompt_registry_proxy_handler.go` giữ nguyên

---

## 11. Effort Estimate

| Task | Estimate |
|------|---------|
| Project setup + go.mod | 0.5 ngày |
| Domain model (Plugin, Instance, Composio) | 1 ngày |
| Use cases (4) | 2 ngày |
| Postgres repos | 1.5 ngày |
| Composio HTTP client | 2 ngày |
| Subprocess sandbox | 1.5 ngày |
| Built-in catalog loader | 1 ngày |
| gRPC server | 1 ngày |
| Tests | 2 ngày |
| **Tổng** | **13.5 ngày** |

---

## 8. Acceptance Criteria

- [x] `GET /api/v1/plugins` trả về builtin plugin catalog
- [x] `POST /api/v1/plugins/install` cài Composio plugin thành công
- [x] `POST /api/v1/plugins/:id/execute` thực thi tool qua subprocess sandbox
- [x] Composio HTTP client gọi được API với API key
- [x] Subprocess sandbox whitelist + timeout
- [x] Plugin manifest YAML được load từ plugins/_official/
- [x] Postgres persistence cho installed plugins
- [x] Docker build + docker-compose.yaml thêm plugin-service profile
- [ ] Thêm plugin Figma Export thực tế (Phase 2)
- [ ] Plugin marketplace UI integration (Phase 2)
