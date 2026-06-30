# 10 — Config & Misc Models

**Nguồn:** `packages/contracts/src/api/app-config.ts`, `packages/contracts/src/api/connectionTest.ts`, `packages/contracts/src/api/context.ts`, `packages/contracts/src/api/handoff.ts`, `packages/contracts/src/api/finalize.ts`

---

## AppConfigPrefs (full)

Lưu trong `{dataDir}/config.json`:

```typescript
interface AgentModelPrefs {
  model?: string;
  reasoning?: string;
}

// Record<agentId, Record<envKey, value>>
type AgentCliEnvPrefs = Record<string, Record<string, string>>;

interface TelemetryPrefs {
  metrics?: boolean;            // Aggregate stats (default ON)
  content?: boolean;            // Prompts + artifacts (default ON)
  artifactManifest?: boolean;   // Artifact manifest (default OFF)
}

interface OrbitConfigPrefs {
  enabled: boolean;
  time: string;                 // 'HH:mm' local, default '08:00'
  templateSkillId?: string | null;
}

interface AppConfigPrefs {
  onboardingCompleted?: boolean;
  agentId?: string | null;
  agentModels?: Record<string, AgentModelPrefs>;
  agentCliEnv?: AgentCliEnvPrefs;
  skillId?: string | null;
  designSystemId?: string | null;
  disabledSkills?: string[];
  disabledDesignSystems?: string[];
  installationId?: string | null;
  telemetry?: TelemetryPrefs;
  privacyDecisionAt?: number | null;
  orbit?: OrbitConfigPrefs;
  customInstructions?: string | null;
}
```

---

## RunContextSelection

Selections được truyền trong ChatRequest để narrow context:

```typescript
// packages/contracts/src/api/context.ts
interface RunContextSelection {
  // TBD — forward-compat placeholder for per-turn context overrides
}
```

---

## Handoff Models

```typescript
// packages/contracts/src/api/handoff.ts

interface HandoffRequest {
  projectId: string;
  conversationId: string;
  targetSurface: string;
}

interface HandoffResponse {
  url: string;
  token: string;
}
```

---

## Finalize Models

```typescript
// packages/contracts/src/api/finalize.ts

type FinalizeAction =
  | 'export-html'
  | 'export-pdf'
  | 'deploy-vercel'
  | 'deploy-cloudflare'
  | 'save-template'
  | 'share';

interface FinalizeRequest {
  projectId: string;
  action: FinalizeAction;
  fileName?: string;
  providerId?: string;
}

interface FinalizeResponse {
  ok: boolean;
  url?: string;
  path?: string;
}
```

---

## ResearchOptions

Per-turn research options:

```typescript
// packages/contracts/src/api/research.ts

interface ResearchOptions {
  enabled?: boolean;
  query?: string;
  maxSources?: number;
}
```

---

## ProviderModels

```typescript
// packages/contracts/src/api/providerModels.ts

interface ProviderModel {
  id: string;
  name?: string;
  contextWindow?: number;
}

interface ProviderModelsResponse {
  models: ProviderModel[];
  provider: string;
}
```

---

## Common Utility Types

```typescript
// packages/contracts/src/common.ts

type JsonPrimitive = string | number | boolean | null;

type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

interface OkResponse {
  ok: true;
}
```

---

## SSRF Guard — URL Validation

Security validation cho BYOK API base URLs:

```typescript
// packages/contracts/src/api/connectionTest.ts

// Loopback hosts (allowed): localhost, ::1, 127.x.x.x
function isLoopbackApiHost(hostname: string): boolean;

// Blocked external IPs (SSRF protection):
// 0.0.0.0/8, 10.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12
// 192.168.0.0/16, 100.64.0.0/10, 224.0.0.0+
// IPv6 private (fc00::/7, fe80::/10)
function isBlockedExternalApiHostname(hostname: string): boolean;

interface BaseUrlValidationResult {
  parsed?: ParsedBaseUrl;
  error?: string;
  forbidden?: boolean;
}
```

**Rules:**
- `http://localhost:*` → Allowed (local Ollama, dev server)
- `https://api.openai.com` → Allowed
- `http://10.0.0.1` → BLOCKED (private network, SSRF risk)
- `http://192.168.1.1` → BLOCKED (LAN, SSRF risk)
- `http://169.254.169.254` → BLOCKED (AWS metadata endpoint)

---

## Version

```typescript
// packages/contracts/src/api/version.ts

interface VersionResponse {
  version: string;       // Daemon version string
}
```

---

## Analytics Models

```typescript
// packages/contracts/src/analytics/ (if exists)
// Tracking events sent to PostHog (server-side via daemon)
// Never tracked directly from browser to avoid ad-blockers
```

Key analytics events:
- `run_created` — khi user submit prompt
- `run_finished` — khi agent hoàn thành
- `artifact_exported` — khi user export
- `artifact_deployed` — khi user deploy
- `feedback_submitted` — khi user rate output

---

## Tổng hợp: Enum Values nhanh

### Status Enums

| Model | Status Values |
|-------|-------------|
| `ProjectDisplayStatus` | `not_started`, `queued`, `running`, `awaiting_input`, `succeeded`, `failed`, `canceled` |
| `ChatRunStatus` | `queued`, `running`, `succeeded`, `failed`, `canceled` |
| `RoutineRunStatus` | `queued`, `running`, `succeeded`, `failed`, `canceled` |
| `AutomationRunStatus` | `queued`, `running`, `needs-review`, `succeeded`, `failed`, `canceled` |
| `LiveArtifactRefreshStatus` | `never`, `idle`, `running`, `succeeded`, `failed` |
| `DeploymentStatus` | `deploying`, `preparing-link`, `ready`, `link-delayed`, `protected`, `failed` |
| `PreviewCommentStatus` | `open`, `attached`, `applying`, `needs_review`, `resolved`, `failed` |
| `DesignSystemRevisionStatus` | `pending`, `accepted`, `rejected` |

### Source/Kind Enums

| Model | Values |
|-------|--------|
| `ProjectKind` | `prototype`, `deck`, `template`, `other`, `image`, `video`, `audio` |
| `ArtifactKind` | `html`, `deck`, `react-component`, `markdown-document`, `svg`, `diagram`, `code-snippet`, `mini-app`, `design-system` |
| `MemoryType` | `user`, `feedback`, `project`, `reference` |
| `PluginSourceKind` | `bundled`, `user`, `project`, `marketplace`, `github`, `url`, `local` |
| `AutomationTriggerKind` | `manual`, `schedule`, `connector`, `project-event` |
| `ConnectorStatus` | `available`, `connected`, `error`, `disabled` |
| `McpTransport` | `stdio`, `sse`, `http` |
