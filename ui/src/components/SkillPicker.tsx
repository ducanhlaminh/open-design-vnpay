/**
 * F-32 — SkillPicker
 * Dropdown to select a skill — compact mode for ChatToolbar.
 */
import { useEffect, useRef, useState } from 'react';
import { Zap, ChevronDown, Check } from 'lucide-react';
import { api } from '../api';
import type { SkillSummary } from '../types';

interface SkillPickerProps {
  selectedId?: string | null;
  onSelect: (id: string) => void;
  compact?: boolean;
  disabled?: boolean;
}

export function SkillPicker({ selectedId, onSelect, compact, disabled }: SkillPickerProps) {
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [search, setSearch] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.skills.listSkills().then((resp) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list = Array.isArray(resp) ? resp : (resp as any).items ?? [];
      setSkills(list);
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (!dropdownRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selected = skills.find((s) => s.id === selectedId);
  const filtered = skills.filter(
    (s) => !search || s.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div ref={dropdownRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        id="skill-picker-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: compact ? '4px 8px' : '6px 12px',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius)',
          color: 'var(--color-text)', fontSize: 13, cursor: 'pointer',
        }}
      >
        <Zap size={13} />
        {!compact && (
          <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selected?.name ?? 'Skill'}
          </span>
        )}
        <ChevronDown size={11} />
      </button>

      {open && (
        <div className="ds-picker-dropdown" id="skill-picker-dropdown">
          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--color-border)' }}>
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search skills..."
              style={{ width: '100%', padding: '4px 8px', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 4, color: 'var(--color-text)', fontSize: 12, outline: 'none' }}
            />
          </div>
          <div style={{ maxHeight: 250, overflowY: 'auto' }}>
            {/* None option */}
            <button
              onClick={() => { onSelect(''); setOpen(false); setSearch(''); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 12px', background: 'transparent', border: 'none', color: 'var(--color-text-muted)', fontSize: 12, cursor: 'pointer' }}
            >
              <Zap size={12} opacity={0.3} />
              <span>No skill</span>
            </button>
            {filtered.map((s) => (
              <button
                key={s.id}
                onClick={() => { onSelect(s.id); setOpen(false); setSearch(''); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 12px', background: selectedId === s.id ? 'rgba(124,109,250,0.12)' : 'transparent', border: 'none', color: 'var(--color-text)', fontSize: 12, cursor: 'pointer', textAlign: 'left' }}
              >
                <Zap size={12} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                {selectedId === s.id && <Check size={11} color="var(--color-accent)" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
