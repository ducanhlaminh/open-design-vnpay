// WireframeMapView — bảng "từ vựng wireframe (DSL v2) → component của bộ DS"
// trong modal chi tiết DS Figma. Cùng dữ liệu bảng "## Wireframe mapping" của
// catalog.md, nhưng render có cấu trúc: candidate đầu là lựa chọn MẶC ĐỊNH
// (bảng map + panel Gán component prefill từ nó), các candidate sau là phương
// án thay thế; slug không map ghi rõ lý do; cuối cùng là các component đặc thù
// ngoài từ vựng (template màn, charts…).
import { useEffect, useState } from 'react';
import { DsShowcasePreview } from './DsShowcasePreview';

interface WireframeMapDoc {
  slugs: Array<{ slug: string; candidates?: string[]; none?: string }>;
  specials: { templates: string[]; charts: string[]; other: string[] };
  components: string[];
}

const C = {
  ink: 'var(--text, #1a1a1a)',
  soft: 'var(--text-soft, #4b5563)',
  border: 'var(--border, #e1e5eb)',
  paper: 'var(--bg, #faf9f7)',
  subtle: 'var(--bg-subtle, #eef1f5)',
  accent: 'var(--accent, #0066b3)',
} as const;

function CompChip({
  name,
  primary,
  active,
  onClick,
}: {
  name: string;
  primary?: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 6,
        fontSize: 12.5,
        fontFamily: 'ui-monospace, monospace',
        border: `1px solid ${active ? C.ink : primary ? C.accent : C.border}`,
        background: active
          ? `color-mix(in srgb, ${C.accent} 22%, transparent)`
          : primary
            ? `color-mix(in srgb, ${C.accent} 10%, transparent)`
            : C.subtle,
        color: primary || active ? C.accent : C.ink,
        fontWeight: primary || active ? 700 : 500,
        cursor: onClick ? 'pointer' : 'default',
      }}
      title={`${primary ? 'Lựa chọn mặc định (bảng map / prefill của panel Gán component)' : 'Phương án thay thế'} — bấm để xem render thật`}
    >
      {name}
    </button>
  );
}

export function WireframeMapView({ systemId }: { systemId: string }) {
  const [map, setMap] = useState<WireframeMapDoc | null | undefined>(undefined);
  // Chip đang xem render thật (pane preview sticky dưới bảng).
  const [previewComp, setPreviewComp] = useState<string | null>(null);
  useEffect(() => {
    setMap(undefined);
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/design-systems/${encodeURIComponent(systemId)}/wireframe-map`);
        if (!cancelled) setMap(res.ok ? ((await res.json()) as WireframeMapDoc) : null);
      } catch {
        if (!cancelled) setMap(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [systemId]);

  if (map === undefined) {
    return <p style={{ padding: 20, fontSize: 13, color: C.soft }}>Đang tải wireframe map…</p>;
  }
  if (map === null) {
    return (
      <p style={{ padding: 20, fontSize: 13, color: C.ink, lineHeight: 1.6 }}>
        Bộ DS này chưa có wireframe map — import lại từ zip Figma (Fig Pipeline) để sinh
        <code> react/wireframe-map.json</code>.
      </p>
    );
  }

  const mapped = map.slugs.filter((s) => (s.candidates?.length ?? 0) > 0);
  const unmapped = map.slugs.filter((s) => !s.none && (s.candidates?.length ?? 0) === 0);
  const deliberate = map.slugs.filter((s) => s.none);

  const th: React.CSSProperties = {
    textAlign: 'left',
    padding: '8px 12px',
    fontSize: 12,
    fontWeight: 700,
    color: C.soft,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    borderBottom: `1px solid ${C.border}`,
    position: 'sticky',
    top: 0,
    background: C.paper,
  };
  const td: React.CSSProperties = {
    padding: '8px 12px',
    borderBottom: `1px solid ${C.border}`,
    verticalAlign: 'top',
  };

  return (
    <div style={{ height: '100%', overflow: 'auto', background: C.paper, padding: '4px 0 24px' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <p style={{ margin: 0, fontSize: 13, color: C.ink, lineHeight: 1.6 }}>
          Wireframe của UX Spec nói từ vựng chung (DSL v2). Bảng này cho biết mỗi slug wireframe
          dựng bằng component nào của bộ DS — <strong>{mapped.length}</strong> slug có component,{' '}
          <strong>{unmapped.length}</strong> slug bộ này không có (tự dựng bằng <code>tk-*</code>),{' '}
          <strong>{deliberate.length}</strong> slug chủ đích không map.
        </p>

        <table style={{ borderCollapse: 'collapse', width: '100%', border: `1px solid ${C.border}`, borderRadius: 10 }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 210 }}>Wireframe slug</th>
              <th style={th}>Component của bộ DS</th>
            </tr>
          </thead>
          <tbody>
            {mapped.map((entry) => (
              <tr key={entry.slug}>
                <td style={td}>
                  <code style={{ fontSize: 12.5, fontWeight: 700, color: C.ink }}>{entry.slug}</code>
                </td>
                <td style={{ ...td, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {entry.candidates!.map((c, i) => (
                    <CompChip
                      key={c}
                      name={c}
                      primary={i === 0}
                      active={previewComp === c}
                      onClick={() => setPreviewComp((cur) => (cur === c ? null : c))}
                    />
                  ))}
                </td>
              </tr>
            ))}
            {unmapped.map((entry) => (
              <tr key={entry.slug}>
                <td style={td}>
                  <code style={{ fontSize: 12.5, fontWeight: 700, color: C.soft }}>{entry.slug}</code>
                </td>
                <td style={{ ...td, fontSize: 12.5, color: C.soft }}>
                  không có trong bộ DS này — bước UI tự dựng bằng markup + class <code>tk-*</code>
                </td>
              </tr>
            ))}
            {deliberate.map((entry) => (
              <tr key={entry.slug}>
                <td style={td}>
                  <code style={{ fontSize: 12.5, fontWeight: 700, color: C.soft }}>{entry.slug}</code>
                </td>
                <td style={{ ...td, fontSize: 12.5, color: C.soft }}>chủ đích không map — {entry.none}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {map.specials.templates.length || map.specials.charts.length || map.specials.other.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: C.soft, textTransform: 'uppercase', letterSpacing: 0.4 }}>
              Component đặc thù ngoài từ vựng wireframe
            </h3>
            <p style={{ margin: 0, fontSize: 12.5, color: C.ink, lineHeight: 1.5 }}>
              Wireframe tham chiếu các component này qua prop <code>note</code>; bước UI chọn đúng theo catalog.
            </p>
            {(
              [
                ['Template màn nguyên con', map.specials.templates],
                ['Charts', map.specials.charts],
                ['Khác', map.specials.other],
              ] as Array<[string, string[]]>
            )
              .filter(([, items]) => items.length > 0)
              .map(([label, items]) => (
                <div key={label} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'baseline' }}>
                  <strong style={{ fontSize: 12.5, color: C.ink, marginRight: 4 }}>{label}:</strong>
                  {items.map((c) => (
                    <CompChip
                      key={c}
                      name={c}
                      active={previewComp === c}
                      onClick={() => setPreviewComp((cur) => (cur === c ? null : c))}
                    />
                  ))}
                </div>
              ))}
          </div>
        ) : null}
      </div>

      {/* Preview render thật — sticky đáy để bấm chip nào cũng thấy ngay. */}
      {previewComp ? (
        <div style={{ position: 'sticky', bottom: 0, padding: '0 20px 12px', maxWidth: 860, margin: '0 auto' }}>
          <DsShowcasePreview systemId={systemId} comp={previewComp} height={300} />
        </div>
      ) : null}
    </div>
  );
}
