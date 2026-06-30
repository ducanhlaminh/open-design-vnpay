/**
 * F-26 — MediaTaskCard
 * Renders one media job (image/video/audio). Auto-polls every 3s while pending/processing.
 * Shows result inline (img/video/audio), download link, durationMs.
 */
import { useEffect } from 'react';
import { StatusDot } from './shared/StatusDot';
import { SpinnerIcon } from './shared/SpinnerIcon';
import type { MediaJobSummary } from '../types';

interface MediaTaskCardProps {
  task: MediaJobSummary;
  onRefresh: () => void;
}

export function MediaTaskCard({ task, onRefresh }: MediaTaskCardProps) {
  // Auto-poll every 3s while running
  useEffect(() => {
    if (task.status === 'pending' || task.status === 'processing') {
      const interval = setInterval(onRefresh, 3000);
      return () => clearInterval(interval);
    }
  }, [task.status, onRefresh]);

  const SURFACE_EMOJI: Record<string, string> = {
    image: '🖼',
    video: '🎬',
    audio: '🎵',
  };

  return (
    <div
      id={`media-task-${task.id}`}
      style={{
        padding: 12,
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius)',
        background: 'var(--color-surface)',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusDot status={task.status} size={8} />
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text)' }}>
          {SURFACE_EMOJI[task.kind] ?? '?'} {task.kind}
        </span>
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)', marginLeft: 'auto' }}>
          {task.model}
        </span>
      </div>

      {/* Template source */}
      {task.templateId && (
        <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
          Template: {task.templateId}
        </div>
      )}

      {/* Result preview */}
      {task.status === 'done' && task.resultUrl && (
        task.kind === 'image' ? (
          <img
            src={task.resultUrl}
            alt="Generated"
            style={{ width: '100%', borderRadius: 8, display: 'block' }}
          />
        ) : task.kind === 'video' ? (
          <video
            src={task.resultUrl}
            controls
            style={{ width: '100%', borderRadius: 8 }}
          />
        ) : (
          <audio src={task.resultUrl} controls style={{ width: '100%' }} />
        )
      )}

      {/* Processing indicator */}
      {(task.status === 'pending' || task.status === 'processing') && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' }}>
          <SpinnerIcon size={14} />
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {task.status === 'pending' ? 'Queued...' : 'Generating...'}
          </span>
        </div>
      )}

      {/* Error */}
      {task.status === 'failed' && (
        <div style={{ fontSize: 12, color: '#fa5050', lineHeight: 1.4 }}>
          {task.errorMsg ?? 'Generation failed'}
        </div>
      )}

      {/* Footer: Download + duration */}
      {task.status === 'done' && task.resultUrl && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <a
            href={task.resultUrl}
            download
            style={{ fontSize: 11, color: 'var(--color-accent)', textDecoration: 'none' }}
          >
            ↓ Download
          </a>
          {task.durationMs && (
            <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
              {(task.durationMs / 1000).toFixed(1)}s
            </span>
          )}
        </div>
      )}
    </div>
  );
}
