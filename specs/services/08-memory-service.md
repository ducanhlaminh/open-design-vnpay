# 08 — Memory Service

> **Port gRPC**: 8087  
> **Domain**: Context persistence, vector embedding, semantic search

---

## 1. Vai trò & Trách nhiệm

Thay thế `memory.ts` (~31KB):

- **Memory connectors**: Quản lý các nguồn memory (per-project)
- **Memory entries**: Lưu trữ context chunks (text, code, notes)
- **Vector embedding**: Embed entries sử dụng AI embedding models
- **Semantic search**: Tìm kiếm memory entries liên quan theo ngữ nghĩa
- **Context injection**: Cung cấp relevant context cho Agent Service

---

## 2. Cấu trúc thư mục

```
memory-service/
├── cmd/
│   └── main.go
├── internal/
│   ├── domain/
│   │   ├── connector.go          # MemoryConnector entity (per project)
│   │   ├── entry.go              # MemoryEntry entity (content + embedding)
│   │   └── repository.go
│   │
│   ├── usecase/
│   │   ├── connector_usecase.go  # CreateConnector, GetConnector
│   │   ├── entry_usecase.go      # AddEntry, DeleteEntry, ListEntries
│   │   └── search_usecase.go     # SemanticSearch, GetRelevantContext
│   │
│   ├── infra/
│   │   ├── db/
│   │   │   ├── connector_repo.go
│   │   │   └── entry_repo.go     # pgvector queries / sqlite-vec
│   │   └── embedding/
│   │       ├── openai_embed.go   # OpenAI text-embedding-3-small
│   │       ├── ollama_embed.go   # Ollama nomic-embed-text
│   │       └── google_embed.go   # Google Gemini embedding
│   │
│   └── delivery/
│       ├── grpc/
│       │   └── handler.go
│       └── http/
│           └── health.go
│
├── proto/
│   └── memory/v1/memory.proto
└── Dockerfile
```

---

## 3. Domain Model

```go
// domain/connector.go
type MemoryConnector struct {
    ID        string
    ProjectID string
    Kind      ConnectorKind    // "local" | "notion" | "github"
    Config    map[string]any   // connector-specific config
    CreatedAt time.Time
}

type ConnectorKind string
const (
    ConnectorKindLocal  ConnectorKind = "local"
    ConnectorKindNotion ConnectorKind = "notion"
    ConnectorKindGitHub ConnectorKind = "github"
)

// domain/entry.go
type MemoryEntry struct {
    ID          string
    ConnectorID string
    Content     string          // text content
    Embedding   []float32       // vector embedding (1536-dim for OpenAI)
    Metadata    map[string]any  // source, timestamp, tags, etc.
    CreatedAt   time.Time
}
```

---

## 4. Embedding Strategy

```go
// infra/embedding/openai_embed.go
type OpenAIEmbedder struct {
    client *openai.Client
    model  string // "text-embedding-3-small"
}

func (e *OpenAIEmbedder) Embed(ctx context.Context, text string) ([]float32, error) {
    resp, err := e.client.CreateEmbeddings(ctx, openai.EmbeddingRequest{
        Input: []string{text},
        Model: openai.AdaEmbeddingV2,
    })
    if err != nil { return nil, err }
    return resp.Data[0].Embedding, nil
}

// Chunking strategy: split long content into 512-token chunks
func ChunkContent(content string, maxTokens int) []string {
    // Simple sliding window chunking
    // Overlap 50 tokens for context continuity
}
```

---

## 5. Semantic Search

**Production** (PostgreSQL + pgvector):
```sql
-- Cosine similarity search
SELECT id, content, 1 - (embedding <=> $1::vector) AS score
FROM memory_entries
WHERE connector_id = $2
ORDER BY embedding <=> $1::vector
LIMIT $3;
```

**Local** (SQLite + sqlite-vec):
```sql
-- SQLite vector search via sqlite-vec extension
SELECT id, content, distance
FROM memory_entries
WHERE vec_distance_L2(embedding, vec_f32($1)) < $2
ORDER BY distance
LIMIT $3;
```

---

## 6. Context Injection Pattern

Agent Service gọi Memory Service để lấy relevant context trước khi spawn agent:

```go
// Gọi từ Agent Service trước khi spawn CLI
func (uc *StreamUseCase) PreparePrompt(ctx context.Context, run *Run, userPrompt string) (string, error) {
    // 1. Get memory connector for project
    connector, _ := uc.memoryClient.GetConnectorForProject(ctx, run.ProjectID)

    // 2. Search relevant entries
    entries, _ := uc.memoryClient.SemanticSearch(ctx, &memorypb.SearchRequest{
        ConnectorId: connector.ID,
        Query:       userPrompt,
        TopK:        5,
    })

    // 3. Build context block
    var contextBlocks []string
    for _, e := range entries {
        contextBlocks = append(contextBlocks, e.Content)
    }

    // 4. Prepend to system prompt
    return buildSystemPrompt(contextBlocks, userPrompt), nil
}
```

---

## 7. gRPC Protocol

```protobuf
syntax = "proto3";
package memory.v1;

service MemoryService {
    rpc CreateConnector(CreateConnectorRequest) returns (MemoryConnector);
    rpc GetConnector(GetConnectorRequest) returns (MemoryConnector);
    rpc GetConnectorForProject(GetConnectorForProjectRequest) returns (MemoryConnector);
    rpc DeleteConnector(DeleteConnectorRequest) returns (google.protobuf.Empty);

    rpc AddEntry(AddEntryRequest) returns (MemoryEntry);
    rpc DeleteEntry(DeleteEntryRequest) returns (google.protobuf.Empty);
    rpc ListEntries(ListEntriesRequest) returns (ListEntriesResponse);

    rpc SemanticSearch(SearchRequest) returns (SearchResponse);
}

message AddEntryRequest {
    string connector_id = 1;
    string content = 2;
    bytes  metadata_json = 3;
    // embedding generated internally
}

message SearchRequest {
    string connector_id = 1;
    string query = 2;
    int32  top_k = 3;
    float  min_score = 4;
}

message SearchResponse {
    repeated SearchResult results = 1;
}

message SearchResult {
    MemoryEntry entry = 1;
    float score = 2;
}
```

---

## 8. Database Schema

```sql
-- Production: PostgreSQL với pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memory_connectors (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    project_id  TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'local',
    config      JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE memory_entries (
    id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    connector_id TEXT NOT NULL REFERENCES memory_connectors(id) ON DELETE CASCADE,
    content      TEXT NOT NULL,
    embedding    vector(1536),   -- OpenAI text-embedding-3-small dimension
    metadata     JSONB NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Vector index cho cosine similarity search
CREATE INDEX idx_memory_entries_embedding
    ON memory_entries USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

CREATE INDEX idx_memory_entries_connector ON memory_entries(connector_id);
```
