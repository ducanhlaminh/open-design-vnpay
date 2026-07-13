// WireFrameView — render a UX-spec wireframe (`wireframes/<id>.wire.json`).
//
// TWO input shapes (a doc may carry either):
//   • `layout`  — the PREFERRED shape: a flexbox layout TREE (stack / row / leaf)
//                 the agent authors. The renderer lays it out with real CSS
//                 flexbox, so it can NEVER overlap or misalign — the agent only
//                 declares structure (which LLMs do well), not pixel coordinates
//                 (which they do badly). This is what fixes the scattered/overlap
//                 wireframes the free-coordinate format produced.
//   • `objects` — LEGACY: wiretext objects placed on an absolute character grid.
//                 Still rendered for older files + files hand-edited in wiretext.
//
// Styled to echo wiretext.app's aesthetic: monospace, a dotted-grid canvas, and
// clean rounded boxes. `wiretextEditUrl` exports either shape to the editor.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { compressToEncodedURIComponent } from 'lz-string';
import { Icon } from './Icon';

/* ── Layout-tree shape (preferred) ───────────────────────────────────────── */
export interface WireLeaf {
  /** One of the component/text/box kinds below (see LeafBody). */
  componentType?: string;
  type?: string; // 'text' | 'box' | 'component' (optional; inferred from componentType)
  label?: string;
  content?: string;
  placeholder?: string;
  hint?: string;
  checked?: boolean;
  required?: boolean;
  active?: boolean;
  columns?: string[];
  rows?: string[][];
  navItems?: string[];
  tabs?: string[];
  activeTab?: number;
  items?: string[];
  chips?: string[];
  progress?: number;
  activeStep?: number;
  value?: number;
  maxValue?: number;
  icon?: string;
  alertType?: string;
  /** flex-grow (fill remaining space in a row). */
  grow?: number;
  /** fixed width in px (a sidebar column, a chip). */
  w?: number;
  [key: string]: unknown;
}
export interface WireContainer {
  /** column stack (default) or horizontal row. */
  dir: 'stack' | 'row';
  children: WireNode[];
  gap?: 'sm' | 'md' | 'lg' | 'none';
  align?: 'start' | 'center' | 'end' | 'between' | 'stretch';
  /** render a bordered card around the group. */
  card?: boolean;
  /** section label shown above the group. */
  label?: string;
  grow?: number;
  w?: number;
  pad?: boolean;
}
export type WireNode = WireContainer | WireLeaf;

/* ── Legacy absolute-grid shape ──────────────────────────────────────────── */
export interface WireObject {
  id?: string;
  type: string;
  position?: { col: number; row: number };
  width?: number;
  height?: number;
  zIndex?: number;
  label?: string;
  content?: string;
  componentType?: string;
  checked?: boolean;
  columns?: string[];
  rows?: string[][];
  navItems?: string[];
  tabs?: string[];
  items?: string[];
  progress?: number;
  activeStep?: number;
  value?: number;
  maxValue?: number;
  icon?: string;
  alertType?: string;
  fromId?: string;
  toId?: string;
  [key: string]: unknown;
}
export interface WireDoc {
  /** Base flexbox layout tree. For a mobile app screen this is the only tree;
   *  for a web screen it is the DESKTOP design (and the fallback for any device
   *  in `layouts` that wasn't authored). */
  layout?: WireNode;
  /** Per-device REDESIGNS (web only). Tablet / mobile carry their own tree —
   *  a genuinely different layout, not the desktop tree reflowed. A device
   *  absent here falls back to `layout` (reflow). */
  layouts?: Partial<Record<'desktop' | 'tablet' | 'mobile', WireNode>>;
  /** This screen is an OVERLAY on top of a base screen (a dialog, a slide-in
   *  drawer, or a bottom sheet) rather than a full page. The renderer frames it
   *  as that layer over a dimmed backdrop. Mirrors the ux-spec screen's
   *  `overlay_kind`. */
  overlay?: 'dialog' | 'drawer' | 'sheet';
  /** Id of the base screen this overlays (its wireframe is shown dimmed behind).
   *  Mirrors the ux-spec screen's `overlay_of`. */
  overlayOf?: string;
  /** Legacy: absolute-positioned wiretext objects. */
  objects?: WireObject[];
}

const isContainer = (n: WireNode): n is WireContainer =>
  typeof (n as WireContainer).dir === 'string' && Array.isArray((n as WireContainer).children);

/* ── Theme + wiretext-ish aesthetic ──────────────────────────────────────── */
const T = {
  ink: 'var(--text, #1f2430)',
  soft: 'var(--text-soft, #4b5563)',
  muted: 'var(--text-muted, #7a8496)',
  faint: 'var(--text-muted, #9aa4b2)',
  line: 'var(--border, #c9cfda)',
  lineSoft: 'var(--border-soft, #dfe3ea)',
  paper: 'var(--bg-panel, #ffffff)',
  fill: 'var(--bg-subtle, #f3f5f8)',
  accent: 'var(--accent, #1f2430)', // wiretext is monochrome; keep accents subtle
  radius: 8,
  mono: "'SF Mono', ui-monospace, 'JetBrains Mono', 'Roboto Mono', Menlo, monospace",
};
const GAP = { none: 0, sm: 6, md: 12, lg: 20 } as const;
const alignMap: Record<string, CSSProperties['alignItems']> = {
  start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', between: 'stretch',
};

const box: CSSProperties = {
  border: `1.5px solid ${T.line}`,
  borderRadius: T.radius,
  background: T.paper,
  boxSizing: 'border-box',
};
const trunc: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const rowMid: CSSProperties = { display: 'flex', alignItems: 'center' };

function Skel({ w = '60%' }: { w?: string }) {
  return <i style={{ display: 'inline-block', height: 8, width: w, borderRadius: 999, background: T.lineSoft }} />;
}

/* ── Leaf renderer (natural height, fills its flex box width) ─────────────── */
function LeafBody({ o }: { o: WireLeaf }) {
  const kind = (o.componentType ?? o.type ?? 'text').toLowerCase();
  const label = o.label ?? o.content ?? '';
  const field = (inner: ReactNode): ReactNode => (
    <div style={{ ...box, ...rowMid, gap: 8, minHeight: 40, padding: '0 12px', fontSize: 12.5, color: T.muted }}>
      {inner}
    </div>
  );
  switch (kind) {
    case 'heading':
    case 'title':
      return <div style={{ fontSize: 15, fontWeight: 700, color: T.ink }}>{label}</div>;
    case 'text':
    case 'label':
    case 'paragraph':
      return <div style={{ fontSize: 12.5, color: T.soft, lineHeight: 1.5 }}>{label}</div>;
    case 'section':
      return (
        <div style={{ ...rowMid, gap: 8, fontSize: 11.5, fontWeight: 700, color: T.ink, letterSpacing: 0.2 }}>
          <i style={{ width: 6, height: 6, borderRadius: '50%', background: T.ink }} />
          {label}
        </div>
      );
    case 'link':
      return <span style={{ fontSize: 12.5, color: T.soft, textDecoration: 'underline', textUnderlineOffset: 2 }}>{label}</span>;
    case 'input':
    case 'search':
    case 'textinput':
      return field(
        <>
          {(kind === 'search' || /tìm|search/i.test(label)) && <Icon name="search" size={14} />}
          <span style={{ ...trunc, flex: 1 }}>{o.placeholder ?? label ?? 'Nhập…'}</span>
          {o.hint ? <span style={{ color: T.faint }}>{o.hint}</span> : null}
        </>,
      );
    case 'textarea':
      return (
        <div style={{ ...box, minHeight: 72, padding: '10px 12px', fontSize: 12.5, color: T.muted, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span>{o.placeholder ?? label ?? 'Nội dung…'}</span>
          {o.hint ? <span style={{ marginTop: 'auto', alignSelf: 'flex-end', fontSize: 11, color: T.faint }}>{o.hint}</span> : null}
        </div>
      );
    case 'select':
    case 'dropdown':
    case 'combobox':
      return field(
        <>
          <span style={{ ...trunc, flex: 1 }}>{label || 'Chọn…'}</span>
          <span style={{ color: T.faint }}>▾</span>
        </>,
      );
    case 'checkbox':
    case 'radio':
      return (
        <div style={{ ...rowMid, gap: 8, fontSize: 12.5, color: T.ink }}>
          <i style={{ width: 15, height: 15, flexShrink: 0, border: `1.5px solid ${T.line}`, background: o.checked ? T.ink : T.paper, borderRadius: kind === 'radio' ? '50%' : 4 }} />
          <span style={trunc}>{label}</span>
        </div>
      );
    case 'toggle':
    case 'switch':
      return (
        <div style={{ ...rowMid, justifyContent: 'space-between', gap: 8, fontSize: 12.5, color: T.ink }}>
          <span style={trunc}>{label}</span>
          <i style={{ display: 'flex', width: 30, height: 16, flexShrink: 0, alignItems: 'center', justifyContent: o.checked ? 'flex-end' : 'flex-start', borderRadius: 999, background: o.checked ? T.ink : T.lineSoft, padding: 2, boxSizing: 'border-box' }}>
            <i style={{ width: 12, height: 12, borderRadius: '50%', background: T.paper }} />
          </i>
        </div>
      );
    case 'button':
    case 'cta': {
      const primary = o.active !== false && (o.grow || /tiếp|xác nhận|lưu|continue|submit|save|đăng nhập/i.test(label));
      return (
        <div style={{ ...box, ...rowMid, justifyContent: 'center', minHeight: 42, padding: '0 16px', fontSize: 13, fontWeight: 700, background: primary ? T.ink : T.paper, color: primary ? T.paper : T.ink, border: `1.5px solid ${T.ink}` }}>
          <span style={trunc}>{o.icon ? `${o.icon} ` : ''}{label || 'Button'}</span>
        </div>
      );
    }
    case 'chip':
    case 'tag':
      return (
        <div style={{ ...box, ...rowMid, gap: 6, minHeight: 34, padding: '0 12px', borderRadius: 999, fontSize: 12.5, color: T.ink }}>
          <i style={{ width: 6, height: 6, borderRadius: '50%', background: o.checked ? T.ink : T.lineSoft }} />
          <span style={trunc}>{label}</span>
        </div>
      );
    case 'chips':
    case 'chipgroup':
      return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {(o.chips ?? o.items ?? [label]).map((c, i) => (
            <div key={i} style={{ ...box, ...rowMid, gap: 6, minHeight: 34, padding: '0 12px', borderRadius: 999, fontSize: 12.5, color: T.ink }}>
              <i style={{ width: 6, height: 6, borderRadius: '50%', background: i === (o.activeStep ?? -1) ? T.ink : T.lineSoft }} />
              <span style={trunc}>{c}</span>
            </div>
          ))}
        </div>
      );
    case 'tabs':
    case 'tabbar':
      return (
        <div style={{ display: 'flex', gap: 20, borderBottom: `1.5px solid ${T.lineSoft}`, fontSize: 12.5 }}>
          {(o.tabs ?? o.items ?? ['Tab 1', 'Tab 2']).map((t, i) => (
            <span key={i} style={{ padding: '6px 0', fontWeight: i === (o.activeTab ?? 0) ? 700 : 400, color: i === (o.activeTab ?? 0) ? T.ink : T.muted, borderBottom: i === (o.activeTab ?? 0) ? `2px solid ${T.ink}` : '2px solid transparent', marginBottom: -1.5 }}>
              {t}
            </span>
          ))}
        </div>
      );
    case 'navbar':
      return (
        <div style={{ ...rowMid, justifyContent: 'space-between', gap: 12 }}>
          <span style={{ ...rowMid, gap: 8, fontSize: 13, fontWeight: 700, color: T.ink }}>
            {label ? <>← {label}</> : <Icon name="chevron-left" size={16} />}
          </span>
          <span style={{ display: 'flex', gap: 16, fontSize: 12.5, color: T.muted }}>
            {(o.navItems ?? []).map((n, i) => <span key={i}>{n}</span>)}
          </span>
        </div>
      );
    case 'list': {
      const items = o.items ?? (label ? [label] : ['Mục 1', 'Mục 2', 'Mục 3']);
      return (
        <div style={{ ...box, overflow: 'hidden' }}>
          {items.map((it, i) => (
            <div key={i} style={{ ...rowMid, gap: 10, padding: '10px 12px', borderTop: i ? `1px solid ${T.lineSoft}` : undefined }}>
              <i style={{ width: 26, height: 26, flexShrink: 0, borderRadius: '50%', background: T.fill }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ ...trunc, fontSize: 12.5, color: T.ink }}>{it}</div>
                <div style={{ marginTop: 5 }}><Skel w="40%" /></div>
              </div>
              <span style={{ color: T.faint }}>›</span>
            </div>
          ))}
        </div>
      );
    }
    case 'table': {
      const cols = o.columns ?? ['Cột A', 'Cột B', 'Cột C'];
      const rows = o.rows ?? [[], [], []];
      const grid: CSSProperties = { display: 'grid', gridTemplateColumns: `repeat(${cols.length}, 1fr)` };
      return (
        <div style={{ ...box, overflow: 'hidden', fontSize: 11.5 }}>
          <div style={{ ...grid, background: T.fill, fontWeight: 700, color: T.soft }}>
            {cols.map((c, i) => <span key={i} style={{ ...trunc, padding: '7px 10px' }}>{c}</span>)}
          </div>
          {rows.map((r, i) => (
            <div key={i} style={{ ...grid, borderTop: `1px solid ${T.lineSoft}` }}>
              {cols.map((_, j) => <span key={j} style={{ ...trunc, padding: '7px 10px', color: T.muted }}>{r[j] ?? <Skel w="70%" />}</span>)}
            </div>
          ))}
        </div>
      );
    }
    case 'card':
      return (
        <div style={{ ...box, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {label ? <div style={{ fontSize: 12.5, fontWeight: 700, color: T.ink }}>{label}</div> : null}
          <Skel w="80%" /><Skel w="55%" />
        </div>
      );
    case 'stat':
    case 'kpi':
      return (
        <div style={{ ...box, padding: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, color: T.muted }}>{label}</span>
          <span style={{ fontSize: 20, fontWeight: 700, color: T.ink }}>{o.hint ?? '—'}</span>
        </div>
      );
    case 'progress':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ height: 8, borderRadius: 999, background: T.lineSoft, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.min(100, Math.max(0, o.progress ?? 60))}%`, background: T.ink, borderRadius: 999 }} />
          </div>
          {label ? <span style={{ fontSize: 11, color: T.muted }}>{label}</span> : null}
        </div>
      );
    case 'stepper':
      return (
        <div style={{ ...rowMid, fontSize: 11.5 }}>
          {(o.items ?? ['Bước 1', 'Bước 2']).map((it, i, arr) => (
            <span key={i} style={rowMid}>
              <span style={{ ...rowMid, gap: 5, fontWeight: i === (o.activeStep ?? 0) ? 700 : 400, color: i <= (o.activeStep ?? 0) ? T.ink : T.faint }}>
                <i style={{ width: 10, height: 10, borderRadius: '50%', background: i <= (o.activeStep ?? 0) ? T.ink : T.paper, border: `1.5px solid ${i <= (o.activeStep ?? 0) ? T.ink : T.line}` }} />
                {it}
              </span>
              {i < arr.length - 1 && <i style={{ width: 22, height: 1.5, background: T.lineSoft, margin: '0 8px' }} />}
            </span>
          ))}
        </div>
      );
    case 'avatar':
      return <i style={{ display: 'block', width: 40, height: 40, borderRadius: '50%', background: T.fill, border: `1.5px solid ${T.line}` }} />;
    case 'image':
    case 'illustration':
      return (
        <div style={{ ...box, ...rowMid, justifyContent: 'center', minHeight: 96, background: T.fill, color: T.faint, flexDirection: 'column', gap: 4 }}>
          <Icon name="image" size={18} />
          {label ? <span style={{ fontSize: 11 }}>{label}</span> : null}
        </div>
      );
    case 'divider':
      return <div style={{ height: 1.5, background: T.lineSoft, margin: '2px 0' }} />;
    case 'alert':
      return (
        <div style={{ ...box, ...rowMid, gap: 8, minHeight: 40, padding: '0 12px', boxShadow: `inset 4px 0 0 ${T.ink}`, background: T.fill, fontSize: 12.5, color: T.soft }}>
          <span style={trunc}>{label}</span>
        </div>
      );
    // ── Mobile navigation patterns (a web sidebar/nav is REDESIGNED into these) ──
    case 'appbar': {
      // Mobile top app bar: hamburger + title + one trailing action.
      return (
        <div style={{ ...rowMid, gap: 12, minHeight: 48 }}>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0 }}>
            {[0, 1, 2].map((i) => <i key={i} style={{ width: 17, height: 2, borderRadius: 2, background: T.ink }} />)}
          </span>
          <span style={{ ...trunc, flex: 1, fontSize: 14, fontWeight: 700, color: T.ink }}>{label || 'Tiêu đề'}</span>
          {(o.navItems ?? []).length
            ? <span style={{ display: 'flex', gap: 14, fontSize: 12.5, color: T.muted }}>{(o.navItems ?? []).map((n, i) => <span key={i}>{n}</span>)}</span>
            : <i style={{ width: 22, height: 22, flexShrink: 0, borderRadius: '50%', background: T.fill, border: `1.5px solid ${T.line}` }} />}
        </div>
      );
    }
    case 'drawer':
    case 'navdrawer':
    case 'sidedrawer': {
      // The off-canvas menu shown OPEN, with a scrim — this is what a desktop
      // sidebar / nav menu becomes on mobile.
      const items = o.items ?? o.navItems ?? ['Trang chủ', 'Giao dịch', 'Báo cáo', 'Cài đặt'];
      const activeIdx = o.activeStep ?? o.activeTab ?? 0;
      return (
        <div style={{ ...box, overflow: 'hidden', display: 'flex', minHeight: 200 }}>
          <div style={{ width: '72%', borderRight: `1.5px solid ${T.line}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 2, background: T.paper }}>
            <div style={{ ...rowMid, gap: 8, marginBottom: 8, fontSize: 13, fontWeight: 700, color: T.ink }}>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {[0, 1, 2].map((i) => <i key={i} style={{ width: 15, height: 2, borderRadius: 2, background: T.ink }} />)}
              </span>
              {label || 'Menu'}
            </div>
            {items.map((it, i) => (
              <div key={i} style={{ ...rowMid, gap: 8, padding: '9px 8px', borderRadius: 6, fontSize: 12.5, color: i === activeIdx ? T.ink : T.soft, fontWeight: i === activeIdx ? 700 : 400, background: i === activeIdx ? T.fill : undefined }}>
                <i style={{ width: 14, height: 14, borderRadius: 4, background: T.fill, border: `1.5px solid ${T.line}`, flexShrink: 0 }} />
                <span style={trunc}>{it}</span>
              </div>
            ))}
          </div>
          <div style={{ flex: 1, background: 'rgba(20,24,32,0.06)' }} />
        </div>
      );
    }
    case 'bottomnav':
    case 'tabbarbottom':
    case 'navbottom': {
      // Bottom tab bar (primary destinations). Use for ≤5 top-level sections.
      const items = o.items ?? o.navItems ?? o.tabs ?? ['Trang chủ', 'Giao dịch', 'Thẻ', 'Cá nhân'];
      const activeIdx = o.activeTab ?? 0;
      return (
        <div style={{ ...box, display: 'flex', borderRadius: 14, padding: '8px 4px' }}>
          {items.map((it, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, color: i === activeIdx ? T.ink : T.faint }}>
              <i style={{ width: 18, height: 18, borderRadius: 6, background: i === activeIdx ? T.ink : 'transparent', border: `1.5px solid ${i === activeIdx ? T.ink : T.line}` }} />
              <span style={{ ...trunc, fontSize: 10.5, maxWidth: '100%' }}>{it}</span>
            </div>
          ))}
        </div>
      );
    }
    case 'fab': {
      // Floating action button — the primary create/compose action on mobile.
      return (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{ width: 52, height: 52, borderRadius: '50%', ...rowMid, justifyContent: 'center', background: T.ink, color: T.paper, fontSize: 26, fontWeight: 400 }}>
            {o.icon ?? '+'}
          </div>
        </div>
      );
    }
    case 'spacer':
      return <div style={{ flex: 1 }} />;
    default:
      return <div style={{ fontSize: 12.5, color: T.soft }}>{label || kind}</div>;
  }
}

/* ── Tree renderer — real flexbox, so it can never overlap ────────────────── */
function NodeView({ node }: { node: WireNode }) {
  if (isContainer(node)) {
    const isRow = node.dir === 'row';
    const style: CSSProperties = {
      display: 'flex',
      flexDirection: isRow ? 'row' : 'column',
      // Rows wrap so a desktop-authored layout re-stacks on a narrow device frame
      // (tablet / mobile) instead of crushing its columns.
      ...(isRow ? { flexWrap: 'wrap' } : {}),
      gap: GAP[node.gap ?? 'md'],
      alignItems: isRow ? (alignMap[node.align ?? 'center'] ?? 'center') : (alignMap[node.align ?? 'stretch'] ?? 'stretch'),
      ...(node.align === 'between' ? { justifyContent: 'space-between' } : {}),
      minWidth: 0,
      // A grow column keeps a sensible floor so it wraps below (not next to) a fixed
      // sidebar once the frame is narrower than floor+sidebar.
      ...(node.grow ? { flex: node.grow, minWidth: 180 } : {}),
      ...(node.w ? { width: node.w, flexShrink: 0 } : {}),
      ...(node.card ? { ...box, padding: 12 } : node.pad ? { padding: 12 } : {}),
    };
    const inner = (
      <div style={style}>
        {node.children.map((c, i) => <NodeView key={i} node={c} />)}
      </div>
    );
    if (node.label) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, ...(node.grow ? { flex: node.grow, minWidth: 0 } : {}), ...(node.w ? { width: node.w, flexShrink: 0 } : {}) }}>
          <div style={{ ...rowMid, gap: 8, fontSize: 11.5, fontWeight: 700, color: T.ink }}>
            <i style={{ width: 6, height: 6, borderRadius: '50%', background: T.ink }} />
            {node.label}
          </div>
          {inner}
        </div>
      );
    }
    return inner;
  }
  // leaf
  const style: CSSProperties = {
    minWidth: 0,
    ...(node.grow ? { flex: node.grow, minWidth: 180 } : {}),
    ...(node.w ? { width: node.w, flexShrink: 0 } : {}),
  };
  return <div style={style}><LeafBody o={node} /></div>;
}

/* ── Legacy absolute-grid renderer (kept for old / wiretext-edited files) ─── */
const CW = 9;
const CH = 19;
function legacySize(o: WireObject): { w: number; h: number } {
  const ct = o.componentType ?? '';
  if (o.type === 'text') return { w: o.width ?? Math.max((o.content ?? '').length, 1), h: o.height ?? 1 };
  if (['checkbox', 'radio', 'toggle', 'breadcrumb', 'stepper', 'rating', 'divider'].includes(ct)) return { w: o.width ?? 14, h: o.height ?? 1 };
  if (ct === 'list') return { w: o.width ?? 20, h: o.height ?? (o.items?.length ?? 3) };
  if (ct === 'table') return { w: o.width ?? 40, h: o.height ?? 8 };
  if (['browser', 'card', 'modal'].includes(ct)) return { w: o.width ?? 40, h: o.height ?? 10 };
  return { w: o.width ?? Math.max((o.label ?? '').length + 6, 10), h: o.height ?? 3 };
}
function LegacyView({ objects }: { objects: WireObject[] }) {
  let maxC = 40;
  let maxR = 10;
  for (const o of objects) {
    if (o.type === 'connector') continue;
    const { w, h } = legacySize(o);
    maxC = Math.max(maxC, (o.position?.col ?? 0) + w);
    maxR = Math.max(maxR, (o.position?.row ?? 0) + h);
  }
  const sorted = [...objects].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
  return (
    <div style={{ position: 'relative', width: (maxC + 2) * CW, height: (maxR + 1) * CH }}>
      {sorted.map((o, i) => {
        const { w, h } = legacySize(o);
        const rect: CSSProperties = {
          position: 'absolute',
          left: (o.position?.col ?? 0) * CW,
          top: (o.position?.row ?? 0) * CH,
          width: w * CW,
          height: h * CH,
        };
        return <div key={o.id ?? i} style={rect}><LeafBody o={o} /></div>;
      })}
    </div>
  );
}

/* ── Export to wiretext.app (kept working for both shapes) ────────────────── */
// Flatten a layout tree into wiretext objects on the character grid (best-effort
// flow layout — the editor is for manual polish, so approximate cells are fine).
function treeToObjects(node: WireNode, col: number, row: number, widthCells: number): { objects: WireObject[]; rows: number } {
  const objects: WireObject[] = [];
  const leafRows = (n: WireLeaf): number => {
    const k = (n.componentType ?? n.type ?? 'text').toLowerCase();
    if (['input', 'search', 'select', 'dropdown', 'button', 'cta', 'chip'].includes(k)) return 3;
    if (k === 'textarea') return 4;
    if (k === 'list') return (n.items?.length ?? 3) + 1;
    if (k === 'table') return (n.rows?.length ?? 3) + 2;
    if (['card', 'image'].includes(k)) return 6;
    return 1;
  };
  if (isContainer(node)) {
    let cursorRow = row;
    let cursorCol = col;
    const gap = 1;
    if (node.dir === 'row') {
      const fixed = node.children.filter((c) => 'w' in c && c.w).length;
      const growCount = node.children.filter((c) => !('w' in c) || !c.w).length || 1;
      const growW = Math.max(6, Math.floor((widthCells - fixed * 20) / growCount));
      let maxRows = 1;
      for (const c of node.children) {
        const cw = isContainer(c) ? (c.w ? Math.round(c.w / CW) : growW) : (c.w ? Math.round(c.w / CW) : growW);
        const res = treeToObjects(c, cursorCol, cursorRow, cw);
        objects.push(...res.objects);
        maxRows = Math.max(maxRows, res.rows);
        cursorCol += cw + gap;
      }
      return { objects, rows: maxRows };
    }
    for (const c of node.children) {
      const res = treeToObjects(c, cursorCol, cursorRow, widthCells);
      objects.push(...res.objects);
      cursorRow += res.rows + gap;
    }
    return { objects, rows: cursorRow - row };
  }
  const h = leafRows(node);
  const k = (node.componentType ?? node.type ?? 'text').toLowerCase();
  objects.push({
    type: k === 'text' || k === 'label' || k === 'heading' || k === 'section' ? 'text' : 'component',
    ...(k === 'text' || k === 'label' || k === 'heading' || k === 'section'
      ? { content: node.label ?? node.content ?? '' }
      : { componentType: k, label: node.label }),
    position: { col, row },
    width: widthCells,
    height: h,
    ...(node.items ? { items: node.items } : {}),
    ...(node.columns ? { columns: node.columns } : {}),
    ...(node.rows ? { rows: node.rows } : {}),
    ...(node.tabs ? { tabs: node.tabs } : {}),
  });
  return { objects, rows: h };
}

export function wiretextEditUrl(doc: WireDoc): string {
  const objects = doc.layout
    ? treeToObjects(doc.layout, 0, 0, 60).objects
    : doc.objects ?? [];
  const payload = {
    version: 2,
    objects,
    layers: [{ id: 'layer-1', name: 'Layer 1', visible: true, locked: false }],
  };
  return `https://wiretext.app/#${compressToEncodedURIComponent(JSON.stringify(payload))}`;
}

/* ── Device presets ──────────────────────────────────────────────────────── */
// A web screen is previewed at three breakpoints; a mobile app screen only ever
// at a single phone width. The layout tree is responsive (flexbox), so the same
// doc simply reflows at each frame width.
export const DEVICES = {
  desktop: { label: 'Desktop', w: 1280 },
  tablet: { label: 'Tablet', w: 834 },
  mobile: { label: 'Mobile', w: 390 },
} as const;
export type DeviceKey = keyof typeof DEVICES;
// A device-like MINIMUM height so a short screen still reads as a real device
// (not a squat landscape strip). Content taller than this grows the frame.
const DEVICE_MIN_H: Record<DeviceKey, number> = { desktop: 800, tablet: 1040, mobile: 800 };
/** Web device choices, for the page-level device <select>. */
export const WEB_DEVICES: DeviceKey[] = ['desktop', 'tablet', 'mobile'];

/* Device chrome so each variant reads as a real device, not a bare box. */
function BrowserBar() {
  return (
    <div style={{ ...rowMid, gap: 8, height: 30, padding: '0 12px', borderBottom: `1px solid ${T.lineSoft}`, background: T.fill, flexShrink: 0 }}>
      {['#f87171', '#fbbf24', '#34d399'].map((c) => (
        <i key={c} style={{ width: 9, height: 9, borderRadius: '50%', background: c, opacity: 0.7 }} />
      ))}
      <span style={{ marginLeft: 8, flex: 1, height: 15, borderRadius: 999, background: T.paper, border: `1px solid ${T.lineSoft}` }} />
    </div>
  );
}
function PhoneStatusBar() {
  return (
    <div style={{ ...rowMid, justifyContent: 'space-between', height: 26, padding: '0 16px', fontSize: 10.5, fontWeight: 700, color: T.muted, flexShrink: 0 }}>
      <span>9:41</span>
      <span style={{ display: 'flex', gap: 4 }}>
        <i style={{ width: 14, height: 9, border: `1.2px solid ${T.muted}`, borderRadius: 2 }} />
      </span>
    </div>
  );
}
function DeviceFrame({ device, children }: { device: DeviceKey; children: ReactNode }) {
  const isMobile = device === 'mobile';
  return (
    <div
      style={{
        width: DEVICES[device].w,
        minHeight: DEVICE_MIN_H[device],
        ...box,
        borderRadius: isMobile ? 26 : 12,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {isMobile ? <PhoneStatusBar /> : <BrowserBar />}
      {/* flex:1 so the content area fills the device's min height (content sits
          at the top, empty space below, like a real screen). */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: isMobile ? 14 : 18 }}>{children}</div>
    </div>
  );
}

/* An OVERLAY screen (dialog / drawer / sheet) drawn as that layer over a dimmed
 * backdrop — the base screen when we have it, else a faint placeholder — so a
 * secondary state reads as "on top of a screen", not as its own blank page. */
function OverlayView({ node, kind, base, device }: { node?: WireNode; kind: 'dialog' | 'drawer' | 'sheet'; base?: WireDoc; device: DeviceKey }) {
  const baseNode = base ? (base.layouts?.[device] ?? base.layout) : undefined;
  const panel = node ? <NodeView node={node} /> : <div style={{ fontSize: 12.5, color: T.faint }}>—</div>;
  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 340 }}>
      <div style={{ opacity: 0.4, filter: 'saturate(0.55)', pointerEvents: 'none' }}>
        {baseNode ? <NodeView node={baseNode} /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ ...box, height: 46 }} />
            <div style={{ ...box, height: 130 }} />
            <div style={{ ...box, height: 130 }} />
          </div>
        )}
      </div>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(20,24,32,0.32)', borderRadius: 4 }} />
      {kind === 'drawer' ? (
        <div style={{ position: 'absolute', inset: 0, display: 'flex' }}>
          <div style={{ width: '76%', background: T.paper, borderRight: `1.5px solid ${T.line}`, boxShadow: '2px 0 14px rgba(0,0,0,0.14)', padding: 14, overflow: 'auto' }}>{panel}</div>
        </div>
      ) : kind === 'sheet' ? (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, background: T.paper, borderTop: `1.5px solid ${T.line}`, borderTopLeftRadius: 16, borderTopRightRadius: 16, boxShadow: '0 -4px 18px rgba(0,0,0,0.14)', padding: 16 }}>
          <div style={{ width: 36, height: 4, borderRadius: 999, background: T.lineSoft, margin: '0 auto 12px' }} />
          {panel}
        </div>
      ) : (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ width: '100%', maxWidth: 360, background: T.paper, ...box, boxShadow: '0 10px 30px rgba(0,0,0,0.2)', padding: 18 }}>{panel}</div>
        </div>
      )}
    </div>
  );
}

const OVERLAY_LABEL: Record<string, string> = { dialog: 'Dialog', drawer: 'Drawer', sheet: 'Bottom sheet' };

/* ── Public component ────────────────────────────────────────────────────── */
// Renders ONE device. For a web screen the device is CONTROLLED by the page's
// device <select> (`device` prop) — there is no per-card device toggle, so the
// whole screen set switches device together. A mobile-app screen ignores the
// prop and is always a phone.
export function WireFrameView({ doc, platform, base, device: deviceProp }: { doc: WireDoc; platform?: string; base?: WireDoc; device?: DeviceKey }) {
  const isWeb = platform === 'web';
  const isLegacy = !doc.layout && !!doc.objects?.length;
  const device: DeviceKey = isWeb ? (deviceProp ?? 'desktop') : 'mobile';

  // Measure the canvas so a wide desktop frame is zoomed to fit (with a legible floor).
  const canvasRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setAvail(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const dotted: CSSProperties = {
    backgroundImage: `radial-gradient(${T.lineSoft} 1px, transparent 1px)`,
    backgroundSize: '16px 16px',
  };
  // The tree shown for the active device: its own redesign when authored, else
  // the base `layout` (reflowed to fit). `isReflow` = we're showing the base for
  // a non-desktop device that has no dedicated design → tell the user so.
  const deviceNode = doc.layouts?.[device] ?? doc.layout;
  const isReflow = isWeb && device !== 'desktop' && !doc.layouts?.[device] && !!doc.layout;
  const body = useMemo(() => {
    if (doc.overlay && deviceNode) return <OverlayView node={deviceNode} kind={doc.overlay} base={base} device={device} />;
    if (deviceNode) return <NodeView node={deviceNode} />;
    if (doc.objects?.length) return <LegacyView objects={doc.objects} />;
    return <div style={{ fontSize: 12.5, color: T.faint, padding: 24, textAlign: 'center' }}>Wireframe trống.</div>;
  }, [deviceNode, doc.objects, doc.overlay, base, device]);

  // Legacy absolute-grid files: render as-is (can't reflow), plus a hint to re-run.
  if (isLegacy) {
    return (
      <div style={{ fontFamily: T.mono }}>
        <div style={{ marginBottom: 8, borderRadius: 8, border: `1px dashed ${T.line}`, padding: '7px 11px', fontSize: 11.5, color: T.muted, background: T.fill }}>
          Wireframe định dạng cũ (toạ độ tuyệt đối) — có thể bị đè. Chạy lại bước <b>UX Spec</b> để tạo bản layout responsive.
        </div>
        <div style={{ overflow: 'auto', border: `1.5px solid ${T.lineSoft}`, borderRadius: 10, padding: 20, ...dotted }}>
          {body}
        </div>
      </div>
    );
  }

  const naturalW = DEVICES[device].w + 40; // frame width + chrome padding budget
  const zoom = avail > 0 ? Math.max(0.4, Math.min(1, avail / naturalW)) : 1;

  return (
    <div style={{ fontFamily: T.mono }}>
      {doc.overlay ? (
        <div style={{ marginBottom: 8, display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 700, color: T.paper, background: T.ink }}>
          Lớp phủ · {OVERLAY_LABEL[doc.overlay] ?? doc.overlay}
          {doc.overlayOf ? <span style={{ fontWeight: 400, opacity: 0.85 }}>trên {doc.overlayOf}</span> : null}
        </div>
      ) : null}
      {isReflow ? (
        <div style={{ marginBottom: 8, fontSize: 11, color: T.faint }}>
          {DEVICES[device].label} chưa có bản thiết kế riêng — đang co lại từ desktop. Chạy lại <b>UX Spec</b> để agent vẽ lại.
        </div>
      ) : null}
      <div
        ref={canvasRef}
        style={{ overflow: 'auto', display: 'flex', justifyContent: 'center', border: `1.5px solid ${T.lineSoft}`, borderRadius: 10, padding: 20, ...dotted }}
      >
        <div style={{ zoom } as CSSProperties}>
          <DeviceFrame device={device}>{body}</DeviceFrame>
        </div>
      </div>
    </div>
  );
}
