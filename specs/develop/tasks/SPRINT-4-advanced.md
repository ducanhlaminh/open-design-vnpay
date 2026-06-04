# Sprint 4 — Advanced Features Tasks

> **Mục tiêu**: Plugin Service (Composio integration), Memory Service (vector search)  
> **Thời gian**: Tuần 8-10 | **Team**: Dev 1 (Plugin) + Dev 2 (Memory) song song

---

## T-4PL-01: Plugin Service — Project Setup + Domain {#t-4pl-01}

**Estimate**: 1.5 ngày | **Assignee**: Dev 1 | **Depends on**: T-1IN-01, T-1CF-04

### Bước thực hiện

```
[x] 1. Tạo services/plugin-service/ với go.mod (module: plugin-service)
[x] 2. Cấu trúc thư mục
[x] 3. Tạo internal/domain/plugin.go:
        type PluginKind string // "scenario" | "tool"
        type PluginInput struct { ID, Label, Type string; Required bool }
        type PluginTool struct { Name, Description string; InputSchema map[string]any }
        type PluginSpec struct { ID, Name, Description, Kind, Version, Author string; Inputs []PluginInput; Tools []PluginTool }
[x] 4. Tạo internal/domain/plugin_instance.go (trong plugin.go):
        type PluginInstance struct { ID, PluginID string; ConfigJSON map[string]any; InstalledAt time.Time }
[x] 5. Tạo internal/domain/composio.go:
        type ComposioApp struct { Name, DisplayName, Description string; LogoURL string; Categories []string }
        type ComposioTool struct { Slug, Name, Description string; InputSchema map[string]any }
        type ComposioConnector struct { ID, AppName, AccountID string; ApiKeyTail string; ToolsJSON []byte; CreatedAt time.Time }
[x] 6. Repository interfaces (trong domain files)
[x] 7. Tạo migrations/000001_create_od_plugins.up.sql
[x] 8. Implement Postgres repos (infra/db/repos.go)
[ ] 9. Dockerfile + Makefile
```

### Acceptance Criteria
- [x] Domain types compile
- [x] Migrations chạy clean
- [x] Repos: CRUD đầy đủ

---

## T-4PL-02: Plugin Service — Builtin Catalog Loader {#t-4pl-02}

**Estimate**: 1 ngày | **Assignee**: Dev 1 | **Depends on**: T-4PL-01

### Bước thực hiện

```
[x] 1. Tạo internal/infra/catalog/local_catalog.go:
        type LocalCatalogLoader struct { pluginsPath string; cache sync.Map }
        func (l *LocalCatalogLoader) LoadAll() ([]*domain.PluginSpec, error)
        func (l *LocalCatalogLoader) GetByID(id string) (*domain.PluginSpec, error)
[x] 2. Plugin YAML format (plugin.yaml) ✅
[x] 3. Tạo plugins/_official/ với 3 sample plugins:
        figma-export/ ✅, github-issues/ ✅, web-search/ ✅
[ ] 4. Unit tests với temp directory
[x] 5. Handle gracefully: missing plugins/ dir, invalid YAML
```

### Acceptance Criteria
- [x] `LoadAll()` trả về đúng số plugins
- [x] `GetByID("figma-export")` trả về PluginSpec với inputs + tools
- [x] Invalid plugin.yaml → skip (log warning)

---

## T-4PL-03: Plugin Service — Composio HTTP Client {#t-4pl-03}

**Estimate**: 2 ngày | **Assignee**: Dev 1 | **Depends on**: T-4PL-01

### Bước thực hiện

```
[x] 1. Tạo internal/infra/composio/composio_client.go:
        type ComposioClient struct { baseURL string; httpClient *http.Client }
        func NewComposioClient(baseURL string) *ComposioClient
[x] 2. Implement ListApps(apiKey)
[x] 3. Implement GetTools(apiKey, appName)
[x] 4. Implement ExecuteTool(apiKey, req)
[x] 5. Implement ConnectApp(apiKey, appName, redirectURL)
[x] 6. Retry logic: 3 retries on 5xx, exponential backoff
[ ] 7. Unit tests với httptest.Server mock (không call real Composio)
```

### Acceptance Criteria
- [x] `ListApps` parse response đúng
- [x] `ExecuteTool` send correct request body
- [x] 401 từ Composio → clear "invalid API key" error
- [x] 5xx → retry 3 lần với backoff

---

## T-4PL-04: Plugin Service — Subprocess Sandbox {#t-4pl-04}

**Estimate**: 1.5 ngày | **Assignee**: Dev 1 | **Depends on**: T-4PL-01

### Bước thực hiện

```
[x] 1. Tạo internal/infra/sandbox/subprocess_sandbox.go:
        type SubprocessSandbox struct { pluginsPath string; timeout time.Duration }
        func (s *SubprocessSandbox) Execute(ctx, pluginID, toolName string, input, secrets map[string]string) (map[string]any, error)
[x] 2. Execute flow:
        - Tìm plugin entry: pluginsPath/{pluginID}/tools/{toolName}.*  (.sh, .py, .js)
        - Build exec.CommandContext với timeout
        - Pass input qua stdin (JSON)
        - Pass secrets qua PLUGIN_SECRET_{KEY} env vars
        - Capture stdout (JSON output)
[x] 3. Security measures:
        - Whitelist file extensions (.sh, .py, .js only)
        - Plugin path: validate path traversal
        - Timeout default: 30s
[ ] 4. Unit tests: mock scripts, verify JSON parsing
[ ] 5. Integration test: hello world plugin script
```

### Acceptance Criteria
- [x] Shell script plugin thực thi và return JSON output
- [x] Timeout 30s → kill process + error
- [x] Unknown extension → clear error
- [x] Secrets không xuất hiện trong logs
- [x] Path traversal attempt → error

---

## T-4PL-05: Plugin Service — Use Cases + HTTP Server {#t-4pl-05}

**Estimate**: 2 ngày | **Assignee**: Dev 1 | **Depends on**: T-4PL-02, T-4PL-03, T-4PL-04

### Bước thực hiện

```
[x] 1. Tạo usecase/usecases.go:
        - RegistryUseCase: ListPlugins, GetPlugin
        - InstallUseCase: InstallPlugin, UninstallPlugin, ListInstalledPlugins
        - ExecuteUseCase: ExecuteTool (sandbox)
        - ComposioUseCase: ListApps, GetTools, ConnectApp, ExecuteComposioTool
[x] 2. Tạo internal/adapter/http/handler.go với 11 REST endpoints
[x] 3. Wire up cmd/main.go
[x] 4. Thêm plugin-service vào go.work
[ ] 5. Thêm vào docker-compose.local.yml
[ ] 6. E2E test: ListPlugins → InstallPlugin → ExecuteTool
```

### Acceptance Criteria
- [x] `ListPlugins` trả về 3 builtin plugins từ filesystem
- [x] `InstallPlugin` lưu instance với config
- [x] `ExecuteComposioTool` gọi Composio API với API key
- [x] HTTP server start trên port 8085
- [x] Build clean ✅

---

## T-4MM-01: Memory Service — Project Setup + Domain {#t-4mm-01}

**Estimate**: 1 ngày | **Assignee**: Dev 2 | **Depends on**: T-1IN-01, T-1CF-04

### Bước thực hiện

```
[x] 1. Tạo services/memory-service/ với go.mod (module: memory-service)
[x] 2. Cấu trúc thư mục đầy đủ
[x] 3. Tạo internal/domain/memory.go:
        type ConnectorKind string // "local" | "notion" | "github"
        type MemoryConnector struct { ID, ProjectID string; Kind ConnectorKind; Config map[string]any; CreatedAt time.Time }
[x] 4. Tạo MemoryEntry struct + SearchResult
[x] 5. Interfaces: ConnectorRepository + EntryRepository
[x] 6. go.mod dependencies:
        github.com/jackc/pgx/v5 ✅
        modernc.org/sqlite (CGO-free) ✅
```

### Acceptance Criteria
- [x] Domain types compile
- [x] go.mod đầy đủ dependencies

---

## T-4MM-02: Memory Service — OpenAI Embedder {#t-4mm-02}

**Estimate**: 1 ngày | **Assignee**: Dev 2 | **Depends on**: T-4MM-01

### Bước thực hiện

```
[x] 1. Tạo internal/infra/embedding/embedder.go (interface):
        type Embedder interface { Embed(text) ([]float32, error); Dimensions() int; ModelName() string }
[x] 2. Implement OpenAIEmbedder:
        POST https://api.openai.com/v1/embeddings
        Parse: data[0].embedding → []float32
        Dimensions: 1536
[x] 3. Error handling: 401 → invalid key, 429 → retry với backoff
[ ] 4. Unit tests với httptest.Server mock
```

### Acceptance Criteria
- [x] `Embed("Hello World")` → []float32 với len=1536
- [x] Rate limit → retry với backoff

---

## T-4MM-03: Memory Service — Ollama Embedder + Text Chunker {#t-4mm-03}

**Estimate**: 1.5 ngày | **Assignee**: Dev 2 | **Depends on**: T-4MM-01

### Bước thực hiện

```
[x] 1. Implement OllamaEmbedder:
        POST http://localhost:11434/api/embeddings
        Dimensions: 768
[x] 2. Tạo TextChunker:
        func (c *TextChunker) Chunk(text string) []string
        - Split bằng paragraph boundaries
        - Mỗi chunk ≤ maxTokens * 4 chars
        - Overlap: lấy N chars từ cuối chunk trước
[x] 3. Factory function NewEmbedder(provider, ...) (Embedder, error)
[ ] 4. Unit tests
```

### Acceptance Criteria
- [x] Ollama embedder: `Embed` → []float32 với len=768
- [x] Chunker: text 10000 chars với maxTokens=500 → multiple chunks
- [x] Overlap hoạt động

---

## T-4MM-04: Memory Service — PostgreSQL + pgvector Repository {#t-4mm-04}

**Estimate**: 2 ngày | **Assignee**: Dev 2 | **Depends on**: T-4MM-01

### Bước thực hiện

```
[x] 1. Tạo migrations/000001_create_schema.up.sql:
        - CREATE EXTENSION vector
        - memory_connectors + memory_entries tables
        - HNSW index (vector_cosine_ops, m=16, ef=64)
[x] 2. Implement PostgresConnectorRepo (pgx pool)
[x] 3. Implement PostgresEntryRepo:
        - Create: INSERT với embedding::vector
        - SearchSimilar: cosine similarity (embedding <=> operator)
        - float32SliceToVectorStr helper
[ ] 4. Integration tests với testcontainers
```

### Acceptance Criteria
- [x] Migrations: pgvector extension + tables
- [x] `Create` entry với embedding 1536-dim
- [x] `SearchSimilar` trả về results theo cosine similarity

---

## T-4MM-05: Memory Service — SQLite + pure-Go similarity {#t-4mm-05}

**Estimate**: 1.5 ngày | **Assignee**: Dev 2 | **Depends on**: T-4MM-01

### Bước thực hiện

```
[x] 1. Implement SQLiteConnectorRepo (modernc.org/sqlite — CGO-free)
[x] 2. Implement SQLiteEntryRepo:
        - serializeEmbedding: []float32 → little-endian []byte (BLOB)
        - deserializeEmbedding: []byte → []float32
        - cosineSimilarity: pure Go implementation
        - SearchSimilar: load all → sort → top-k (O(n), ok for <10k entries)
[x] 3. InitSQLite: create schema function
[x] 4. OpenSQLite helper (single writer)
[ ] 5. Unit tests với temp SQLite file
```

### Acceptance Criteria
- [x] SQLite CRUD operations thành công
- [x] `SearchSimilar` trả về results theo score
- [x] embed/deserialize roundtrip đúng

---

## T-4MM-06: Memory Service — Use Cases + HTTP Server {#t-4mm-06}

**Estimate**: 2 ngày | **Assignee**: Dev 2 | **Depends on**: T-4MM-02, T-4MM-03, T-4MM-04, T-4MM-05

### Bước thực hiện

```
[x] 1. Tạo usecase/usecases.go:
        - ConnectorUseCase: CreateConnector, GetConnectorForProject, DeleteConnector
        - EntryUseCase: AddEntry (chunk→embed→store), DeleteEntry, ListEntries
        - SearchUseCase: SemanticSearch (embed query→vector search)
[x] 2. Tạo usecase/ports.go (ConnectorRepoIface + EntryRepoIface)
[x] 3. Tạo adapter/http/handler.go:
        - POST/GET /api/v1/projects/:id/memory/connector
        - POST/GET/DELETE /api/v1/memory/connectors/:id/entries
        - POST /api/v1/memory/connectors/:id/search
[x] 4. Tạo cmd/main.go:
        - Mode detection: DATABASE_URL → Postgres; SQLITE_PATH → SQLite
        - EMBEDDING_PROVIDER: openai | ollama
[x] 5. Thêm memory-service vào go.work
[ ] 6. Thêm vào docker-compose.local.yml
[ ] 7. E2E test
```

### Acceptance Criteria
- [x] `AddEntry` → chunks + embedded + stored
- [x] `SemanticSearch` → returns results by score
- [x] Local mode (SQLite + Ollama) hoạt động offline
- [x] HTTP server trên port 8087

---

# Cross-Sprint: Integration Testing

## T-INT-01: End-to-End Happy Path Test {#t-int-01}

**Estimate**: 2 ngày | **Assignee**: Team | **Depends on**: Sprint 1-4 hoàn thành

```
[ ] 1. Docker Compose up toàn bộ stack
[ ] 2. Kiểm tra tất cả services healthy
[ ] 3. Test E2E flow (project → agent → skills → design systems → media → plugins → memory)
[ ] 4. Verify VNPay routes regression: 0 failures
[ ] 5. Performance: gateway p99 < 100ms cho non-streaming routes
[ ] 6. Memory leak check: 100 concurrent requests → no goroutine leak
```

### Acceptance Criteria
- [ ] Tất cả steps trong happy path pass
- [ ] VNPay routes regression: 0 failures
- [ ] No goroutine leaks (pprof check)

---

## T-INT-02: Docker Compose Local Dev Verification {#t-int-02}

**Estimate**: 1 ngày | **Assignee**: Dev 1

```
[ ] 1. `docker compose up --build` từ deploy/local/ → tất cả services start
[ ] 2. Wait for all health checks pass (max 2 phút)
[ ] 3. Run smoke test script
[ ] 4. Tạo deploy/local/smoke-test.sh
[ ] 5. Document `make run` → starts everything
[ ] 6. Document first-time setup (set API keys qua config-svc)
```

### Acceptance Criteria
- [ ] `docker compose up --build` thành công trong < 5 phút
- [ ] `smoke-test.sh` pass 100%
- [ ] README.md hướng dẫn quick start rõ ràng
