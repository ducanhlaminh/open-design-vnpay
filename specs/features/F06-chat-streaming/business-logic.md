# F-06: Chat & Agent Streaming — Business Logic

## Overview

Chat is the primary interaction mode in Open Design. Each project supports **multiple conversation threads**, each persisted in SQLite. Messages are streamed to the UI via **Server-Sent Events (SSE)** in real time. The agent runs as a child process and emits events that are normalized and forwarded to the browser.

---

## Business Rules

### Conversation Model

| Rule | Detail |
|------|--------|
| **BR-01** | Each project can have multiple independent conversations |
| **BR-02** | Each conversation has a unique `id`, `projectId`, optional `title`, and timestamps |
| **BR-03** | Conversations persist in SQLite — history survives browser refresh |
| **BR-04** | Files in a project's directory are shared across all conversations |

### Message Lifecycle

| Rule | Detail |
|------|--------|
| **BR-05** | Each user message creates a `ChatMessage` record with `role: 'user'` |
| **BR-06** | Agent response is streamed as SSE; on completion, a `role: 'assistant'` record is persisted |
| **BR-07** | Run status transitions: `queued → running → succeeded | failed | canceled` |
| **BR-08** | Raw agent events are stored in `eventsJson` for debugging |
| **BR-09** | `producedFiles` tracks which files the agent wrote during the turn |
| **BR-10** | User can cancel a running turn — emits `canceled` status |
| **BR-11** | A failed run can be retried without losing conversation history |
| **BR-12** | User can type a new message mid-flight — this redirects (cancels current turn, starts new) |

### Prompt Stack Assembly

Order of injection before every agent turn:

```
1. DISCOVERY directives   (turn-1 form, turn-2 brand branch, TodoWrite, 5-dim critique)
2. Identity charter       (OFFICIAL_DESIGNER_PROMPT, anti-AI-slop, junior-pass)
3. Active DESIGN.md       (selected from 150+ design systems)
4. Active SKILL.md        (selected from 132+ skills)
5. Project metadata       (kind, fidelity, speakerNotes, animations, inspirationIds)
6. Skill side files       (assets/template.html + references/*.md — auto-inject)
7. (deck kind only)       DECK_FRAMEWORK_DIRECTIVE — nav/counter/scroll/print
```

### SSE Stream Events

| Event | Payload | Description |
|-------|---------|-------------|
| `delta` | `{ text }` | Token-level text from agent |
| `tool_use` | `{ name, input, output }` | Tool call and result |
| `todo` | `{ items: TodoItem[] }` | Live progress tracking |
| `artifact` | `{ html, title, identifier }` | Design artifact emitted |
| `file_op` | `{ path, operation }` | File written or deleted |
| `question_form` | `{ fields: FormField[] }` | Discovery form (Turn-1) |
| `direction_picker` | `{ directions: Direction[] }` | Visual direction picker (Turn-2) |
| `end` | `{ runId, status }` | Turn complete |
| `error` | `{ message, code }` | Runtime error |

### Run Status States

| Status | Meaning |
|--------|---------|
| `queued` | Waiting for agent spawn |
| `running` | Agent actively executing |
| `succeeded` | Turn completed successfully |
| `failed` | Agent error or crash |
| `canceled` | User-initiated stop |

### Attachments

Users can attach to messages:
- Files from the project directory (by reference)
- Uploaded files (paste/drag image, document)
- Context chips (reference specific artifacts)

### Performance SLAs

| SLA | Target |
|-----|--------|
| Agent spawn after submit | < 1 second |
| SSE latency (perceived) | < 100ms |
| Messages persist on daemon restart | ✅ |

---

## Data Model

```typescript
interface Conversation {
  id: string;
  projectId: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  latestRun?: {
    status: ChatRunStatus;
    startedAt?: number;
    endedAt?: number;
    durationMs?: number;
  };
}

type ChatRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  agentId?: string;
  agentName?: string;
  eventsJson?: string;           // Raw agent events (debug)
  attachments?: ChatAttachment[];
  producedFiles?: string[];      // Files written during turn
  runId?: string;
  runStatus?: ChatRunStatus;
  startedAt?: number;
  endedAt?: number;
  position: number;
  createdAt: number;
}
```

---

## Acceptance Criteria

- [ ] SSE streaming real-time, latency < 100ms perceived
- [ ] Todo card updates in real-time
- [ ] User can type mid-flight (redirect)
- [ ] Conversation history persists across browser refresh
- [ ] Failed run can be retried
- [ ] Agent spawn < 1s after submit
- [ ] Messages persist even if daemon restarts
