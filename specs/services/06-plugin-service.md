# 06 — Plugin Service

> **Port gRPC**: 8085  
> **Domain**: Plugin registry, sandbox execution, Composio integration

---

## 1. Vai trò & Trách nhiệm

Thay thế plugin logic trong `server.ts` + `connectors/composio.ts` (~71KB):

- **Plugin registry**: Catalog official + community plugins
- **Plugin installation**: Install/uninstall plugins vào workspace
- **Plugin execution**: Sandbox execution của plugin tools
- **Composio integration**: Kết nối 100+ external services (GitHub, Notion, Slack, ...)
- **Plugin config**: Quản lý plugin inputs (API keys, settings)

---

## 2. Cấu trúc thư mục

```
plugin-service/
├── cmd/
│   └── main.go
├── internal/
│   ├── domain/
│   │   ├── plugin.go             # Plugin entity + spec
│   │   ├── plugin_instance.go    # Installed plugin instance
│   │   ├── plugin_tool.go        # Tool definition (MCP tool shape)
│   │   └── repository.go
│   │
│   ├── usecase/
│   │   ├── registry_usecase.go   # List/Get plugins from catalog
│   │   ├── install_usecase.go    # Install/uninstall plugin
│   │   ├── execute_usecase.go    # Execute plugin tool in sandbox
│   │   └── composio_usecase.go   # Composio connector management
│   │
│   ├── infra/
│   │   ├── db/
│   │   │   ├── plugin_repo.go
│   │   │   └── instance_repo.go
│   │   ├── registry/
│   │   │   ├── local_registry.go  # Built-in plugins từ disk
│   │   │   └── remote_registry.go # Remote registry fetch
│   │   ├── sandbox/
│   │   │   └── wasm_sandbox.go    # WASM-based plugin execution
│   │   └── composio/
│   │       └── composio_client.go # Composio API client
│   │
│   └── delivery/
│       ├── grpc/
│       │   └── handler.go
│       └── http/
│           └── health.go
│
├── proto/
│   └── plugin/v1/plugin.proto
└── Dockerfile
```

---

## 3. Plugin Spec (YAML)

```go
// domain/plugin.go
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
    ID    string `yaml:"id"`
    Label string `yaml:"label"`
    Type  string `yaml:"type"`   // "secret" | "text" | "select"
}

type PluginTool struct {
    Name        string `yaml:"name"`
    Description string `yaml:"description"`
    InputSchema map[string]any `yaml:"input_schema"`
}

type PluginKind string
const (
    PluginKindScenario PluginKind = "scenario"  // Prompt variant
    PluginKindTool     PluginKind = "tool"       // External tool integration
)
```

---

## 4. Sandbox Execution

Plugin tools chạy trong **WASM sandbox** (bảo mật, isolated):

```go
// infra/sandbox/wasm_sandbox.go
type WASMSandbox struct {
    runtime wazero.Runtime
}

func (s *WASMSandbox) Execute(ctx context.Context, pluginID, toolName string, input map[string]any) (map[string]any, error) {
    // 1. Load plugin WASM binary
    // 2. Instantiate module trong sandbox
    // 3. Call tool function
    // 4. Return result
    // Sandbox: no network, no FS access (unless explicitly granted)
}
```

---

## 5. Composio Integration

```go
// domain/plugin.go (special case)
type ComposioConnector struct {
    ID         string
    AppName    string  // "github" | "notion" | "slack" | ...
    AccountID  string
    APIKeyTail string  // last 4 chars only (security)
    Tools      []ComposioTool
    CreatedAt  time.Time
}

// infra/composio/composio_client.go
type ComposioClient struct {
    baseURL    string
    httpClient *http.Client
}

// Returns list of 100+ available apps
func (c *ComposioClient) ListApps(ctx context.Context, apiKey string) ([]*ComposioApp, error) {}

// Returns tool schemas for a connected app
func (c *ComposioClient) GetTools(ctx context.Context, apiKey, appName string) ([]*ComposioTool, error) {}

// Execute a Composio tool
func (c *ComposioClient) ExecuteTool(ctx context.Context, apiKey, toolName string, params map[string]any) (map[string]any, error) {}
```

---

## 6. gRPC Protocol

```protobuf
syntax = "proto3";
package plugin.v1;

service PluginService {
    rpc ListPlugins(ListPluginsRequest) returns (ListPluginsResponse);
    rpc GetPlugin(GetPluginRequest) returns (Plugin);
    rpc InstallPlugin(InstallPluginRequest) returns (PluginInstance);
    rpc UninstallPlugin(UninstallPluginRequest) returns (google.protobuf.Empty);
    rpc ListInstalledPlugins(ListInstalledRequest) returns (ListInstalledResponse);
    rpc ExecuteTool(ExecuteToolRequest) returns (ExecuteToolResponse);

    // Composio
    rpc ListComposioApps(ListComposioAppsRequest) returns (ListComposioAppsResponse);
    rpc ConnectComposioApp(ConnectComposioRequest) returns (ComposioConnector);
    rpc GetComposioTools(GetComposioToolsRequest) returns (GetComposioToolsResponse);
    rpc ExecuteComposioTool(ExecuteComposioToolRequest) returns (ExecuteComposioToolResponse);
}

message Plugin {
    string id = 1;
    string name = 2;
    string description = 3;
    string kind = 4;
    string version = 5;
    string author = 6;
    repeated PluginTool tools = 7;
    string source = 8; // "official" | "community"
}

message ExecuteToolRequest {
    string plugin_id = 1;
    string tool_name = 2;
    bytes  input_json = 3;
    map<string, string> secrets = 4; // injected from Config Service
}
```

---

## 7. Database Schema

```sql
CREATE TABLE plugins (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    kind        TEXT NOT NULL,
    version     TEXT,
    author      TEXT,
    spec_json   JSONB,
    source      TEXT DEFAULT 'community',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE plugin_instances (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    plugin_id   TEXT NOT NULL REFERENCES plugins(id),
    config_json JSONB DEFAULT '{}',  -- user-provided inputs (encrypted)
    installed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE composio_connectors (
    id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    app_name     TEXT NOT NULL,
    account_id   TEXT,
    api_key_tail TEXT,      -- last 4 chars only
    tools_json   JSONB,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
```
