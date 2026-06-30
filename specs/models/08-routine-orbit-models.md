# 08 — Routine & Orbit Models

**Nguồn:** `packages/contracts/src/api/routines.ts`, `packages/contracts/src/api/app-config.ts`

---

## RoutineScheduleKind

```typescript
type RoutineScheduleKind = 'hourly' | 'daily' | 'weekdays' | 'weekly';
```

---

## RoutineSchedule (Union)

```typescript
// Fires every hour at a fixed minute
interface RoutineHourlySchedule {
  kind: 'hourly';
  minute: number;       // 0-59 (UTC)
}

// Fires once a day at HH:MM
interface RoutineDailySchedule {
  kind: 'daily';
  time: string;         // '24h HH:MM'
  timezone: string;     // IANA, e.g. 'Asia/Ho_Chi_Minh'
}

// Fires Mon-Fri at HH:MM
interface RoutineWeekdaysSchedule {
  kind: 'weekdays';
  time: string;
  timezone: string;
}

// Fires once a week at HH:MM on a weekday
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;   // Sunday=0

interface RoutineWeeklySchedule {
  kind: 'weekly';
  time: string;
  timezone: string;
  weekday: Weekday;
}

type RoutineSchedule =
  | RoutineHourlySchedule
  | RoutineDailySchedule
  | RoutineWeekdaysSchedule
  | RoutineWeeklySchedule;
```

---

## RoutineProjectTarget

```typescript
type RoutineProjectMode = 'create_each_run' | 'reuse';

// Tạo project mới mỗi lần chạy
interface RoutineCreateEachRunTarget {
  mode: 'create_each_run';
}

// Reuse một project cố định
interface RoutineReuseProjectTarget {
  mode: 'reuse';
  projectId: string;
}

type RoutineProjectTarget =
  | RoutineCreateEachRunTarget
  | RoutineReuseProjectTarget;
```

---

## Routine

```typescript
type RoutineRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
type RoutineRunTrigger = 'manual' | 'scheduled';

interface RoutineLastRunSummary {
  runId: string;
  status: RoutineRunStatus;
  trigger: RoutineRunTrigger;
  startedAt: number;
  completedAt?: number;
  projectId: string;
  conversationId: string;
  agentRunId: string;
  summary?: string;
  error?: string;
  errorCode?: string;
}

interface Routine {
  id: string;
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  target: RoutineProjectTarget;
  skillId: string | null;
  agentId: string | null;
  context?: RunContextSelection;
  enabled: boolean;
  nextRunAt: number | null;     // Unix ms of next scheduled run
  lastRun: RoutineLastRunSummary | null;
  createdAt: number;
  updatedAt: number;
}
```

---

## RoutineRun

Mỗi lần routine được thực thi:

```typescript
interface RoutineRun {
  id: string;
  routineId: string;
  trigger: RoutineRunTrigger;
  status: RoutineRunStatus;
  projectId: string;
  conversationId: string;
  agentRunId: string;
  startedAt: number;
  completedAt: number | null;
  summary: string | null;
  error: string | null;
  errorCode: string | null;
}
```

---

## CreateRoutineRequest

```typescript
interface CreateRoutineRequest {
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  target: RoutineProjectTarget;
  skillId?: string | null;
  agentId?: string | null;
  context?: RunContextSelection;
  enabled?: boolean;
}
```

---

## RoutineRunCrystallizeResponse

Khi một routine run kết thúc và được "crystallize" thành automation packet:

```typescript
interface RoutineRunCrystallizeResponse extends AutomationSourceIngestionResponse {
  routineId: string;
  runId: string;
}
```

---

## OrbitConfig

Daily activity digest (đặc biệt routine):

```typescript
interface OrbitConfigPrefs {
  enabled: boolean;
  time: string;             // Local 24h 'HH:mm'. Default: '08:00'
  templateSkillId?: string | null;
}
```

**Behavior:**
- Chạy mỗi ngày vào `time` theo local timezone
- Tổng hợp data từ connectors
- Tạo project mới với digest
- Không chạy nếu không có connector data

---

## AppConfigPrefs

Toàn bộ user preferences:

```typescript
interface AgentModelPrefs {
  model?: string;
  reasoning?: string;
}

type AgentCliEnvPrefs = Record<string, Record<string, string>>;

interface TelemetryPrefs {
  metrics?: boolean;          // Aggregate usage stats (default: true)
  content?: boolean;          // Prompts & artifacts (default: true)
  artifactManifest?: boolean; // Artifact manifest (default: false)
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
  privacyDecisionAt?: number | null;   // Unix ms của lần đầu user consent
  orbit?: OrbitConfigPrefs;
  customInstructions?: string | null;
}
```

---

## ConnectionTest Models

```typescript
type ConnectionTestKind =
  | 'success'
  | 'auth_failed'
  | 'forbidden'
  | 'not_found_model'
  | 'invalid_model_id'
  | 'invalid_base_url'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'timeout'
  | 'agent_not_installed'
  | 'agent_auth_required'
  | 'agent_spawn_failed'
  | 'unknown';

type ConnectionTestProtocol = 'anthropic' | 'openai' | 'azure' | 'google' | 'ollama' | 'senseaudio';

interface ProviderTestRequest {
  protocol: ConnectionTestProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiVersion?: string;   // Azure only
}

interface AgentTestRequest {
  agentId: string;
  model?: string;
  reasoning?: string;
  agentCliEnv?: AgentCliEnvPrefs;
}

type ConnectionTestRequest =
  | ({ mode: 'provider' } & ProviderTestRequest)
  | ({ mode: 'agent' } & AgentTestRequest);

interface ConnectionTestResponse {
  ok: boolean;
  kind: ConnectionTestKind;
  latencyMs: number;
  model?: string;
  sample?: string;           // Truncated assistant reply (≤120 chars)
  status?: number;           // HTTP status (provider tests)
  agentName?: string;
  detail?: string;
  configuredExecutablePath?: string;
  detectedExecutablePath?: string;
  usedExecutablePath?: string;
  usedExecutableSource?: 'configured' | 'path' | 'fallback_invalid' | 'fallback_failed';
  diagnostics?: ConnectionTestDiagnostics;
}

type ConnectionTestPhase =
  | 'binary_resolution'
  | 'version_probe'
  | 'model_list'
  | 'spawn'
  | 'connection_smoke_test'
  | 'output_parse';

interface ConnectionTestDiagnostics {
  phase: ConnectionTestPhase;
  binaryPath?: string;
  binaryVersion?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  stdoutTail?: string;
  stderrTail?: string;
}
```
