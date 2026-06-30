/**
 * F-29 — AssistantTurn
 * Renders one assistant chat turn: tools, todos, text, artifacts, questionForm, directionPicker.
 * Adapts store event shapes to existing QuestionForm and DirectionPicker component props.
 */
import { QuestionForm } from './QuestionForm';
import { DirectionPicker, BUILTIN_DIRECTIONS } from './DirectionPicker';
import { MarkdownMessage } from './MarkdownMessage';
import { ToolUseCard } from './ToolUseCard';
import { TodoCard } from './TodoCard';
import type { ChatTurn } from '../store/projectPageStore';
import type { QuestionFormEvent } from '../api/runs/http';

interface AssistantTurnProps {
  turn: ChatTurn;
  onAnswerQuestion?: (answers: Record<string, string>) => void;
  onSkipQuestion?: () => void;
  onSelectDirection?: (id: string) => void;
}

export function AssistantTurn({ turn, onAnswerQuestion, onSkipQuestion, onSelectDirection }: AssistantTurnProps) {
  // Adapt store's QuestionFormEvent (simplified) to what QuestionForm component expects
  const questionFormEvent: QuestionFormEvent | null = turn.questionForm
    ? {
        kind: 'question_form' as const,
        id: turn.questionForm.id,
        title: turn.questionForm.question,
        fields: (turn.questionForm.options ?? []).map((opt, i) => ({
          id: `opt-${i}`,
          type: 'radio' as const,
          label: opt,
          options: turn.questionForm!.options,
        })),
      }
    : null;

  // The store DirectionPickerEvent.directions is string[], but DirectionPicker uses Direction[]
  // Map strings to Direction objects (fall back to builtins by id match)
  const directions = turn.directionEvent
    ? turn.directionEvent.directions.map((d) =>
        BUILTIN_DIRECTIONS.find((b) => b.id === d) ?? {
          id: d,
          name: d,
          description: '',
          palette: [],
          fontStack: [],
        }
      )
    : [];

  return (
    <div
      id={`assistant-turn-${turn.id}`}
      style={{
        padding: '10px 0',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
      }}
    >
      {/* Tool use chips */}
      {turn.toolUses.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
          {turn.toolUses.map((tu) => (
            <ToolUseCard key={tu.id} event={tu} />
          ))}
        </div>
      )}

      {/* Todo list */}
      {turn.todos.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <TodoCard items={turn.todos} isStreaming={turn.isStreaming} />
        </div>
      )}

      {/* Streaming / completed text */}
      {turn.text && (
        <MarkdownMessage text={turn.text} isStreaming={turn.isStreaming} />
      )}

      {/* Artifacts */}
      {turn.artifacts.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
          {turn.artifacts.map((a) => (
            <div
              key={a.identifier}
              style={{
                fontSize: 11, padding: '3px 8px',
                borderRadius: 4,
                background: 'rgba(124,109,250,0.15)',
                color: 'var(--color-accent)',
                border: '1px solid rgba(124,109,250,0.3)',
              }}
            >
              📄 {a.title}
            </div>
          ))}
        </div>
      )}

      {/* Question form (interactive) */}
      {questionFormEvent && (
        <div style={{ marginTop: 10 }}>
          <QuestionForm
            form={questionFormEvent}
            onSubmit={onAnswerQuestion ?? (() => {})}
            onSkip={onSkipQuestion ?? (() => {})}
            disabled={!turn.isStreaming}
          />
        </div>
      )}

      {/* Direction picker (interactive) */}
      {turn.directionEvent && directions.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <DirectionPicker
            directions={directions}
            onSelect={onSelectDirection ?? (() => {})}
            disabled={!turn.isStreaming}
          />
        </div>
      )}
    </div>
  );
}
