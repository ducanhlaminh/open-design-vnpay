// CompPickerModal — modal chọn component DS cho MỘT node wireframe:
// TRÁI = search + danh sách tên component (nhóm "Gợi ý theo slug" từ bảng
// wireframe-map trước, rồi toàn bộ catalog); PHẢI = preview render THẬT của
// component đang trỏ (DsShowcasePreview — iframe showcase load một lần, đổi
// selection chỉ cuộn). Click row = xem; "Dùng component này" (hoặc
// double-click) = chốt; hàng "(không gán)" gỡ lựa chọn về gợi ý mặc định.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { DsShowcasePreview } from './DsShowcasePreview';

const M = {
  ink: 'var(--text, #1a1a1a)',
  soft: 'var(--text-soft, #4b5563)',
  border: 'var(--border, #e1e5eb)',
  paper: 'var(--bg, #faf9f7)',
  subtle: 'var(--bg-subtle, #eef1f5)',
  accent: 'var(--accent, #0066b3)',
} as const;

export function CompPickerModal({
  systemId,
  slug,
  label,
  candidates,
  components,
  current,
  suggestion,
  onPick,
  onClose,
}: {
  systemId: string;
  /** Slug wireframe của node đang gán (hiện ở header cho ngữ cảnh). */
  slug: string;
  label?: string;
  /** Gợi ý theo slug từ wireframe-map (nhóm đầu danh sách). */
  candidates: string[];
  /** Toàn bộ component của bộ DS. */
  components: string[];
  /** Component đang chốt ('' = chưa). */
  current: string;
  /** Gợi ý mặc định khi chưa chốt (candidate đầu). */
  suggestion?: string;
  onPick: (comp: string | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState<string>(current || suggestion || candidates[0] || components[0] || '');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const match = (name: string) => q.length === 0 || name.toLowerCase().includes(q);
  const candidateSet = useMemo(() => new Set(candidates), [candidates]);
  const suggested = candidates.filter(match);
  const rest = useMemo(
    () => components.filter((c) => !candidateSet.has(c) && match(c)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [components, candidateSet, q],
  );

  const row = (name: string, group: 'suggest' | 'all') => {
    const active = focused === name;
    const isCurrent = current === name;
    return (
      <button
        key={`${group}:${name}`}
        type="button"
        onClick={() => setFocused(name)}
        onDoubleClick={() => {
          onPick(name);
          onClose();
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          padding: '6px 10px',
          border: 0,
          borderLeft: `3px solid ${active ? M.accent : 'transparent'}`,
          background: active ? `color-mix(in srgb, ${M.accent} 10%, transparent)` : 'transparent',
          color: M.ink,
          fontSize: 12.5,
          fontFamily: 'ui-monospace, monospace',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        {isCurrent ? <span style={{ flex: 'none', color: M.accent, fontWeight: 700 }}>✓ đang chốt</span> : null}
        {!isCurrent && suggestion === name ? (
          <span style={{ flex: 'none', color: M.soft, fontSize: 11 }}>gợi ý</span>
        ) : null}
      </button>
    );
  };

  const groupHead = (text: string) => (
    <div style={{ padding: '8px 10px 4px', fontSize: 11, fontWeight: 700, color: M.soft, textTransform: 'uppercase', letterSpacing: 0.4 }}>
      {text}
    </div>
  );

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Chọn component cho ${slug}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1400,
        background: 'rgba(15, 20, 28, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        style={{
          width: 'min(1020px, 96vw)',
          height: 'min(680px, 90vh)',
          background: M.paper,
          border: `1px solid ${M.border}`,
          borderRadius: 14,
          boxShadow: '0 32px 80px rgba(0,0,0,.28)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: `1px solid ${M.border}` }}>
          <strong style={{ fontSize: 14, color: M.ink }}>Chọn component DS</strong>
          <span style={{ fontSize: 12.5, color: M.soft, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            cho <code style={{ color: M.accent }}>{slug}</code>
            {label ? ` · “${label}”` : ''}
          </span>
          <button
            type="button"
            onClick={onClose}
            title="Đóng (Esc)"
            style={{ marginLeft: 'auto', width: 28, height: 28, border: `1px solid ${M.border}`, borderRadius: 7, background: 'transparent', color: M.soft, cursor: 'pointer', fontSize: 13 }}
          >
            ✕
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          {/* Trái: search + danh sách tên */}
          <div style={{ width: 280, flex: 'none', borderRight: `1px solid ${M.border}`, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ padding: 8, borderBottom: `1px solid ${M.border}` }}>
              <input
                type="search"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Tìm trong ${components.length} component…`}
                style={{ width: '100%', fontSize: 12.5, padding: '6px 10px', borderRadius: 7, border: `1px solid ${M.border}`, background: M.paper, color: M.ink, outline: 'none' }}
              />
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 8 }}>
              {current ? (
                <button
                  type="button"
                  onClick={() => {
                    onPick(null);
                    onClose();
                  }}
                  style={{ display: 'block', width: '100%', padding: '7px 10px', border: 0, background: 'transparent', color: M.soft, fontSize: 12, textAlign: 'left', cursor: 'pointer' }}
                >
                  ⃠ Bỏ chốt (quay về gợi ý{suggestion ? `: ${suggestion}` : ' của bảng map'})
                </button>
              ) : null}
              {suggested.length > 0 ? (
                <>
                  {groupHead('Gợi ý theo slug')}
                  {suggested.map((c) => row(c, 'suggest'))}
                </>
              ) : null}
              {rest.length > 0 ? (
                <>
                  {groupHead(q ? 'Kết quả khác' : 'Toàn bộ component')}
                  {rest.map((c) => row(c, 'all'))}
                </>
              ) : null}
              {suggested.length === 0 && rest.length === 0 ? (
                <p style={{ padding: '10px 12px', fontSize: 12.5, color: M.soft }}>Không có component nào khớp “{query}”.</p>
              ) : null}
            </div>
          </div>

          {/* Phải: preview render thật */}
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, padding: 10 }}>
            {focused ? (
              <DsShowcasePreview systemId={systemId} comp={focused} fill />
            ) : (
              <p style={{ padding: 16, fontSize: 12.5, color: M.soft }}>Chọn một component bên trái để xem render thật.</p>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: `1px solid ${M.border}` }}>
          <span style={{ fontSize: 12.5, color: M.soft, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {focused ? (
              <>
                Đang xem: <code style={{ color: M.ink, fontWeight: 700 }}>{focused}</code>
              </>
            ) : (
              'Chưa chọn component nào'
            )}
          </span>
          <button
            type="button"
            onClick={() => {
              if (!focused) return;
              onPick(focused);
              onClose();
            }}
            disabled={!focused}
            style={{ marginLeft: 'auto', padding: '7px 18px', borderRadius: 8, border: 0, background: M.accent, color: '#fff', fontSize: 13, fontWeight: 700, cursor: focused ? 'pointer' : 'not-allowed', opacity: focused ? 1 : 0.6 }}
          >
            Dùng component này
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
