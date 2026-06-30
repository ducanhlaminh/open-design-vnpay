/**
 * F-20 — TemplateInputForm
 * Form for filling DesignTemplate inputs: text/select/boolean/number.
 */
import type { TemplateInput } from '../types';

interface TemplateInputFormProps {
  inputs: TemplateInput[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}

const inputStyle = {
  width: '100%',
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  color: 'var(--color-text)',
  fontSize: 13,
  padding: '8px 12px',
  outline: 'none',
  boxSizing: 'border-box' as const,
};

export function TemplateInputForm({ inputs, values, onChange }: TemplateInputFormProps) {
  if (inputs.length === 0) return null;

  const set = (key: string, val: string) => onChange({ ...values, [key]: val });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h4 style={{
        fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0,
      }}>
        Template Inputs
      </h4>

      {inputs.map((input) => (
        <div key={input.name}>
          <label style={{
            display: 'block', fontSize: 12, fontWeight: 500,
            color: 'var(--color-text)', marginBottom: 5,
          }}>
            {input.name}
            {input.required && <span style={{ color: '#fa5050', marginLeft: 3 }}>*</span>}
          </label>

          {input.type === 'text' ? (
            <textarea
              value={values[input.name] ?? input.default ?? ''}
              onChange={(e) => set(input.name, e.target.value)}
              placeholder={input.placeholder ?? input.default ?? `Enter ${input.name}...`}
              rows={3}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          ) : input.type === 'select' && input.options ? (
            <select
              value={values[input.name] ?? input.default ?? ''}
              onChange={(e) => set(input.name, e.target.value)}
              style={inputStyle}
            >
              {input.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          ) : input.type === 'boolean' ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={values[input.name] === 'true' || (!values[input.name] && input.default === 'true')}
                onChange={(e) => set(input.name, String(e.target.checked))}
              />
              <span style={{ fontSize: 13, color: 'var(--color-text)' }}>
                {input.placeholder ?? 'Enable'}
              </span>
            </label>
          ) : (
            <input
              type={input.type === 'number' ? 'number' : 'text'}
              value={values[input.name] ?? input.default ?? ''}
              onChange={(e) => set(input.name, e.target.value)}
              placeholder={input.placeholder ?? input.default ?? `Enter ${input.name}...`}
              style={inputStyle}
            />
          )}
        </div>
      ))}
    </div>
  );
}
