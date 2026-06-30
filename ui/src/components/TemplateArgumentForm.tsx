/**
 * F-24 — TemplateArgumentForm
 * Fills {argument name="..."} placeholders for AI prompt templates.
 * Preview substitution in an expandable <details> section.
 */
interface TemplateArgumentFormProps {
  args: Array<{ name: string; default: string }>;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}

export function TemplateArgumentForm({ args, values, onChange }: TemplateArgumentFormProps) {
  if (args.length === 0) return null;

  const set = (key: string, val: string) => onChange({ ...values, [key]: val });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.08em',
      }}>
        Arguments
      </div>
      {args.map((arg) => (
        <div key={arg.name}>
          <label style={{
            display: 'block', fontSize: 12,
            color: 'var(--color-text)', marginBottom: 4,
          }}>
            {arg.name}
          </label>
          <input
            type="text"
            value={values[arg.name] ?? ''}
            placeholder={arg.default || `Enter ${arg.name}...`}
            onChange={(e) => set(arg.name, e.target.value)}
            style={{
              width: '100%',
              background: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              color: 'var(--color-text)',
              fontSize: 12,
              padding: '6px 10px',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          {arg.default && (
            <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 3 }}>
              Default: {arg.default}
            </div>
          )}
        </div>
      ))}

      {/* Preview filled prompt */}
      <details style={{ fontSize: 11, color: 'var(--color-text-muted)', cursor: 'pointer' }}>
        <summary style={{ userSelect: 'none' }}>Preview argument substitution</summary>
        <div style={{
          marginTop: 6, padding: '8px 10px',
          background: 'rgba(0,0,0,0.2)', borderRadius: 6,
          fontSize: 11, lineHeight: 1.5,
          fontFamily: 'monospace',
        }}>
          {args.map((arg) => (
            <div key={arg.name}>
              <span style={{ color: 'var(--color-accent)' }}>{arg.name}</span>
              {' → '}
              {values[arg.name] || arg.default || <em style={{ opacity: 0.5 }}>empty</em>}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
