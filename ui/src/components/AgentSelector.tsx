/**
 * F-33 — AgentSelector
 * Dropdown to select an agent — "Auto" as default.
 */
import { useEffect, useRef, useState } from 'react';
import { Bot, ChevronDown, Check } from 'lucide-react';
import { api } from '../api';
import type { AgentInfo } from '../types';

interface AgentSelectorProps {
  selectedId?: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
}

export function AgentSelector({ selectedId, onSelect, disabled }: AgentSelectorProps) {
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.agents.listAgents().then((resp) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list = Array.isArray(resp) ? resp : (resp as any).agents ?? [];
      setAgents(list);
    }).catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (!dropdownRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selected = agents.find((a) => a.id === selectedId);

  return (
    <div ref={dropdownRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        id="agent-selector-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '4px 8px',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius)',
          color: 'var(--color-text)', fontSize: 12, cursor: 'pointer',
        }}
      >
        <Bot size={13} />
        <span style={{ maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected?.name ?? 'Auto'}
        </span>
        <ChevronDown size={10} />
      </button>

      {open && agents.length > 0 && (
        <div className="ds-picker-dropdown" id="agent-selector-dropdown">
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {agents.map((a) => (
              <button
                key={a.id}
                onClick={() => { onSelect(a.id); setOpen(false); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 12px', background: selectedId === a.id ? 'rgba(124,109,250,0.12)' : 'transparent', border: 'none', color: 'var(--color-text)', fontSize: 12, cursor: 'pointer', textAlign: 'left' }}
              >
                <Bot size={12} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500 }}>{a.name}</div>
                  {a.description && <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{a.description}</div>}
                </div>
                {selectedId === a.id && <Check size={11} color="var(--color-accent)" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
