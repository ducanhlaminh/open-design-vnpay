# DEV-08 — Memory Service: Tạo mới hoàn toàn

> **Chiến lược**: 🆕 **Tạo mới** — Không có codebase tương đương  
> **Spec tham chiếu**: `specs/services/08-memory-service.md`

---

## 1. Lý do Tạo Mới

Codebase hiện tại không có memory/embedding service. `preview-ai-agent` gọi AI APIs nhưng không có context persistence hay vector search.

---

## 2. Cấu trúc Thư mục (Tạo Mới)

```
services/memory-service/
├── cmd/
│   └── main.go
├── internal/
│   ├── domain/
│   │   ├── connector.go         ← MemoryConnector entity
│   │   ├── entry.go             ← MemoryEntry entity (content + embedding)
│   │   ├── errors.go
│   │   └── repository.go        ← Repository interfaces
│   │
│   ├── usecase/
│   │   ├── connector_usecase.go ← CreateConnector, GetConnector, GetForProject
│   │   ├── entry_usecase.go     ← AddEntry, DeleteEntry, ListEntries
│   │   └── search_usecase.go    ← SemanticSearch, GetRelevantContext
│   │
│   ├── infra/
│   │   ├── db/
│   │   │   ├── postgres.go      ← PostgreSQL + pgvector (production)
│   │   │   ├── sqlite.go        ← SQLite + sqlite-vec (local mode)
│   │   │   ├── connector_repo.go
│   │   │   └── entry_repo.go    ← vector search queries
│   │   └── embedding/
│   │       ├── embedder.go      ← Embedder interface
│   │       ├── openai_embed.go  ← OpenAI text-embedding-3-small
│   │       ├── ollama_embed.go  ← Ollama nomic-embed-text (local)
│   │       └── chunker.go       ← Text chunking utility
│   │
│   └── adapter/
│       ├── grpc/
│       │   └── handler.go
│       └── http/
│           └── health.go
│
├── api/proto/memory/v1/
│   └── memory.proto
├── migrations/
│   ├── 000001_create_connectors.up.sql
│   └── 000002_create_entries.up.sql
├── configs/
├── Dockerfile
└── go.mod
```

---

## 3. Domain Model

### 3.1 MemoryConnector

```go
// internal/domain/connector.go
type MemoryConnector struct {
    ID        string
    ProjectID string
    Kind      ConnectorKind    // "local" | "notion" | "github"
    Config    map[string]any   // connector-specific (endpoints, keys)
    CreatedAt time.Time
}

type ConnectorKind string
const (
    ConnectorKindLocal  ConnectorKind = "local"
    ConnectorKindNotion ConnectorKind = "notion"
    ConnectorKindGitHub ConnectorKind = "github"
)
```

### 3.2 MemoryEntry

```go
// internal/domain/entry.go
type MemoryEntry struct {
    ID          string
    ConnectorID string
    Content     string          // raw text content
    Embedding   []float32       // vector (1536-dim OpenAI / 768-dim Ollama)
    Metadata    map[string]any  // source, url, tags, chunk_index, etc.
    CreatedAt   time.Time
}

// Search result
type SearchResult struct {
    Entry *MemoryEntry
    Score float32   // cosine similarity (0-1)
}
```

### 3.3 Repository Interfaces

```go
// internal/domain/repository.go
type ConnectorRepository interface {
    Create(ctx context.Context, c *MemoryConnector) error
    GetByID(ctx context.Context, id string) (*MemoryConnector, error)
    GetByProjectID(ctx context.Context, projectID string) (*MemoryConnector, error)
    Delete(ctx context.Context, id string) error
}

type EntryRepository interface {
    Create(ctx context.Context, e *MemoryEntry) error
    Delete(ctx context.Context, id string) error
    List(ctx context.Context, connectorID string) ([]*MemoryEntry, error)
    // Vector search
    SearchSimilar(ctx context.Context, connectorID string, embedding []float32, topK int, minScore float32) ([]*SearchResult, error)
}
```

---

## 4. Embedder Interface

```go
// internal/infra/embedding/embedder.go
type Embedder interface {
    Embed(ctx context.Context, text string) ([]float32, error)
    Dimensions() int
    ModelName() string
}

// Local mode: Ollama (no external API needed)
// Production: OpenAI text-embedding-3-small
```

### 4.1 OpenAI Embedder

```go
// internal/infra/embedding/openai_embed.go
type OpenAIEmbedder struct {
    apiKey     string
    httpClient *http.Client
    model      string // "text-embedding-3-small" (1536-dim)
}

func (e *OpenAIEmbedder) Embed(ctx context.Context, text string) ([]float32, error) {
    // POST https://api.openai.com/v1/embeddings
    // Body: {"input": text, "model": "text-embedding-3-small"}
    // Return: data[0].embedding
}

func (e *OpenAIEmbedder) Dimensions() int { return 1536 }
```

### 4.2 Ollama Embedder (Local Mode)

```go
// internal/infra/embedding/ollama_embed.go
type OllamaEmbedder struct {
    baseURL string // http://localhost:11434
    model   string // "nomic-embed-text" (768-dim)
}

func (e *OllamaEmbedder) Embed(ctx context.Context, text string) ([]float32, error) {
    // POST http://localhost:11434/api/embeddings
    // Body: {"model": "nomic-embed-text", "prompt": text}
    // Return: embedding
}

func (e *OllamaEmbedder) Dimensions() int { return 768 }
```

---

## 5. Vector Search Queries

### 5.1 PostgreSQL + pgvector

```sql
-- Query: cosine similarity search
SELECT 
    id, connector_id, content, metadata, created_at,
    1 - (embedding <=> $1::vector) AS score
FROM memory_entries
WHERE connector_id = $2
    AND (1 - (embedding <=> $1::vector)) >= $3   -- min_score filter
ORDER BY embedding <=> $1::vector
LIMIT $4;
```

### 5.2 SQLite + sqlite-vec (Local Mode)

```go
// internal/infra/db/sqlite.go
// Sử dụng sqlite-vec extension cho vector operations
// go-sqlite-vec package

func (r *SQLiteEntryRepo) SearchSimilar(ctx context.Context, connectorID string, embedding []float32, topK int, minScore float32) ([]*SearchResult, error) {
    // Serialize embedding to binary
    embBytes := float32SliceToBytes(embedding)
    
    rows, err := r.db.QueryContext(ctx, `
        SELECT e.id, e.content, e.metadata, e.created_at,
               1 - vec_distance_cosine(e.embedding, ?) AS score
        FROM memory_entries e
        WHERE e.connector_id = ?
        ORDER BY vec_distance_cosine(e.embedding, ?)
        LIMIT ?
    `, embBytes, connectorID, embBytes, topK)
    // ...
}
```

---

## 6. AddEntry Use Case — With Chunking

```go
// usecase/entry_usecase.go
func (uc *EntryUseCase) AddEntry(ctx context.Context, req AddEntryRequest) ([]*domain.MemoryEntry, error) {
    // 1. Chunk long content (if > 512 tokens)
    chunks := uc.chunker.Chunk(req.Content, 512)

    entries := make([]*domain.MemoryEntry, 0, len(chunks))
    for i, chunk := range chunks {
        // 2. Get API key for embedder
        apiKey, _ := uc.configClient.GetSecret(ctx, "openai_api_key")

        // 3. Embed
        embedding, err := uc.embedder.Embed(ctx, chunk)
        if err != nil { return nil, err }

        // 4. Store
        entry := &domain.MemoryEntry{
            ID:          uuid.New().String(),
            ConnectorID: req.ConnectorID,
            Content:     chunk,
            Embedding:   embedding,
            Metadata: map[string]any{
                "chunk_index": i,
                "source":      req.Source,
            },
        }
        uc.entryRepo.Create(ctx, entry)
        entries = append(entries, entry)
    }
    return entries, nil
}
```

---

## 7. gRPC Protocol

```protobuf
// api/proto/memory/v1/memory.proto
syntax = "proto3";
package memory.v1;

service MemoryService {
    rpc CreateConnector(CreateConnectorRequest) returns (MemoryConnector);
    rpc GetConnector(GetConnectorRequest) returns (MemoryConnector);
    rpc GetConnectorForProject(GetConnectorForProjectRequest) returns (MemoryConnector);
    rpc DeleteConnector(DeleteConnectorRequest) returns (google.protobuf.Empty);

    rpc AddEntry(AddEntryRequest) returns (AddEntryResponse);
    rpc DeleteEntry(DeleteEntryRequest) returns (google.protobuf.Empty);
    rpc ListEntries(ListEntriesRequest) returns (ListEntriesResponse);

    rpc SemanticSearch(SemanticSearchRequest) returns (SemanticSearchResponse);
}

message AddEntryRequest {
    string connector_id = 1;
    string content = 2;
    bytes  metadata_json = 3;
    string source = 4;       // URL, filename, etc.
}

message SemanticSearchRequest {
    string connector_id = 1;
    string query = 2;        // text query (will be embedded)
    int32  top_k = 3;
    float  min_score = 4;    // 0.0 - 1.0
}

message SemanticSearchResponse {
    repeated SearchResult results = 1;
}

message SearchResult {
    string id = 1;
    string content = 2;
    float  score = 3;
    bytes  metadata_json = 4;
}
```

---

## 8. Database Schema

```sql
-- Production: PostgreSQL + pgvector
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memory_connectors (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    project_id  TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'local',
    config      JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id)    -- 1 connector per project (Phase 1)
);

CREATE TABLE memory_entries (
    id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    connector_id TEXT NOT NULL REFERENCES memory_connectors(id) ON DELETE CASCADE,
    content      TEXT NOT NULL,
    embedding    vector(1536),     -- OpenAI dim (or 768 for Ollama — configurable)
    metadata     JSONB NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HNSW index cho fast approximate search
CREATE INDEX idx_memory_entries_embedding
    ON memory_entries USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX idx_memory_entries_connector ON memory_entries(connector_id);
```

---

## 9. Environment Variables

```
MEMORY_SERVICE_GRPC_PORT=8087
DATABASE_URL=postgres://...?search_path=memory_svc
SQLITE_PATH=/data/memory.db          # local mode
EMBEDDING_PROVIDER=openai            # "openai" | "ollama"
EMBEDDING_MODEL=text-embedding-3-small
OLLAMA_BASE_URL=http://localhost:11434
CONFIG_SERVICE_ADDR=localhost:8089   # để lấy API keys
```

---

## 10. Acceptance Criteria

- [x] `CreateConnector` tạo connector cho project thành công
- [x] `AddEntry` chunk content, embed, và store vào PostgreSQL/SQLite
- [x] `SemanticSearch` trả về results theo cosine similarity
- [x] Local mode (SQLite + Ollama) hoạt động không cần PostgreSQL
- [x] Agent Service có thể gọi `SemanticSearch` để lấy relevant context
- [x] Delete cascade: xóa connector → xóa all entries

---

## 11. Effort Estimate

| Task | Estimate |
|------|---------|
| Project setup | 0.5 ngày |
| Domain model + interfaces | 1 ngày |
| OpenAI Embedder | 1 ngày |
| Ollama Embedder | 0.5 ngày |
| Text Chunker | 1 ngày |
| PostgreSQL + pgvector repo | 2 ngày |
| SQLite + sqlite-vec repo | 1.5 ngày |
| Use cases (3) | 2 ngày |
| gRPC server | 1 ngày |
| Tests | 2 ngày |
| **Tổng** | **12.5 ngày** |
