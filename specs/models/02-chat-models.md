# 02 — Chat & Run Models

**Nguồn:** `packages/contracts/src/api/chat.ts`, `packages/contracts/src/sse/chat.ts`

---

## ChatRole

```typescript
type ChatRole = 'user' | 'assistant';
```

---

## ChatRunStatus

```typescript
type ChatRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
```

---

## ChatRequest

Payload gửi lên khi start một chat turn:

```typescript
interface ChatRequest {
  agentId: string;
  message: string;
  currentPrompt?: string;       // Per-turn telemetry only
  systemPrompt?: string;
  projectId?: string | null;
  conversationId?: string | null;
  assistantMessageId?: string | null;
  clientRequestId?: string | null;
  skillId?: string | null;
  skillIds?: string[];           // Per-turn @-mention skills (không persist)
  designSystemId?: string | null;
  attachments?: string[];
  commentAttachments?: ChatCommentAttachment[];
  model?: string | null;
  reasoning?: string | null;
  locale?: string;               // UI locale
  research?: ResearchOptions;
  context?: RunContextSelection;
  analyticsHints?: ChatAnalyticsHints;
}
```

---

## ChatAnalyticsHints

Analytics context cho tracking (không ảnh hưởng behavior):

```typescript
type ChatAnalyticsEntryFrom =
  | 'new_project'
  | 'chat_composer'
  | 'design_system_create'
  | 'onboarding_design_system'
  | 'regenerate_from_review';

type ChatAnalyticsLengthBucket = '0' | '1_50' | '51_200' | '201_500' | '500_plus';

type ChatAnalyticsDesignSystemOrigin =
  | 'onboarding' | 'manual_create' | 'github_repo' | 'local_code'
  | 'fig' | 'assets' | 'official_preset' | 'enterprise' | 'template'
  | 'mixed' | 'unknown';

interface ChatAnalyticsDesignSystemRunContext {
  origin?: ChatAnalyticsDesignSystemOrigin;
  sourceCount?: number;
  hasBrandDescription?: boolean;
  brandDescriptionLengthBucket?: ChatAnalyticsLengthBucket;
  githubRepoCount?: number;
  localFolderCount?: number;
  figFileCount?: number;
  assetFileCount?: number;
}

interface ChatAnalyticsHints {
  entryFrom?: ChatAnalyticsEntryFrom;
  projectKind?:
    | 'prototype' | 'live_artifact' | 'slide_deck' | 'template'
    | 'image' | 'video' | 'audio' | 'design_system' | 'other';
  designSystemRunContext?: ChatAnalyticsDesignSystemRunContext;
}
```

---

## ChatRunCreateResponse

```typescript
interface ChatRunCreateResponse {
  runId: string;
  appliedPluginSnapshotId?: string;
  pluginId?: string;
}
```

---

## ChatRunStatusResponse

```typescript
interface ChatRunStatusResponse {
  id: string;
  projectId: string | null;
  conversationId: string | null;
  assistantMessageId: string | null;
  agentId: string | null;
  appliedPluginSnapshotId?: string | null;
  pluginId?: string | null;
  status: ChatRunStatus;
  createdAt: number;
  updatedAt: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string | null;
  errorCode?: string | null;
}
```

---

## ChatAttachment

File đính kèm trong chat message:

```typescript
interface ChatAttachment {
  path: string;
  name: string;
  kind: 'image' | 'file';
  size?: number;
}
```

---

## ChatCommentAttachment

Comment từ preview annotation được đính kèm vào chat:

```typescript
interface ChatCommentAttachment {
  id: string;
  order: number;
  filePath: string;
  elementId: string;
  selector: string;             // CSS selector
  label: string;
  comment: string;
  currentText: string;
  pagePosition: PreviewCommentPosition;
  htmlHint: string;
  style?: PreviewAnnotationStyle;
  selectionKind?: ChatCommentSelectionKind;
  memberCount?: number;
  podMembers?: PreviewCommentMember[];
  screenshotPath?: string;
  markKind?: PreviewVisualMarkKind;
  intent?: string;
  source?: 'saved-comment' | 'board-batch';
}
```

---

## ChatMessageFeedback

User feedback cho assistant response:

```typescript
type ChatMessageFeedbackRating = 'positive' | 'negative';

type ChatMessageFeedbackReasonCode =
  | 'matched_request'
  | 'strong_visual'
  | 'useful_structure'
  | 'easy_to_continue'
  | 'followed_design_system'
  | 'missed_request'
  | 'weak_visual'
  | 'incomplete_output'
  | 'hard_to_use'
  | 'missed_design_system'
  | 'other';

interface ChatMessageFeedback {
  rating: ChatMessageFeedbackRating;
  reasonCodes?: ChatMessageFeedbackReasonCode[];
  customReason?: string;
  reasonsSubmittedAt?: number;
  createdAt: number;
  updatedAt?: number;
}
```

---

## PersistedAgentEvent

Events được persist sau mỗi turn (lưu trong `eventsJson`):

```typescript
type PersistedAgentEvent =
  | { kind: 'status'; label: string; detail?: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'live_artifact';
      action: 'created' | 'updated' | 'deleted';
      projectId: string;
      artifactId: string;
      title: string;
      refreshStatus?: string;
    }
  | {
      kind: 'live_artifact_refresh';
      phase: 'started' | 'succeeded' | 'failed';
      projectId: string;
      artifactId: string;
      refreshId?: string;
      title?: string;
      refreshedSourceCount?: number;
      error?: string;
    }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | {
      kind: 'skills_applied';         // Web-only, không persist
      skillId?: string | null;
      skillIds?: string[];
    }
  | {
      kind: 'plugin_candidate';
      candidateId: string;
      title: string;
      description?: string;
      confidence?: number;
      draftPath?: string | null;
    }
  | {
      kind: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      durationMs?: number;
    }
  | { kind: 'raw'; line: string };
```

---

## ChatMessage

Persisted message trong database:

```typescript
interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  agentId?: string;
  agentName?: string;
  events?: PersistedAgentEvent[];
  createdAt?: number;
  runId?: string;
  runStatus?: ChatRunStatus;
  lastRunEventId?: string;
  startedAt?: number;
  endedAt?: number;
  attachments?: ChatAttachment[];
  commentAttachments?: ChatCommentAttachment[];
  producedFiles?: ProjectFile[];
  preTurnFileNames?: string[];     // Diff baseline
  feedback?: ChatMessageFeedback;
  telemetryFinalized?: boolean;    // Request-only, daemon không store
}
```

---

## SSE Events (Streaming)

### ChatSseStartPayload
```typescript
interface ChatSseStartPayload {
  runId?: string;
  agentId?: string;
  bin: string;
  protocolVersion?: 1;
  cwd?: string | null;             // Legacy
  projectId?: string | null;
  model?: string | null;
  reasoning?: string | null;
  skillId?: string | null;
  skillIds?: string[];
}
```

### ChatSseEndPayload
```typescript
interface ChatSseEndPayload {
  code: number | null;
  signal?: string | null;
  status?: 'succeeded' | 'failed' | 'canceled';
}
```

### DaemonAgentPayload (SSE `agent` event)
```typescript
type DaemonAgentPayload =
  | { type: 'status'; label: string; model?: string; ttftMs?: number; detail?: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_start' }
  | { type: 'live_artifact'; action: 'created'|'updated'|'deleted'; projectId: string; artifactId: string; title: string; refreshStatus?: LiveArtifactRefreshStatus }
  | { type: 'live_artifact_refresh'; phase: 'started'|'succeeded'|'failed'; projectId: string; artifactId: string; ... }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'usage'; usage?: { input_tokens?: number; output_tokens?: number }; costUsd?: number; durationMs?: number }
  | { type: 'raw'; line: string };
```

### ChatSseEvent (full union)
```typescript
type ChatSseEvent =
  | SseTransportEvent<'start', ChatSseStartPayload>
  | SseTransportEvent<'agent', DaemonAgentPayload>
  | SseTransportEvent<'stdout', { chunk: string }>
  | SseTransportEvent<'stderr', { chunk: string }>
  | SseTransportEvent<'error', SseErrorPayload>
  | SseTransportEvent<'end', ChatSseEndPayload>;
```

### ProjectConversationCreatedSsePayload
```typescript
interface ProjectConversationCreatedSsePayload {
  type: 'conversation-created';
  projectId: string;
  conversationId: string;
  title: string | null;
  createdAt: number;
}
```
