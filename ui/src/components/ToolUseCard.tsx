/**
 * F-30 — ToolUseCard
 * Inline chip showing a tool call: running (spinner) / done (✓) / error (✕).
 */
import type { ToolUseEvent } from '../store/projectPageStore';
import { SpinnerIcon } from './shared/SpinnerIcon';

interface ToolUseCardProps {
  event: ToolUseEvent;
}

const TOOL_ICONS: Record<string, string> = {
  write_file: '✏️',
  read_file: '📖',
  run_command: '⚡',
  search_web: '🔍',
  generate_image: '🖼',
  default: '🔧',
};

export function ToolUseCard({ event }: ToolUseCardProps) {
  const icon = TOOL_ICONS[event.toolName] ?? TOOL_ICONS.default;
  const isRunning = event.status === 'running';

  return (
    <div
      id={`tool-use-${event.id}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 8px',
        borderRadius: 6,
        fontSize: 11,
        background: isRunning ? 'rgba(124,109,250,0.15)' : 'rgba(255,255,255,0.05)',
        border: `1px solid ${isRunning ? 'rgba(124,109,250,0.3)' : 'var(--color-border)'}`,
        color: isRunning ? 'var(--color-accent)' : 'var(--color-text-muted)',
      }}
    >
      {isRunning ? <SpinnerIcon size={11} /> : <span>{icon}</span>}
      <span>{event.toolName.replace(/_/g, ' ')}</span>
      {event.status === 'error' && <span style={{ color: '#fa5050' }}>✕</span>}
      {event.status === 'done' && <span style={{ color: '#6ac47e' }}>✓</span>}
    </div>
  );
}
