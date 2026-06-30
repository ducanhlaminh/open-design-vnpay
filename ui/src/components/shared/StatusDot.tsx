/**
 * F-15a — StatusDot
 * Reusable status indicator for MediaTaskCard, job tracking.
 * Supports: pending | processing | done | failed
 */
type Status = 'pending' | 'processing' | 'done' | 'failed';

interface StatusDotProps {
  status: Status;
  size?: number;
  showLabel?: boolean;
}

const STATUS_CONFIG: Record<Status, { color: string; label: string }> = {
  pending:    { color: '#f5a623', label: 'Pending' },
  processing: { color: 'var(--color-accent)', label: 'Processing' },
  done:       { color: '#6ac47e', label: 'Done' },
  failed:     { color: '#fa5050', label: 'Failed' },
};

export function StatusDot({ status, size = 8, showLabel = false }: StatusDotProps) {
  const { color, label } = STATUS_CONFIG[status];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          background: color,
          flexShrink: 0,
          animation: status === 'processing' ? 'pulse 1s ease-in-out infinite' : 'none',
        }}
      />
      {showLabel && (
        <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{label}</span>
      )}
    </span>
  );
}
