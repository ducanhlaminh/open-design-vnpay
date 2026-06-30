# 07 — Connector & MCP Models

**Nguồn:** `packages/contracts/src/api/connectors.ts`, `packages/contracts/src/api/mcp.ts`

---

## Connector Models

### ConnectorStatus

```typescript
type ConnectorStatus = 'available' | 'connected' | 'error' | 'disabled';
```

### ConnectorTool Safety & Approval

```typescript
type ConnectorToolSideEffect = 'read' | 'write' | 'destructive' | 'unknown';
type ConnectorToolApproval = 'auto' | 'confirm' | 'disabled';
type ConnectorToolUseCase = 'personal_daily_digest';

interface ConnectorToolSafety {
  sideEffect: ConnectorToolSideEffect;
  approval: ConnectorToolApproval;
  reason: string;
}

interface ConnectorToolCuration {
  useCases?: ConnectorToolUseCase[];
  reason?: string;
}
```

### ConnectorToolDetail

```typescript
interface ConnectorToolDetail {
  name: string;
  title: string;
  description?: string;
  inputSchemaJson?: BoundedJsonObject;
  outputSchemaJson?: BoundedJsonObject;
  safety: ConnectorToolSafety;
  refreshEligible: boolean;
  curation?: ConnectorToolCuration;
}
```

### ConnectorDetail

```typescript
interface ConnectorDetail {
  id: string;
  name: string;
  provider: string;
  category: string;
  description?: string;
  status: ConnectorStatus;
  accountLabel?: string;
  tools: ConnectorToolDetail[];
  allowedToolNames?: string[];     // Runtime execution allowlist
  curatedToolNames?: string[];     // Static catalog subset
  toolCount?: number;
  toolsNextCursor?: string;
  toolsHasMore?: boolean;
  featuredToolNames?: string[];
  minimumApproval?: ConnectorToolApproval;
  lastError?: string;
  auth?: ConnectorAuthDetail;
}

interface ConnectorAuthDetail {
  provider: 'local' | 'none' | 'oauth' | 'composio';
  configured: boolean;
}
```

### ConnectorConnect Response

```typescript
interface ConnectorConnectResponse extends ConnectorDetailResponse {
  auth?: {
    kind: 'redirect_required' | 'pending' | 'connected';
    redirectUrl?: string;
    providerConnectionId?: string;
    expiresAt?: string;
  };
}
```

### ConnectorExecute

```typescript
interface ConnectorExecuteRequest {
  connectorId: string;
  toolName: string;
  input: BoundedJsonObject;
}

interface ConnectorExecuteResponse {
  ok: true;
  connectorId: string;
  accountLabel?: string;
  toolName: string;
  safety: ConnectorToolSafety;
  output: BoundedJsonValue;
  outputSummary?: string;
  providerExecutionId?: string;
  metadata?: BoundedJsonObject;
}
```

### ConnectorAuthConfigPrepare

Chuẩn bị auth config cho nhiều connectors cùng lúc (Composio):

```typescript
interface ConnectorAuthConfigPrepareRequest {
  connectorIds: string[];
}

type ConnectorAuthConfigPrepareResult =
  | { status: 'ready'; authConfigId: string }
  | { status: 'custom_required'; message: string }
  | { status: 'error'; message: string };

interface ConnectorAuthConfigPrepareResponse {
  results: Record<string, ConnectorAuthConfigPrepareResult>;
}
```

---

## Connector Memory Extraction

```typescript
interface ConnectorMemoryExtractionRequest {
  connectorIds?: string[];
  query?: string;
  projectId?: string | null;
  chatAgentId?: string | null;
  chatModel?: string | null;
}

interface ConnectorMemoryExtractionResult {
  connectorId: string;
  connectorName: string;
  accountLabel?: string;
  status: 'succeeded' | 'skipped' | 'failed';
  toolName?: string;
  toolTitle?: string;
  summary: string;
  error?: string;
}

interface ConnectorMemoryExtractionResponse {
  changed: MemoryEntrySummary[];
  attemptedLLM: boolean;
  connectors: ConnectorMemoryExtractionResult[];
  contextBytes: number;
}
```

---

## MCP Models

### McpTransport & Auth

```typescript
type McpTransport = 'stdio' | 'sse' | 'http';
type McpAuthMode = 'none' | 'oauth';
```

### McpServerConfig

Cấu hình một external MCP server:

```typescript
interface McpServerConfig {
  id: string;                  // Stable slug (lowercase, [a-z0-9-_])
  label?: string;              // UI display name
  templateId?: string;         // Template used to instantiate
  transport: McpTransport;
  enabled: boolean;
  authMode?: McpAuthMode;

  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;

  // sse / http
  url?: string;
  headers?: Record<string, string>;
}

interface McpConfig {
  servers: McpServerConfig[];
}
```

### McpTemplate

Built-in preset cho Settings UI:

```typescript
type McpTemplateCategory =
  | 'image-generation'
  | 'image-editing'
  | 'web-capture'
  | 'design-systems'
  | 'ui-components'
  | 'data-viz'
  | 'publishing'
  | 'utilities';

interface McpTemplateField {
  key: string;
  label?: string;
  required?: boolean;
  placeholder?: string;
  secret?: boolean;     // Password-style input
}

interface McpTemplate {
  id: string;
  label: string;
  description: string;
  transport: McpTransport;
  authMode?: McpAuthMode;
  category: McpTemplateCategory;
  homepage?: string;
  example?: string;     // Chat composer example prompt

  // stdio defaults
  command?: string;
  args?: string[];
  envFields?: McpTemplateField[];

  // sse / http defaults
  url?: string;
  headerFields?: McpTemplateField[];
}
```

---

## MCP OAuth Flow

### StartMcpOAuthRequest

```typescript
interface StartMcpOAuthRequest {
  serverId: string;    // id của McpServerConfig đã lưu
}

interface StartMcpOAuthResponse {
  authorizeUrl: string;   // User mở URL này trong tab mới
  state: string;          // Correlation id
  redirectUri: string;    // Registered redirect URI
}
```

### McpOAuthStatusResponse

```typescript
interface McpOAuthStatusResponse {
  connected: boolean;
  expiresAt?: number | null;   // Epoch ms, null = non-expiring token
  scope?: string | null;       // Space-separated scopes
  savedAt?: number;            // Epoch ms when token was saved
}
```

### McpOAuthPostMessage

Payload gửi từ OAuth callback page về opener:

```typescript
type McpOAuthPostMessage =
  | { type: 'mcp-oauth'; ok: true; serverId: string | null }
  | { type: 'mcp-oauth'; ok: false; message: string | null };
```

---

## BoundedJsonValue (shared type)

Type-safe JSON value với recursion bounds:

```typescript
type JsonPrimitive = string | number | boolean | null;

type BoundedJsonValue =
  | JsonPrimitive
  | BoundedJsonValue[]
  | { [key: string]: BoundedJsonValue };

interface BoundedJsonObject {
  [key: string]: BoundedJsonValue;
}
```
