# F-12..F-15 — P1A: Primitive Components

**Phase**: P1A | **Estimate**: ~8h | **Depends on**: F-01..F-11 (P0)  
**Target dir**: `ui/src/components/` và `ui/src/components/shared/`

---

## F-12 — `src/components/TokenStrip.tsx`

**Estimate**: 3h  
**Mục đích**: Render color swatches từ `tokens.css` — dùng trong DSCard, DSPicker

```tsx
import { useEffect, useState } from 'react';

interface TokenStripProps {
  tokensUrl: string | null;
  mini?: boolean;   // mini=true: 4 swatches 12px | false: 6 swatches 18px
  className?: string;
}

// Parse --color-* CSS variables (bỏ qua text/bg/surface/border để lấy brand colors)
function parseColorTokens(css: string, limit: number): string[] {
  const matches = css.matchAll(
    /--color-(?!text|bg|surface|border|muted|overlay)[^:]+:\s*([^;]+)/g,
  );
  return [...matches]
    .map((m) => m[1].trim())
    .filter((v) => v.startsWith('#') || v.startsWith('hsl') || v.startsWith('rgb'))
    .slice(0, limit);
}

export function TokenStrip({ tokensUrl, mini = false, className }: TokenStripProps) {
  const [colors, setColors] = useState<string[]>([]);

  useEffect(() => {
    if (!tokensUrl) {
      setColors([]);
      return;
    }
    let cancelled = false;
    fetch(tokensUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.text();
      })
      .then((css) => {
        if (!cancelled) setColors(parseColorTokens(css, mini ? 4 : 6));
      })
      .catch(() => {
        if (!cancelled) setColors([]);
      });
    return () => { cancelled = true; };
  }, [tokensUrl, mini]);

  const size = mini ? 12 : 18;

  if (colors.length === 0) {
    // Placeholder swatches khi loading/empty
    return (
      <div style={{ display: 'flex', gap: 2 }}>
        {Array.from({ length: mini ? 4 : 6 }).map((_, i) => (
          <div
            key={i}
            style={{
              width: size,
              height: size,
              borderRadius: 3,
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              opacity: 0.4,
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 2 }} className={className}>
      {colors.map((c, i) => (
        <div
          key={i}
          title={c}
          style={{
            width: size,
            height: size,
            borderRadius: 3,
            background: c,
            border: '1px solid rgba(255,255,255,0.08)',
            flexShrink: 0,
          }}
        />
      ))}
    </div>
  );
}
```

**CSS cần thêm vào `index.css`**:
```css
/* TokenStrip loading shimmer (optional) */
@keyframes shimmer {
  0%   { opacity: 0.3; }
  50%  { opacity: 0.6; }
  100% { opacity: 0.3; }
}
```

**Test thủ công**:
```tsx
// Trong browser console hoặc test page:
<TokenStrip tokensUrl="http://localhost:8086/api/v1/design-systems/airbnb/tokens.css" />
// Expected: 6 color swatches từ Airbnb DS
```

---

## F-13 — `src/components/MarkdownViewer.tsx`

**Estimate**: 2h  
**Mục đích**: Fetch markdown URL và render dưới dạng HTML — dùng trong DSDetailDrawer (spec tab)

```tsx
import { useEffect, useState } from 'react';

interface MarkdownViewerProps {
  url: string;
  className?: string;
}

// Simple markdown → HTML parser (không cần thư viện nặng)
// Chỉ cần: headers, bold, italic, code blocks, lists
function simpleMarkdown(md: string): string {
  return md
    // Headers
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold + italic
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Code blocks
    .replace(/```[\w]*\n([\s\S]+?)```/g, '<pre><code>$1</code></pre>')
    // Unordered lists
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>(\n|$))+/g, '<ul>$&</ul>')
    // Paragraphs (double newlines)
    .replace(/\n\n/g, '</p><p>')
    // Wrap in paragraph
    .replace(/^(.+)$/, '<p>$1</p>');
}

export function MarkdownViewer({ url, className }: MarkdownViewerProps) {
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!url) return;
    setLoading(true);
    setError('');
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((md) => setHtml(simpleMarkdown(md)))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [url]);

  if (loading) {
    return (
      <div style={{ padding: 24, color: 'var(--color-text-muted)', fontSize: 13 }}>
        Loading...
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 24, color: '#fa5050', fontSize: 13 }}>
        Failed to load: {error}
      </div>
    );
  }

  return (
    <div
      className={`markdown-viewer ${className ?? ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
      style={{
        padding: 16,
        fontSize: 13,
        lineHeight: 1.7,
        color: 'var(--color-text)',
        overflowY: 'auto',
      }}
    />
  );
}
```

**CSS cần thêm vào `index.css`**:
```css
.markdown-viewer h1 { font-size: 20px; font-weight: 700; margin: 16px 0 8px; }
.markdown-viewer h2 { font-size: 16px; font-weight: 600; margin: 12px 0 6px; }
.markdown-viewer h3 { font-size: 14px; font-weight: 600; margin: 10px 0 4px; }
.markdown-viewer h4 { font-size: 13px; font-weight: 600; margin: 8px 0 4px; }
.markdown-viewer code {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  background: rgba(255,255,255,0.06);
  padding: 2px 5px;
  border-radius: 3px;
}
.markdown-viewer pre code {
  display: block;
  padding: 12px;
  overflow-x: auto;
  background: rgba(0,0,0,0.3);
  border-radius: 6px;
}
.markdown-viewer ul { padding-left: 20px; margin: 6px 0; }
.markdown-viewer li { margin: 3px 0; }
```

---

## F-14 — `src/components/MarkdownMessage.tsx`

**Estimate**: 2h  
**Mục đích**: Render streaming markdown từ chat assistant — cursor animation khi đang stream

```tsx
interface MarkdownMessageProps {
  text: string;
  isStreaming?: boolean;
}

// Sử dụng cùng simpleMarkdown() từ MarkdownViewer, hoặc import dùng chung
// Khác MarkdownViewer: render trực tiếp từ prop 'text' (không fetch URL)

export function MarkdownMessage({ text, isStreaming = false }: MarkdownMessageProps) {
  const html = simpleMarkdown(text);

  return (
    <div
      className="markdown-message"
      style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--color-text)' }}
    >
      <span
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {isStreaming && (
        <span
          className="streaming-cursor"
          style={{
            display: 'inline-block',
            width: 2,
            height: '1em',
            background: 'var(--color-accent)',
            marginLeft: 2,
            verticalAlign: 'middle',
            animation: 'blink 0.7s step-end infinite',
          }}
        />
      )}
    </div>
  );
}
```

**CSS cần thêm vào `index.css`**:
```css
@keyframes blink {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0; }
}
.streaming-cursor { animation: blink 0.7s step-end infinite; }

/* Inherit markdown styles từ .markdown-viewer cho .markdown-message */
.markdown-message h1, .markdown-message h2,
.markdown-message h3, .markdown-message h4,
.markdown-message code, .markdown-message pre,
.markdown-message ul, .markdown-message li {
  /* same styles as .markdown-viewer equivalents */
}
```

> **Refactor tip**: Tách `simpleMarkdown()` vào `src/utils/markdown.ts` để dùng chung cho cả `MarkdownViewer` và `MarkdownMessage`.

---

## F-15 — `src/components/shared/StatusDot.tsx` + `SpinnerIcon.tsx`

**Estimate**: 1h  
**Mục đích**: Reusable status indicators cho MediaTaskCard, job tracking

### `StatusDot.tsx`

```tsx
type Status = 'pending' | 'processing' | 'done' | 'failed';

interface StatusDotProps {
  status: Status;
  size?: number;
  showLabel?: boolean;
}

const STATUS_CONFIG: Record<Status, { color: string; label: string }> = {
  pending:    { color: '#f5a623', label: 'Pending' },
  processing: { color: 'var(--color-accent)', label: 'Processing' },
  done:       { color: '#6ac47e', label: 'Done' },
  failed:     { color: '#fa5050', label: 'Failed' },
};

export function StatusDot({ status, size = 8, showLabel = false }: StatusDotProps) {
  const { color, label } = STATUS_CONFIG[status];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          background: color,
          flexShrink: 0,
          animation: status === 'processing' ? 'pulse 1s ease-in-out infinite' : 'none',
        }}
      />
      {showLabel && (
        <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{label}</span>
      )}
    </span>
  );
}
```

### `SpinnerIcon.tsx`

```tsx
interface SpinnerIconProps {
  size?: number;
  color?: string;
}

export function SpinnerIcon({ size = 16, color = 'var(--color-accent)' }: SpinnerIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ animation: 'spin 0.7s linear infinite', flexShrink: 0 }}
    >
      <circle cx="12" cy="12" r="10" stroke={color} strokeOpacity="0.2" strokeWidth="3" />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
```

**CSS cần thêm vào `index.css`**:
```css
@keyframes spin  { to { transform: rotate(360deg); } }
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.4; }
}
```

---

## Checklist P1A

- [x] F-12: `TokenStrip.tsx` — fetch + parse CSS vars, mini/normal sizes, loading placeholder
- [x] F-13: `MarkdownViewer.tsx` — fetch URL, simpleMarkdown parser, error state
- [x] F-14: `MarkdownMessage.tsx` — streaming cursor animation, reuse simpleMarkdown
- [x] F-15: `StatusDot.tsx` + `SpinnerIcon.tsx` — 4 statuses, pulse animation

**CSS additions verify**:
```bash
# Kiểm tra các keyframes đã có trong index.css
grep -n "@keyframes" ui/open-design-vnpay/ui/src/index.css
# Expected: shimmer, blink, spin, pulse
```
