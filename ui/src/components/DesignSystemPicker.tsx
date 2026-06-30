/**
 * F-16 — DesignSystemPicker
 * Grouped-by-category combobox dropdown for selecting a design system.
 * Used in ChatToolbar, NewProjectDialog.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Layers, Check } from 'lucide-react';
import { api } from '../api';
import { useDesignSystemStore } from '../store/designSystemStore';
import { TokenStrip } from './TokenStrip';
import type { DesignSystemSummary } from '../types';

interface DesignSystemPickerProps {
  selectedId?: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
  compact?: boolean;  // compact=true: icon + token strip only (for toolbar)
  placeholder?: string;
}

export function DesignSystemPicker({
  selectedId,
  onSelect,
  disabled,
  compact,
  placeholder = 'Design System',
}: DesignSystemPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { catalog, categories, loaded, fetchCatalog } = useDesignSystemStore();

  // Fetch catalog on mount (no-op if already loaded)
  useEffect(() => { fetchCatalog(); }, [fetchCatalog]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (!dropdownRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selected = catalog.find((ds) => ds.id === selectedId);

  // Group by category, filtered by search
  const grouped: Record<string, DesignSystemSummary[]> = {};
  const q = search.toLowerCase();
  catalog.forEach((ds) => {
    if (q && !ds.name.toLowerCase().includes(q) && !ds.category.toLowerCase().includes(q)) return;
    if (!grouped[ds.category]) grouped[ds.category] = [];
    grouped[ds.category].push(ds);
  });

  return (
    <div ref={dropdownRef} style={{ position: 'relative', display: 'inline-block' }}>
      {/* Trigger */}
      <button
        id="ds-picker-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || !loaded}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: compact ? '4px 8px' : '6px 12px',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius)',
          color: 'var(--color-text)',
          fontSize: 13,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          minWidth: compact ? 'auto' : 160,
        }}
      >
        <Layers size={14} />
        {!compact && (
          <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selected?.name ?? placeholder}
          </span>
        )}
        {selected && (
          <TokenStrip tokensUrl={api.designSystems.getTokensCssUrl(selected.id)} mini />
        )}
        <ChevronDown size={12} style={{ flexShrink: 0 }} />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="ds-picker-dropdown" id="ds-picker-dropdown">
          {/* Search */}
          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--color-border)' }}>
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search design systems..."
              style={{
                width: '100%',
                padding: '4px 8px',
                background: 'var(--color-bg)',
                border: '1px solid var(--color-border)',
                borderRadius: 4,
                color: 'var(--color-text)',
                fontSize: 12,
                outline: 'none',
              }}
            />
          </div>

          {/* Groups */}
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {categories
              .filter((cat) => grouped[cat]?.length > 0)
              .map((category) => (
                <div key={category}>
                  <div className="ds-picker-category">{category}</div>
                  {grouped[category].map((ds) => (
                    <button
                      key={ds.id}
                      onClick={() => { onSelect(ds.id); setOpen(false); setSearch(''); }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        width: '100%',
                        padding: '6px 12px',
                        background: selectedId === ds.id ? 'rgba(124,109,250,0.12)' : 'transparent',
                        border: 'none',
                        color: 'var(--color-text)',
                        fontSize: 13,
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <TokenStrip tokensUrl={api.designSystems.getTokensCssUrl(ds.id)} mini />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ds.name}
                      </span>
                      {selectedId === ds.id && <Check size={12} color="var(--color-accent)" />}
                    </button>
                  ))}
                </div>
              ))}
            {Object.keys(grouped).length === 0 && (
              <div style={{ padding: 16, color: 'var(--color-text-muted)', fontSize: 13, textAlign: 'center' }}>
                No results for &quot;{search}&quot;
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
