// DsShowcasePreview — preview TRỰC QUAN một component của bộ DS Figma: iframe
// trang showcase compiled (mọi component đã render thật từ react/ source) và
// tự cuộn tới đúng section của component đang chọn.
//
// Showcase là MỘT trang lớn render client-side, không có anchor/hash — nhưng
// được serve same-origin (/api/design-systems/:id/showcase) nên parent đọc
// được DOM đã render: tìm heading có text chuẩn hóa khớp tên component
// (slug `i-pay-button` ≡ tên set "iPay / Button" ≡ tên compiled "IPayButton"
// sau khi bỏ ký tự không chữ-số + lowercase) rồi scrollIntoView + highlight.
// Trang render mất vài giây → retry có nhịp; không thấy thì nói thật.
import { useEffect, useRef, useState } from 'react';

const P = {
  border: 'var(--border, #e1e5eb)',
  soft: 'var(--text-soft, #4b5563)',
  accent: 'var(--accent, #0066b3)',
  paper: 'var(--bg, #faf9f7)',
} as const;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

export function DsShowcasePreview({
  systemId,
  comp,
  height = 340,
  fill = false,
}: {
  systemId: string;
  /** Component slug đang xem (ví dụ `i-pay-button`). */
  comp: string;
  height?: number;
  /** Lấp đầy chiều cao container (modal picker) thay vì height cố định. */
  fill?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<'seeking' | 'found' | 'missing'>('seeking');
  const lastHighlight = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!loaded || !comp) return undefined;
    setStatus('seeking');
    const want = norm(comp);
    let cancelled = false;
    let attempt = 0;
    const tryScroll = () => {
      if (cancelled) return;
      attempt += 1;
      const doc = frameRef.current?.contentDocument;
      if (doc) {
        const headings = doc.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5');
        let hit: HTMLElement | null = null;
        for (const el of headings) {
          if (norm(el.textContent ?? '') === want) {
            hit = el;
            break;
          }
        }
        if (!hit) {
          // Chấp nhận khớp lỏng (heading chứa tên, hoặc ngược lại) khi không
          // có khớp tuyệt đối — tên set có thể kèm hậu tố count.
          for (const el of headings) {
            const text = norm(el.textContent ?? '');
            if (text.includes(want) || (want.length > 6 && text && want.includes(text))) {
              hit = el;
              break;
            }
          }
        }
        if (hit) {
          if (lastHighlight.current) lastHighlight.current.style.outline = '';
          hit.style.scrollMarginTop = '10px';
          hit.style.outline = `3px solid ${'#0066b3'}`;
          hit.style.outlineOffset = '4px';
          lastHighlight.current = hit;
          hit.scrollIntoView({ block: 'start' });
          setStatus('found');
          return;
        }
      }
      if (attempt < 16) {
        window.setTimeout(tryScroll, attempt < 4 ? 350 : 800);
      } else {
        setStatus('missing');
      }
    };
    tryScroll();
    return () => {
      cancelled = true;
    };
  }, [loaded, comp]);

  return (
    <div
      style={{
        border: `1px solid ${P.border}`,
        borderRadius: 10,
        overflow: 'hidden',
        background: P.paper,
        ...(fill ? { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } : {}),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: `1px solid ${P.border}`, fontSize: 12 }}>
        <code style={{ fontWeight: 700, color: P.accent }}>{comp}</code>
        <span style={{ color: P.soft }}>
          {status === 'seeking' ? '— đang tìm trong showcase…' : status === 'missing' ? '— không tìm thấy section (mở tab Showcase của DS để xem tay)' : '— render thật từ bộ DS'}
        </span>
      </div>
      <iframe
        ref={frameRef}
        title={`Preview ${comp}`}
        src={`/api/design-systems/${encodeURIComponent(systemId)}/showcase`}
        onLoad={() => setLoaded(true)}
        style={{
          display: 'block',
          width: '100%',
          border: 0,
          background: '#fff',
          ...(fill ? { flex: 1, minHeight: 0 } : { height }),
        }}
      />
    </div>
  );
}
