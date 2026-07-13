// WireloomViewer — ported from SimStudio's ui/preview WireloomViewer so the
// open-design /ux-spec preview renders the SAME wireframe: UX elements → an
// indented wireloom source → SVG via the `wireloom` package. Grouped by region
// (appbar→header, hero/body→panel, footer→footer, bottom_nav→tabbar). Toggle
// between the rendered SVG and the wireloom source.
import { useEffect, useMemo, useRef, useState } from 'react';
import * as wireloom from 'wireloom';

export interface WireElement {
  id: string;
  role: string;
  component_glyph: string;
  region: string;
  order: number;
  prominence?: string;
  icon_with_label?: boolean;
  input_type?: string;
}

const REGION_ORDER: Record<string, number> = { appbar: 0, hero: 1, body: 2, footer: 3, bottom_nav: 4 };

const esc = (s: string) => (s ?? '').replace(/"/g, "'").replace(/\n/g, ' ');

// PascalCase / DB component_type → lowercase wireloom primitive.
const GLYPH_ALIAS: Record<string, string> = {
  textinput: 'input', passwordinput: 'input', numberinput: 'input', taginput: 'input', slider: 'input',
  datepicker: 'input', timepicker: 'input', textarea: 'input', search: 'input', input: 'input',
  button: 'button', cta: 'button',
  dropdown: 'select', select: 'select', combobox: 'select',
  checkbox: 'checkbox', toggle: 'checkbox', switch: 'checkbox',
  radio: 'radio',
  label: 'text', text: 'text', paragraph: 'text', heading: 'heading', title: 'heading', link: 'link',
  image: 'image', illustration: 'illustration', icon: 'icon',
  card: 'card', list: 'list_item', list_item: 'list_item', listitem: 'list_item',
  chart: 'chart', progress: 'progress', table: 'table', modal: 'modal', navbar: 'navbar',
  stepper: 'text', badge: 'text',
};

// nav-like glyphs that belong in a web sidebar (list rows + nav bars).
function isNavLike(e: WireElement): boolean {
  const g = GLYPH_ALIAS[e.component_glyph?.toLowerCase() ?? ''] ?? e.component_glyph;
  return g === 'list_item' || g === 'navbar';
}

export function elementsToWireloom(
  screenName: string,
  elements: WireElement[],
  // `web` renders a desktop-shaped frame (top bar + sidebar + wide main) instead
  // of the mobile single-column window. Anything else (incl. undefined) keeps the
  // legacy mobile layout, so existing screens are unaffected.
  layout?: string,
  // Optional navigation group of the screen — rendered as a breadcrumb on web.
  navGroup?: string,
): string {
  const sorted = [...elements].sort((a, b) => {
    const ra = REGION_ORDER[a.region] ?? 5;
    const rb = REGION_ORDER[b.region] ?? 5;
    if (ra !== rb) return ra - rb;
    return (a.order ?? 99) - (b.order ?? 99);
  });
  const byRegion = new Map<string, WireElement[]>();
  sorted.forEach((e) => {
    let r = e.region || 'body';
    if (!['appbar', 'hero', 'body', 'footer', 'bottom_nav'].includes(r)) r = 'body';
    const arr = byRegion.get(r) ?? [];
    arr.push(e);
    byRegion.set(r, arr);
  });

  return layout === 'web'
    ? webWireloom(screenName, byRegion, navGroup)
    : mobileWireloom(screenName, byRegion);
}

// Desktop form idiom: inputs/selects render as a LABEL-LEFT row (fixed label
// column + wide control) instead of the mobile full-width stacked control.
// Self-labeled controls (checkbox/radio/button/text/…) fall back to the shared
// renderElement.
function renderWebMainElement(el: WireElement, indent: string): string[] {
  const glyph = GLYPH_ALIAS[el.component_glyph?.toLowerCase() ?? ''] ?? el.component_glyph ?? 'text';
  if (glyph !== 'input' && glyph !== 'select') return renderElement(el, indent);
  const role = esc(el.role);
  const control =
    glyph === 'select'
      ? `combo "Chọn…"`
      : (() => {
          const WL = new Set(['password', 'email', 'search']);
          const t = el.input_type && WL.has(el.input_type) ? ` type=${el.input_type}` : '';
          return `input placeholder=""${t}`;
        })();
  return [
    `${indent}row:`,
    `${indent}  col 240:`,
    `${indent}    text "${role}" muted`,
    `${indent}  col fill:`,
    `${indent}    ${control}`,
  ];
}

// Desktop-shaped frame: full-width top bar (+ breadcrumb when the screen has a
// navigation group), a fixed sidebar of nav-like elements (lists + navbars, plus
// any bottom-nav items — web has no bottom tab bar), a wide main column using
// the label-left form idiom, and a right-aligned action footer. The columns
// force the window to render at a web width instead of the narrow phone column.
function webWireloom(
  screenName: string,
  byRegion: Map<string, WireElement[]>,
  navGroup?: string,
): string {
  const out: string[] = [`window "${esc(screenName)}":`];
  const appbar = byRegion.get('appbar') ?? [];
  if (appbar.length) {
    out.push('  header:');
    appbar.forEach((e) => out.push(...renderElement(e, '    ')));
  }
  if (navGroup) {
    out.push('  breadcrumb:');
    out.push(`    crumb "${esc(navGroup)}"`);
    out.push(`    crumb "${esc(screenName)}"`);
  }
  const body = byRegion.get('body') ?? [];
  const hero = byRegion.get('hero') ?? [];
  const bn = byRegion.get('bottom_nav') ?? [];
  const sidebar = [...body.filter(isNavLike), ...bn];
  const main = [...hero, ...body.filter((e) => !isNavLike(e))];

  out.push('  row:');
  if (sidebar.length) {
    out.push('    col 240:');
    sidebar.forEach((e) => out.push(...renderElement(e, '      ')));
    out.push('    col fill:');
    if (main.length) main.forEach((e) => out.push(...renderWebMainElement(e, '      ')));
    else out.push('      spacer "—"');
  } else {
    // No sidebar → a single wide column so the frame still reads as desktop.
    out.push('    col 720:');
    if (main.length) main.forEach((e) => out.push(...renderWebMainElement(e, '      ')));
    else out.push('      spacer "Chưa có component nào được định nghĩa"');
  }

  const footer = byRegion.get('footer') ?? [];
  if (footer.length) {
    // Desktop action bar: actions cluster bottom-right.
    out.push('  footer:');
    out.push('    row justify=end:');
    footer.forEach((e) => out.push(...renderElement(e, '      ')));
  }
  return out.join('\n');
}

// Mobile single-column window (legacy behavior): appbar→header, hero/body→panel,
// footer→footer, bottom_nav→tabbar.
function mobileWireloom(screenName: string, byRegion: Map<string, WireElement[]>): string {
  const out: string[] = [`window "${esc(screenName)}":`];
  const appbar = byRegion.get('appbar') ?? [];
  if (appbar.length) {
    out.push('  header:');
    appbar.forEach((e) => out.push(...renderElement(e, '    ')));
  }
  const hero = byRegion.get('hero') ?? [];
  if (hero.length) {
    out.push('  panel:');
    hero.forEach((e) => out.push(...renderElement(e, '    ')));
  }
  const body = byRegion.get('body') ?? [];
  if (body.length) {
    out.push('  panel:');
    body.forEach((e) => out.push(...renderElement(e, '    ')));
  }
  const footer = byRegion.get('footer') ?? [];
  if (footer.length) {
    out.push('  footer:');
    footer.forEach((e) => out.push(...renderElement(e, '    ')));
  }
  const bn = byRegion.get('bottom_nav') ?? [];
  if (bn.length) {
    out.push('  tabbar:');
    bn.forEach((e) => out.push(`    tabitem "${esc(e.role)}"`));
  }
  if (out.length === 1) {
    out.push('  panel:');
    out.push('    spacer "Chưa có component nào được định nghĩa"');
  }
  return out.join('\n');
}

function renderElement(el: WireElement, indent: string): string[] {
  const role = esc(el.role);
  const primary = el.prominence === 'primary';
  const glyph = GLYPH_ALIAS[el.component_glyph?.toLowerCase() ?? ''] ?? el.component_glyph ?? 'text';
  switch (glyph) {
    case 'button':
      return [`${indent}button "${role}"${primary ? ' primary' : ''}`];
    case 'input': {
      const WL = new Set(['password', 'email', 'search']);
      const t = el.input_type && WL.has(el.input_type) ? ` type=${el.input_type}` : '';
      const hintMap: Record<string, string> = { phone: '(SĐT)', otp: '(OTP)', number: '(số)', date: '(dd/mm/yyyy)' };
      const hint = el.input_type && hintMap[el.input_type] ? ` ${hintMap[el.input_type]}` : '';
      return [`${indent}input placeholder="${role}${hint}"${t}`];
    }
    case 'select':
      return [`${indent}combo "${role}"`];
    case 'checkbox':
      return [`${indent}checkbox "${role}"`];
    case 'radio':
      return [`${indent}radio "${role}"`];
    case 'heading':
      return [`${indent}text "${role}" bold size=large`];
    case 'text':
      return [`${indent}text "${role}"`];
    case 'link':
      return [`${indent}text "${role}" italic muted`];
    case 'image':
      return [`${indent}image`, `${indent}text "${role}" muted`];
    case 'illustration':
      return [`${indent}image`, `${indent}text "▦ ${role}" muted italic`];
    case 'icon':
      return el.icon_with_label ? [`${indent}icon`, `${indent}text "${role}"`] : [`${indent}icon`];
    case 'card':
      return [`${indent}section "${role}":`, `${indent}  text "—" muted`];
    case 'list_item':
      return [`${indent}text "• ${role}"`];
    case 'chart':
      return [`${indent}chart`, `${indent}text "${role}" muted size=small`];
    case 'progress':
      return [`${indent}progress`, `${indent}text "${role}" muted size=small`];
    case 'table':
      return [`${indent}section "${role}":`, `${indent}  kv "Cột 1" "—"`, `${indent}  kv "Cột 2" "—"`];
    case 'modal':
      return [`${indent}text "[modal] ${role}" italic`];
    case 'navbar':
      return [`${indent}text "≡ ${role}" bold`];
    default:
      return [`${indent}text "${role}"`];
  }
}

let initTheme: string | null = null;
function ensureInit() {
  let dark = false;
  try {
    dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    /* noop */
  }
  const theme = dark ? 'dark' : 'light';
  if (initTheme !== theme) {
    try {
      (wireloom as { initialize: (o: { theme: string }) => void }).initialize({ theme });
    } catch {
      /* older API */
    }
    initTheme = theme;
  }
}

let counter = 0;

export function WireloomViewer({
  screenName,
  elements,
  layout,
  navGroup,
}: {
  screenName: string;
  elements: WireElement[];
  /** Screen target platform; `web` renders a desktop-shaped wireframe. */
  layout?: string;
  /** Navigation group — shown as a breadcrumb on web wireframes. */
  navGroup?: string;
}) {
  const [view, setView] = useState<'wire' | 'source'>('wire');
  const [svg, setSvg] = useState<string>('');
  const [err, setErr] = useState<string>('');
  const idRef = useRef<string>(`wireloom-${++counter}`);
  const source = useMemo(
    () => elementsToWireloom(screenName, elements, layout, navGroup),
    [screenName, elements, layout, navGroup],
  );

  useEffect(() => {
    if (view !== 'wire' || !source) return;
    ensureInit();
    let cancelled = false;
    (wireloom as { render: (id: string, src: string) => Promise<{ svg: string }> })
      .render(idRef.current, source)
      .then((r) => {
        if (!cancelled) {
          setSvg(r.svg);
          setErr('');
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : String(e));
          setSvg('');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [view, source]);

  const tab = (k: 'wire' | 'source', label: string) => (
    <button
      type="button"
      onClick={() => setView(k)}
      style={{
        fontSize: 10,
        padding: '2px 8px',
        borderRadius: 'var(--radius-sm, 6px)',
        cursor: 'pointer',
        border: `1px solid ${view === k ? 'var(--accent, #0066b3)' : 'var(--border, #e1e5eb)'}`,
        background: view === k ? 'var(--accent-tint, #e6f0f8)' : 'transparent',
        color: view === k ? 'var(--accent, #0066b3)' : 'var(--text-muted, #6b7280)',
      }}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, marginBottom: 6 }}>
        {tab('wire', 'Wireframe')}
        {tab('source', 'Source')}
      </div>
      <div
        style={{
          border: '1px solid var(--border, #e1e5eb)',
          borderRadius: 'var(--radius, 8px)',
          background: 'var(--bg-subtle, #f5f6f8)',
          padding: 12,
          overflow: 'auto',
        }}
      >
        {view === 'source' ? (
          <pre style={{ fontFamily: 'var(--mono, monospace)', fontSize: 11, margin: 0, whiteSpace: 'pre', color: 'var(--text-soft, #4b5563)' }}>
            {source}
          </pre>
        ) : err ? (
          <pre style={{ fontFamily: 'var(--mono, monospace)', fontSize: 10, margin: 0, color: 'var(--red, #dc2626)', whiteSpace: 'pre-wrap' }}>
            wireloom error: {err}
            {'\n\n'}
            {source}
          </pre>
        ) : svg ? (
          <div
            style={{ display: 'flex', justifyContent: 'center' }}
            // wireloom returns a self-contained SVG string
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div style={{ fontSize: 11, color: 'var(--text-muted, #6b7280)' }}>Rendering…</div>
        )}
      </div>
    </div>
  );
}
