/**
 * F-18 — DSDetailDrawer
 * Slide-in drawer (480px from right) with 4 tabs: Preview, Tokens, Components, Spec.
 * Fetches DS detail on open. Keyboard Escape closes.
 */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../api';
import { MarkdownViewer } from './MarkdownViewer';
import type { DesignSystemSummary } from '../types';

interface DSDetailDrawerProps {
  dsId: string;
  onClose: () => void;
  onSelect: (id: string) => void;
  isSelected?: boolean;
}

type Tab = 'preview' | 'tokens' | 'components' | 'spec';
const TABS: Tab[] = ['preview', 'tokens', 'components', 'spec'];

export function DSDetailDrawer({ dsId, onClose, onSelect, isSelected }: DSDetailDrawerProps) {
  const [tab, setTab] = useState<Tab>('preview');
  const [ds, setDs] = useState<DesignSystemSummary | null>(null);
  const [previewRole, setPreviewRole] = useState('app');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.designSystems.getDesignSystem(dsId)
      .then((data) => {
        setDs(data);
        // Auto-select first available preview role
        const firstRole = data.previewPages?.[0]?.role ?? 'app';
        setPreviewRole(firstRole);
      })
      .finally(() => setLoading(false));
  }, [dsId]);

  // Keyboard: Escape to close
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <>
      {/* Overlay */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.5)',
          zIndex: 300,
        }}
      />

      {/* Drawer panel */}
      <div
        className="drawer"
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: 480, maxWidth: '90vw',
          background: 'var(--color-surface)',
          borderLeft: '1px solid var(--color-border)',
          zIndex: 301,
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text)' }}>
              {loading ? 'Loading...' : ds?.name}
            </div>
            {ds && (
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
                {ds.category} · {ds.sourceType}
              </div>
            )}
          </div>
          <button
            id="ds-drawer-close"
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', padding: 4 }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--color-border)', padding: '0 20px' }}>
          {TABS.map((t) => (
            <button
              key={t}
              id={`ds-drawer-tab-${t}`}
              onClick={() => setTab(t)}
              style={{
                padding: '10px 14px',
                fontSize: 13,
                background: 'none',
                border: 'none',
                borderBottom: `2px solid ${tab === t ? 'var(--color-accent)' : 'transparent'}`,
                color: tab === t ? 'var(--color-accent)' : 'var(--color-text-muted)',
                cursor: 'pointer',
                textTransform: 'capitalize',
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {tab === 'preview' && ds && (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              {ds.previewPages && ds.previewPages.length > 1 && (
                <div style={{ padding: '8px 20px', borderBottom: '1px solid var(--color-border)' }}>
                  <select
                    value={previewRole}
                    onChange={(e) => setPreviewRole(e.target.value)}
                    style={{ fontSize: 12, padding: '3px 8px', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 4, color: 'var(--color-text)' }}
                  >
                    {ds.previewPages.map((p) => (
                      <option key={p.role} value={p.role}>{p.title}</option>
                    ))}
                  </select>
                </div>
              )}
              <iframe
                src={api.designSystems.getPreviewPageUrl(dsId, previewRole)}
                sandbox="allow-scripts allow-same-origin"
                style={{ flex: 1, border: 'none', width: '100%' }}
                title="Design system preview"
              />
            </div>
          )}

          {tab === 'tokens' && (
            <iframe
              src={api.designSystems.getTokensCssUrl(dsId)}
              style={{ flex: 1, border: 'none', width: '100%', fontFamily: 'monospace', fontSize: 12 }}
              title="Design system tokens"
            />
          )}

          {tab === 'components' && (
            ds?.hasComponents ? (
              <iframe
                src={api.designSystems.getComponentsUrl(dsId)}
                sandbox="allow-scripts allow-same-origin"
                style={{ flex: 1, border: 'none', width: '100%' }}
                title="Design system components"
              />
            ) : (
              <div style={{ padding: 24, color: 'var(--color-text-muted)', fontSize: 13, textAlign: 'center' }}>
                No component library for this design system.
              </div>
            )
          )}

          {tab === 'spec' && (
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <MarkdownViewer url={api.designSystems.getDesignMdUrl(dsId)} />
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: 16, borderTop: '1px solid var(--color-border)' }}>
          <button
            id={`ds-drawer-select-${dsId}`}
            onClick={() => onSelect(dsId)}
            style={{
              width: '100%', padding: '10px', fontSize: 14, fontWeight: 600,
              background: isSelected ? 'rgba(124,109,250,0.2)' : 'var(--color-accent)',
              border: `1px solid ${isSelected ? 'var(--color-accent)' : 'transparent'}`,
              borderRadius: 'var(--radius)',
              color: isSelected ? 'var(--color-accent)' : '#fff',
              cursor: 'pointer',
            }}
          >
            {isSelected ? '✓ Using this Design System' : 'Use this Design System'}
          </button>
        </div>
      </div>
    </>
  );
}
