# 07 — MCP Service

> **Port gRPC**: 8086  
> **Domain**: Model Context Protocol server, tool registration, token management

---

## 1. Vai trò & Trách nhiệm

Thay thế `mcp.ts` (~49KB) + `mcp-config.ts` (~56KB):

- **MCP Server**: Implement Model Context Protocol để coding agents bên ngoài tương tác với Open Design
- **Tool registration**: Đăng ký 15+ MCP tools
- **Authentication**: MCP bearer token management
- **Active context**: Track project/file context đang được active
- **Tool execution**: Dispatch tool calls đến đúng downstream service

---

## 2. Cấu trúc thư mục

```
mcp-service/
├── cmd/
│   └── main.go
├── internal/
│   ├── domain/
│   │   ├── mcp_token.go          # MCP token entity
│   │   ├── mcp_tool.go           # Tool definition + schema
│   │   ├── active_context.go     # Active project/file context
│   │   └── repository.go
│   │
│   ├── usecase/
│   │   ├── tool_usecase.go       # ListTools, ExecuteTool dispatch
│   │   ├── token_usecase.go      # CreateToken, ValidateToken, RevokeToken
│   │   └── context_usecase.go    # SetActiveContext, GetActiveContext
│   │
│   ├── infra/
│   │   ├── db/
│   │   │   ├── token_repo.go
│   │   │   └── context_repo.go
│   │   ├── tools/
│   │   │   ├── tool_registry.go       # Register all MCP tools
│   │   │   ├── get_active_context.go  # Tool: get_active_context
│   │   │   ├── create_project.go      # Tool: create_project
│   │   │   ├── run_design_skill.go    # Tool: run_design_skill
│   │   │   ├── get_live_artifact.go   # Tool: get_live_artifact
│   │   │   └── ... (15+ tools)
│   │   └── clients/
│   │       ├── project_client.go      # gRPC → Project Service
│   │       ├── agent_client.go        # gRPC → Agent Service
│   │       ├── skill_client.go        # gRPC → Skill Service
│   │       └── design_system_client.go
│   │
│   └── delivery/
│       ├── grpc/
│       │   └── handler.go
│       ├── mcp/
│       │   └── server.go         # MCP protocol HTTP handler (SSE-based)
│       └── http/
│           └── health.go
│
├── proto/
│   └── mcp/v1/mcp.proto
└── Dockerfile
```

---

## 3. MCP Protocol Implementation

MCP sử dụng **JSON-RPC 2.0 over HTTP + SSE** (theo spec của Anthropic):

```go
// delivery/mcp/server.go
type MCPServer struct {
    toolRegistry *ToolRegistry
    tokenUseCase *TokenUseCase
}

// POST /mcp  — JSON-RPC request
func (s *MCPServer) HandleRPC(c echo.Context) error {
    var req JSONRPCRequest
    json.NewDecoder(c.Request().Body).Decode(&req)

    // 1. Validate bearer token
    token := extractBearerToken(c.Request())
    if !s.tokenUseCase.Validate(token) {
        return c.JSON(401, JSONRPCError{Code: -32001, Message: "Unauthorized"})
    }

    // 2. Route to method handler
    switch req.Method {
    case "initialize":
        return s.handleInitialize(c, req)
    case "tools/list":
        return s.handleListTools(c, req)
    case "tools/call":
        return s.handleCallTool(c, req)
    }
}
```

---

## 4. MCP Tools Registered

```go
// infra/tools/tool_registry.go
var BuiltinTools = []MCPTool{
    {
        Name:        "get_active_context",
        Description: "Get the currently active project, conversation, and file context in Open Design",
        InputSchema: schema{},
    },
    {
        Name:        "create_project",
        Description: "Create a new design project in Open Design",
        InputSchema: schema{
            "name": {type: "string", required: true},
            "kind": {type: "string", enum: ["web-ui", "image", "video", "audio"]},
        },
    },
    {
        Name:        "run_design_skill",
        Description: "Execute a design skill with a prompt in the active project",
        InputSchema: schema{
            "skill_id": {type: "string", required: true},
            "prompt":   {type: "string", required: true},
        },
    },
    {
        Name:        "get_live_artifact",
        Description: "Get a live artifact's current data and preview",
        InputSchema: schema{
            "artifact_id": {type: "string", required: true},
        },
    },
    {
        Name:        "list_projects",
        Description: "List all projects in the workspace",
    },
    {
        Name:        "get_project_files",
        Description: "Get the file tree of a project",
        InputSchema: schema{
            "project_id": {type: "string", required: true},
        },
    },
    {
        Name:        "read_file",
        Description: "Read the content of a file in a project",
        InputSchema: schema{
            "project_id": {type: "string", required: true},
            "path":       {type: "string", required: true},
        },
    },
    {
        Name:        "list_design_systems",
        Description: "List available design systems",
    },
    {
        Name:        "get_design_system_context",
        Description: "Get the CSS tokens and guidelines for a design system",
        InputSchema: schema{
            "design_system_id": {type: "string", required: true},
        },
    },
    {
        Name:        "list_skills",
        Description: "List available design skills",
    },
    // ... 5+ more tools
}
```

---

## 5. Token Management

```go
// domain/mcp_token.go
type MCPToken struct {
    ID        string
    TokenHash string   // bcrypt hash of the actual token
    Scope     string   // "read" | "write" | "admin"
    CreatedAt time.Time
    ExpiresAt *time.Time
}

// usecase/token_usecase.go
func (uc *TokenUseCase) CreateToken(ctx context.Context, scope string) (string, error) {
    rawToken := generateSecureToken(32) // crypto/rand
    hash, _ := bcrypt.GenerateFromPassword([]byte(rawToken), 12)
    uc.repo.Save(&MCPToken{
        ID:        uuid.New().String(),
        TokenHash: string(hash),
        Scope:     scope,
    })
    return rawToken, nil // return only once, never again
}

func (uc *TokenUseCase) ValidateToken(ctx context.Context, rawToken string) (*MCPToken, error) {
    // Fetch all tokens, check bcrypt.CompareHashAndPassword
    // Return token if valid
}
```

---

## 6. Active Context

```go
// domain/active_context.go
type ActiveContext struct {
    ProjectID      string
    ConversationID string
    FilePath       string
    UpdatedAt      time.Time
}

// usecase/context_usecase.go
// POST /api/active (from Gateway)
func (uc *ContextUseCase) SetActiveContext(ctx context.Context, req SetActiveContextRequest) error {
    // Update in-memory + persist to DB
}

// MCP tool: get_active_context
func (uc *ContextUseCase) GetActiveContext(ctx context.Context) (*ActiveContext, error) {
    // Return current active context
    // Used by coding agents in external projects to find what's open in Open Design
}
```

---

## 7. gRPC Protocol

```protobuf
syntax = "proto3";
package mcp.v1;

service McpService {
    rpc CreateToken(CreateTokenRequest) returns (CreateTokenResponse);
    rpc ValidateToken(ValidateTokenRequest) returns (ValidateTokenResponse);
    rpc RevokeToken(RevokeTokenRequest) returns (google.protobuf.Empty);
    rpc ListTokens(ListTokensRequest) returns (ListTokensResponse);

    rpc SetActiveContext(SetActiveContextRequest) returns (google.protobuf.Empty);
    rpc GetActiveContext(GetActiveContextRequest) returns (ActiveContext);

    rpc ListTools(ListToolsRequest) returns (ListToolsResponse);
    rpc ExecuteTool(ExecuteToolRequest) returns (ExecuteToolResponse);
}

message ActiveContext {
    string project_id = 1;
    string conversation_id = 2;
    string file_path = 3;
    google.protobuf.Timestamp updated_at = 4;
}

message ExecuteToolRequest {
    string tool_name = 1;
    bytes  input_json = 2;
    string token = 3;
}

message ExecuteToolResponse {
    bytes result_json = 1;
    bool  is_error = 2;
}
```

---

## 8. Database Schema

```sql
CREATE TABLE mcp_tokens (
    id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    token_hash TEXT NOT NULL,   -- bcrypt hash
    scope      TEXT NOT NULL DEFAULT 'write',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);

CREATE TABLE mcp_active_context (
    id              INTEGER PRIMARY KEY DEFAULT 1,  -- singleton row
    project_id      TEXT,
    conversation_id TEXT,
    file_path       TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```
