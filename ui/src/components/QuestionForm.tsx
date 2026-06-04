/**
 * T28 — QuestionForm Component
 * Turn-1 discovery form — render từ SSE `question_form` event.
 * SRS FR-07.1, URD US-02-01
 */
import { useState } from 'react';
import type { FormField, QuestionFormEvent } from '../api/runs/http';

interface QuestionFormProps {
  form: QuestionFormEvent;
  onSubmit: (answers: Record<string, string>) => void;
  onSkip?: () => void;
  disabled?: boolean;
}

export function QuestionForm({ form, onSubmit, onSkip, disabled }: QuestionFormProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const setAnswer = (id: string, value: string) =>
    setAnswers((prev) => ({ ...prev, [id]: value }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(answers);
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius)',
        padding: 24,
        maxWidth: 560,
      }}
    >
      <h3
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: 'var(--color-text)',
          marginBottom: 20,
        }}
      >
        {form.title ?? 'Tell me about your project'}
      </h3>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {form.fields.map((field) => (
          <FieldRenderer
            key={field.id}
            field={field}
            value={answers[field.id] ?? ''}
            onChange={(v) => setAnswer(field.id, v)}
            disabled={disabled}
          />
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 10,
          marginTop: 24,
        }}
      >
        {onSkip && (
          <button
            type="button"
            onClick={onSkip}
            disabled={disabled}
            style={btnStyle('ghost')}
          >
            Skip
          </button>
        )}
        <button type="submit" disabled={disabled} style={btnStyle('primary')}>
          Continue →
        </button>
      </div>
    </form>
  );
}

function FieldRenderer({
  field,
  value,
  onChange,
  disabled,
}: {
  field: FormField;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <label
        htmlFor={field.id}
        style={{
          display: 'block',
          fontSize: 13,
          fontWeight: 500,
          color: 'var(--color-text)',
          marginBottom: 8,
        }}
      >
        {field.label}
        {field.required && <span style={{ color: '#fa4949', marginLeft: 3 }}>*</span>}
      </label>

      {field.type === 'radio' && field.options && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {field.options.map((opt) => (
            <label key={opt} style={{ cursor: 'pointer' }}>
              <input
                type="radio"
                name={field.id}
                value={opt}
                checked={value === opt}
                onChange={() => onChange(opt)}
                disabled={disabled}
                style={{ display: 'none' }}
              />
              <span
                style={{
                  display: 'inline-block',
                  padding: '6px 14px',
                  borderRadius: 20,
                  border: `1px solid ${value === opt ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  background: value === opt ? 'rgba(124,109,250,0.15)' : 'transparent',
                  color: value === opt ? 'var(--color-accent)' : 'var(--color-text-muted)',
                  fontSize: 13,
                  transition: 'all 0.15s',
                  userSelect: 'none',
                }}
              >
                {opt}
              </span>
            </label>
          ))}
        </div>
      )}

      {field.type === 'text' && (
        <input
          id={field.id}
          type="text"
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          style={inputStyle}
        />
      )}

      {field.type === 'select' && field.options && (
        <select
          id={field.id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          style={{ ...inputStyle, cursor: 'pointer' }}
        >
          <option value="">Select…</option>
          {field.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  color: 'var(--color-text)',
  fontSize: 13,
  padding: '8px 12px',
  outline: 'none',
};

function btnStyle(variant: 'primary' | 'ghost'): React.CSSProperties {
  return {
    padding: '8px 18px',
    borderRadius: 8,
    border: variant === 'primary' ? 'none' : '1px solid var(--color-border)',
    background: variant === 'primary' ? 'var(--color-accent)' : 'transparent',
    color: variant === 'primary' ? '#fff' : 'var(--color-text-muted)',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  };
}
