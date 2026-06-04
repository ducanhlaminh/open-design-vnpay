/**
 * T03 — RunsApiClient (SSE streaming)
 * SRS FR-06: Conversation & Chat with SSE streaming
 * Handles all 9 SSE event types from FR-06.4
 */
import { BaseApiClient, ApiError } from '../client';
import type { Conversation, ChatMessage } from '../../types';

// ── SSE Event Types (SRS FR-06.4) ────────────────────────────────────────

export interface DeltaEvent {
  kind: 'delta';
  text: string;
}

export interface ToolUseEvent {
  kind: 'tool_use';
  name: string;
  input: unknown;
  output?: unknown;
}

export interface TodoItem {
  id: string;
  text: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
}

export interface TodoEvent {
  kind: 'todo';
  items: TodoItem[];
}

export interface ArtifactEvent {
  kind: 'artifact';
  identifier: string;
  title: string;
  html: string;
  artifactType?: string;
}

export interface FileOpEvent {
  kind: 'file_op';
  path: string;
  operation: 'write' | 'delete' | 'create';
}

export interface FormField {
  id: string;
  type: 'radio' | 'text' | 'select';
  label: string;
  options?: string[];
  placeholder?: string;
  required?: boolean;
}

export interface QuestionFormEvent {
  kind: 'question_form';
  id: string;
  fields: FormField[];
  title?: string;
}

export interface Direction {
  id: string;
  name: string;
  description: string;
  palette: string[];
  fontStack: string[];
}

export interface DirectionPickerEvent {
  kind: 'direction_picker';
  directions: Direction[];
}

export interface EndEvent {
  kind: 'end';
  runId: string;
  status: 'succeeded' | 'failed' | 'canceled';
}

export interface ErrorEvent {
  kind: 'error';
  message: string;
  code?: string;
}

export type RunSSEEvent =
  | DeltaEvent
  | ToolUseEvent
  | TodoEvent
  | ArtifactEvent
  | FileOpEvent
  | QuestionFormEvent
  | DirectionPickerEvent
  | EndEvent
  | ErrorEvent;

// ── Handlers ─────────────────────────────────────────────────────────────

export interface RunStreamHandlers {
  onDelta?: (e: DeltaEvent) => void;
  onToolUse?: (e: ToolUseEvent) => void;
  onTodo?: (e: TodoEvent) => void;
  onArtifact?: (e: ArtifactEvent) => void;
  onFileOp?: (e: FileOpEvent) => void;
  onQuestionForm?: (e: QuestionFormEvent) => void;
  onDirectionPicker?: (e: DirectionPickerEvent) => void;
  onEnd?: (e: EndEvent) => void;
  onError?: (e: ErrorEvent) => void;
}

// ── Client ────────────────────────────────────────────────────────────────

export interface SendMessageRequest {
  content: string;
  agentId?: string;
  skillId?: string;
  designSystemId?: string;
  attachments?: Array<{ kind: string; [k: string]: unknown }>;
}

export class HttpRunsApiClient extends BaseApiClient {
  // Conversations
  listConversations(projectId: string): Promise<Conversation[]> {
    return this.get(`/api/projects/${projectId}/conversations`);
  }

  createConversation(projectId: string): Promise<Conversation> {
    return this.post(`/api/projects/${projectId}/conversations`);
  }

  listMessages(projectId: string, convId: string): Promise<ChatMessage[]> {
    return this.get(`/api/projects/${projectId}/conversations/${convId}/messages`);
  }

  /**
   * Send a message and stream SSE events back.
   * Returns an AbortController so callers can cancel mid-run.
   */
  sendMessage(
    projectId: string,
    convId: string,
    req: SendMessageRequest,
    handlers: RunStreamHandlers,
  ): AbortController {
    const controller = new AbortController();

    void this.#streamRun(projectId, convId, req, handlers, controller.signal);

    return controller;
  }

  async #streamRun(
    projectId: string,
    convId: string,
    req: SendMessageRequest,
    handlers: RunStreamHandlers,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const stream = this.streamSSE(
        `/api/projects/${projectId}/conversations/${convId}/messages`,
        req,
        signal,
      );

      for await (const { event, data } of stream) {
        if (signal.aborted) break;
        this.#dispatch(event, data, handlers);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      handlers.onError?.({
        kind: 'error',
        message: err instanceof ApiError ? err.body : String(err),
      });
    }
  }

  #dispatch(event: string, rawData: string, handlers: RunStreamHandlers): void {
    let data: unknown;
    try {
      data = JSON.parse(rawData);
    } catch {
      data = { text: rawData };
    }

    switch (event) {
      case 'delta':
        handlers.onDelta?.({ kind: 'delta', ...(data as object) } as DeltaEvent);
        break;
      case 'tool_use':
        handlers.onToolUse?.({ kind: 'tool_use', ...(data as object) } as ToolUseEvent);
        break;
      case 'todo':
        handlers.onTodo?.({ kind: 'todo', ...(data as object) } as TodoEvent);
        break;
      case 'artifact':
        handlers.onArtifact?.({ kind: 'artifact', ...(data as object) } as ArtifactEvent);
        break;
      case 'file_op':
        handlers.onFileOp?.({ kind: 'file_op', ...(data as object) } as FileOpEvent);
        break;
      case 'question_form':
        handlers.onQuestionForm?.({ kind: 'question_form', ...(data as object) } as QuestionFormEvent);
        break;
      case 'direction_picker':
        handlers.onDirectionPicker?.({ kind: 'direction_picker', ...(data as object) } as DirectionPickerEvent);
        break;
      case 'end':
        handlers.onEnd?.({ kind: 'end', ...(data as object) } as EndEvent);
        break;
      case 'error':
        handlers.onError?.({ kind: 'error', ...(data as object) } as ErrorEvent);
        break;
      default:
        // Unknown event — silently ignore (forward compat)
        break;
    }
  }

  cancelRun(projectId: string, runId: string): Promise<void> {
    return this.post(`/api/projects/${projectId}/runs/${runId}/cancel`);
  }
}
