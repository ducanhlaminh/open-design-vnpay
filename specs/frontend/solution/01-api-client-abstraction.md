# Giải pháp 01 — API Client Abstraction Layer

> **Độ phức tạp**: Thấp  
> **Rủi ro**: Thấp  
> **Thời gian ước tính**: 2–3 tuần  
> **Phạm vi thay đổi**: Chỉ `apps/web` — **không đụng đến backend**

---

## 1. Mô tả

Tạo một **API Client Abstraction Layer** trong `apps/web` để tách biệt hoàn toàn:
- **Giao diện (what)**: Các hàm mà React components/hooks gọi
- **Triển khai (how)**: HTTP calls đến daemon hoặc Go services

Khi backend được migrate sang Go, chỉ cần swap implementation — frontend components **không cần thay đổi**.

```
Before:
  Component → fetch('/api/projects') → Daemon

After:
  Component → ProjectAPI.list() → [Daemon Adapter | Go Adapter]
                                    ↕
                                  fetch('/api/projects')
```

---

## 2. Kiến trúc Đề xuất

```
apps/web/src/
├── api/                          ← [NEW] API Client Layer
│   ├── index.ts                  ← Re-export all API clients
│   ├── client.ts                 ← Base HTTP client (fetch wrapper)
│   ├── types.ts                  ← API request/response types
│   │
│   ├── projects/
│   │   ├── types.ts              ← Project-specific types
│   │   ├── client.ts             ← ProjectApiClient interface
│   │   └── http.ts               ← HTTP implementation
│   │
│   ├── runs/
│   │   ├── types.ts
│   │   ├── client.ts             ← RunsApiClient interface
│   │   └── http.ts               ← SSE + HTTP implementation
│   │
│   ├── design-systems/
│   │   ├── types.ts
│   │   ├── client.ts
│   │   └── http.ts
│   │
│   ├── skills/
│   │   ├── types.ts
│   │   ├── client.ts
│   │   └── http.ts
│   │
│   ├── config/
│   │   ├── types.ts
│   │   ├── client.ts
│   │   └── http.ts
│   │
│   └── agents/
│       ├── types.ts
│       ├── client.ts
│       └── http.ts
│
├── providers/                    ← [REFACTOR] Thin wrappers calling api/
│   ├── registry.ts               ← Delegates to api/* clients
│   └── daemon.ts                 ← Delegates to api/runs/
...
```

---

## 3. Implementation Chi tiết

### 3.1 Base HTTP Client

```typescript
// apps/web/src/api/client.ts

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class BaseApiClient {
  constructor(private readonly baseUrl: string = '') {}

  protected async get<T>(path: string, options?: RequestOptions): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      signal: options?.signal,
      headers: options?.headers,
    });
    if (!resp.ok) {
      throw new ApiError(resp.status, await resp.text().catch(() => `HTTP ${resp.status}`));
    }
    return resp.json() as Promise<T>;
  }

  protected async post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: options?.signal,
    });
    if (!resp.ok) {
      throw new ApiError(resp.status, await resp.text().catch(() => `HTTP ${resp.status}`));
    }
    return resp.json() as Promise<T>;
  }

  protected async put<T>(path: string, body?: unknown): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) {
      throw new ApiError(resp.status, await resp.text().catch(() => `HTTP ${resp.status}`));
    }
    return resp.json() as Promise<T>;
  }

  protected async del(path: string): Promise<boolean> {
    const resp = await fetch(`${this.baseUrl}${path}`, { method: 'DELETE' });
    return resp.ok;
  }
}
```

### 3.2 Project API Client

```typescript
// apps/web/src/api/projects/client.ts
import type { Project, ProjectFile } from '../../types';

export interface CreateProjectInput {
  name: string;
  kind?: string;
  metadata?: Record<string, unknown>;
}

export interface IProjectApiClient {
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | null>;
  create(input: CreateProjectInput): Promise<Project | null>;
  patch(id: string, changes: Partial<CreateProjectInput>): Promise<Project | null>;
  delete(id: string): Promise<boolean>;
  listFiles(id: string): Promise<ProjectFile[]>;
}
```

```typescript
// apps/web/src/api/projects/http.ts
import { BaseApiClient } from '../client';
import type { IProjectApiClient, CreateProjectInput } from './client';
import type { Project, ProjectFile } from '../../types';

export class HttpProjectApiClient extends BaseApiClient implements IProjectApiClient {
  async list(): Promise<Project[]> {
    try {
      const json = await this.get<{ projects: Project[] }>('/api/projects');
      return json.projects ?? [];
    } catch { return []; }
  }

  async get(id: string): Promise<Project | null> {
    try {
      return await this.get<Project>(`/api/projects/${encodeURIComponent(id)}`);
    } catch { return null; }
  }

  async create(input: CreateProjectInput): Promise<Project | null> {
    try {
      return await this.post<Project>('/api/projects', input);
    } catch { return null; }
  }

  async patch(id: string, changes: Partial<CreateProjectInput>): Promise<Project | null> {
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      });
      if (!resp.ok) return null;
      return resp.json() as Promise<Project>;
    } catch { return null; }
  }

  async delete(id: string): Promise<boolean> {
    return this.del(`/api/projects/${encodeURIComponent(id)}`);
  }

  async listFiles(id: string): Promise<ProjectFile[]> {
    try {
      const json = await this.get<{ files: ProjectFile[] }>(`/api/projects/${encodeURIComponent(id)}/files`);
      return json.files ?? [];
    } catch { return []; }
  }
}
```

### 3.3 Runs / SSE API Client

```typescript
// apps/web/src/api/runs/client.ts

export interface IRunsApiClient {
  create(body: ChatRequest): Promise<{ runId: string }>;
  streamEvents(
    runId: string,
    options: {
      signal: AbortSignal;
      lastEventId?: string | null;
      onEvent: (event: ChatSseEvent) => void;
      onError: (err: Error) => void;
      onEnd: () => void;
    }
  ): Promise<void>;
  cancel(runId: string): Promise<void>;
  submitToolResult(runId: string, toolUseId: string, content: string): Promise<boolean>;
}
```

```typescript
// apps/web/src/api/runs/http.ts
// Wraps current daemon.ts logic — SSE consumer stays identical

export class HttpRunsApiClient extends BaseApiClient implements IRunsApiClient {
  async create(body: ChatRequest): Promise<{ runId: string }> {
    return this.post<{ runId: string }>('/api/runs', body);
  }

  async streamEvents(runId: string, options: StreamEventOptions): Promise<void> {
    // Exact same SSE consumption logic from daemon.ts:consumeDaemonRun()
    // — just moved here with a clean interface
    const qs = options.lastEventId
      ? `?after=${encodeURIComponent(options.lastEventId)}`
      : '';
    const resp = await fetch(`/api/runs/${encodeURIComponent(runId)}/events${qs}`, {
      signal: options.signal,
    });
    // ... (copy existing SSE reading logic)
  }

  async cancel(runId: string): Promise<void> {
    await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
  }

  async submitToolResult(runId: string, toolUseId: string, content: string): Promise<boolean> {
    const resp = await fetch(`/api/runs/${encodeURIComponent(runId)}/tool-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolUseId, content }),
    });
    return resp.ok;
  }
}
```

### 3.4 API Context Provider (React)

```typescript
// apps/web/src/api/index.ts

import { HttpProjectApiClient } from './projects/http';
import { HttpRunsApiClient } from './runs/http';
import { HttpDesignSystemApiClient } from './design-systems/http';
import { HttpSkillApiClient } from './skills/http';
import { HttpConfigApiClient } from './config/http';
import { HttpAgentApiClient } from './agents/http';

// Singleton API clients — swap implementation here for Go backend
export const api = {
  projects: new HttpProjectApiClient(),
  runs: new HttpRunsApiClient(),
  designSystems: new HttpDesignSystemApiClient(),
  skills: new HttpSkillApiClient(),
  config: new HttpConfigApiClient(),
  agents: new HttpAgentApiClient(),
} as const;

export type ApiClients = typeof api;
```

```typescript
// apps/web/src/api/ApiProvider.tsx
import { createContext, useContext } from 'react';
import { api, type ApiClients } from './index';

const ApiContext = createContext<ApiClients>(api);

export function ApiProvider({ children, clients = api }: {
  children: React.ReactNode;
  clients?: ApiClients;
}) {
  return <ApiContext.Provider value={clients}>{children}</ApiContext.Provider>;
}

export const useApi = () => useContext(ApiContext);
```

### 3.5 Refactor providers/ để dùng api/

```typescript
// apps/web/src/providers/registry.ts — BEFORE
export async function fetchAgents(): Promise<AgentInfo[]> {
  const resp = await fetch('/api/agents');
  // ...
}

// apps/web/src/providers/registry.ts — AFTER
import { api } from '../api';

export async function fetchAgents(): Promise<AgentInfo[]> {
  return api.agents.list();  // Delegates to API client
}
```

---

## 4. Lợi ích

| Lợi ích | Mô tả |
|---------|-------|
| **Zero UI change** | Components không cần biết implementation thay đổi |
| **Testability** | Mock `api.*` trong tests thay vì mock `fetch()` |
| **Backend swap** | Thay `new HttpProjectApiClient()` → `new GoProjectApiClient()` |
| **Type safety** | Interface contract rõ ràng giữa UI và API layer |
| **Progressive** | Migrate từng client một, không cần big-bang |

---

## 5. Thực thi

### Phase 1 (Tuần 1): Tạo abstraction layer
- [ ] Tạo `apps/web/src/api/client.ts` (BaseApiClient)
- [ ] Tạo interfaces cho từng domain (projects, runs, skills, config, agents, design-systems)
- [ ] Tạo HTTP implementations (copy logic từ providers/ hiện tại)

### Phase 2 (Tuần 2): Refactor providers
- [ ] Refactor `providers/registry.ts` → dùng `api.*`
- [ ] Refactor `providers/daemon.ts` → dùng `api.runs.*`
- [ ] Refactor `state/config.ts` → dùng `api.config.*`
- [ ] Refactor `state/projects.ts` → dùng `api.projects.*`

### Phase 3 (Tuần 3): Tests & Validation
- [ ] Thêm unit tests cho API clients
- [ ] Integration test với daemon (hiện tại)
- [ ] Chuẩn bị Go adapter (khi Go services sẵn sàng)

---

## 6. Rủi ro & Giảm thiểu

| Rủi ro | Xác suất | Giảm thiểu |
|--------|---------|------------|
| Regression trong SSE streaming | Thấp | E2E test coverage trước khi refactor |
| Missing edge cases | Thấp | Review providers/ hiện tại kỹ càng |
| Performance overhead | Rất thấp | Không thêm layer mạng — chỉ wrap hàm |

---

## 7. Không yêu cầu

- ❌ Không thay đổi backend (daemon)
- ❌ Không thay đổi API endpoints
- ❌ Không thay đổi React components
- ❌ Không thay đổi deployment pipeline
