/**
 * T30 — TodoCard Component
 * Real-time todo progress from SSE `todo` event.
 * SRS FR-06.4, URD US-02-03
 */
import type { TodoItem } from '../api/runs/http';

interface TodoCardProps {
  items: TodoItem[];
  isStreaming?: boolean;
}

export function TodoCard({ items, isStreaming }: TodoCardProps) {
  if (items.length === 0) return null;

  return (
    <div
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius)',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--color-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: 4,
        }}
      >
        {isStreaming ? 'In Progress' : 'Plan'}
      </div>

      {items.map((item) => (
        <TodoItemRow key={item.id} item={item} />
      ))}
    </div>
  );
}

function TodoItemRow({ item }: { item: TodoItem }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '3px 0',
        opacity: item.status === 'queued' ? 0.5 : 1,
        transition: 'opacity 0.2s',
      }}
    >
      <StatusIcon status={item.status} />
      <span
        style={{
          fontSize: 13,
          color:
            item.status === 'completed'
              ? 'var(--color-text-muted)'
              : 'var(--color-text)',
          textDecoration: item.status === 'completed' ? 'line-through' : 'none',
          flex: 1,
        }}
      >
        {item.text}
      </span>
    </div>
  );
}

function StatusIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed')
    return (
      <span
        style={{
          width: 16,
          height: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '50%',
          background: 'rgba(80,220,120,0.2)',
          color: '#50dc78',
          fontSize: 10,
          flexShrink: 0,
        }}
      >
        ✓
      </span>
    );

  if (status === 'in_progress')
    return (
      <span
        style={{
          width: 16,
          height: 16,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          style={{ animation: 'spin 1s linear infinite' }}
        >
          <circle
            cx="7"
            cy="7"
            r="5"
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="2"
            strokeDasharray="20 10"
            strokeLinecap="round"
          />
        </svg>
      </span>
    );

  if (status === 'failed')
    return (
      <span
        style={{
          width: 16,
          height: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '50%',
          background: 'rgba(250,80,80,0.2)',
          color: '#fa5050',
          fontSize: 10,
          flexShrink: 0,
        }}
      >
        ✗
      </span>
    );

  // queued
  return (
    <span
      style={{
        width: 16,
        height: 16,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '50%',
        border: '1.5px solid var(--color-border)',
        flexShrink: 0,
      }}
    />
  );
}
