// Right-panel DS inspector for the pipeline UI preview — mirrors design-v3's
// Styles-tab inspector: header (Design System + composition name), composition
// picker + light/dark mode toggle, a Typography specimen, and a Color swatch
// list. Compositions/modes/cssVars/tokens all come from KGS via the daemon
// theme-lab proxy; selecting a branding (or mode) re-resolves and hands the full
// resolved theme + mode up so the host posts it into the preview iframe.

import { useEffect, useMemo, useState } from 'react';

import styles from './ThemeInspectorPanel.module.css';
import {
  fetchCompositions,
  fetchLayerPalette,
  fetchLayers,
  fetchModes,
  resolveTheme,
  type ThemeLabCompositionLayer,
  type ThemeLabCompositionSummary,
  type ThemeLabMode,
  type ThemeLabResolved,
  type ThemeLabResolvedToken,
} from './theme-lab-api';

interface Props {
  workspaceId?: string;
  /** Full resolved theme (cssVars + cssText + tokens) for the selected branding. */
  onResolved?: (resolved: ThemeLabResolved) => void;
  /** Selected light/dark mode — drives the runtime's `.dark` class. */
  onMode?: (mode: string) => void;
}

const FALLBACK_MODES: ThemeLabMode[] = [
  { id: 'light', slug: 'light', name: 'Light' },
  { id: 'dark', slug: 'dark', name: 'Dark' },
];

export function ThemeInspectorPanel({ workspaceId, onResolved, onMode }: Props) {
  const [comps, setComps] = useState<ThemeLabCompositionSummary[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [modes, setModes] = useState<ThemeLabMode[]>(FALLBACK_MODES);
  const [mode, setMode] = useState<string>('light');
  const [resolved, setResolved] = useState<ThemeLabResolved | null>(null);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Theme catalog (all layers per kind) + per-axis swap overrides (kind → slug).
  const [catalog, setCatalog] = useState<ThemeLabCompositionLayer[]>([]);
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  const resolveAndEmit = async (slug: string, modeSlug: string, layerOverrides: Record<string, string>) => {
    setResolving(true);
    setError(null);
    try {
      const next = await resolveTheme({ workspaceId, compositionSlug: slug, modeId: modeSlug, layerOverrides });
      setResolved(next);
      onResolved?.(next);
      onMode?.(modeSlug);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolving(false);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [list, modeList, layerList] = await Promise.all([
          fetchCompositions(workspaceId),
          fetchModes(workspaceId).catch(() => [] as ThemeLabMode[]),
          fetchLayers(workspaceId).catch(() => [] as ThemeLabCompositionLayer[]),
        ]);
        if (!alive) return;
        setComps(list);
        setCatalog(layerList);
        if (modeList.length > 0) setModes(modeList);
        const first = list.find((c) => c.active) ?? list[0];
        if (first) {
          setSelected(first.slug);
          void resolveAndEmit(first.slug, 'light', {});
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const onPickComposition = (slug: string) => {
    setSelected(slug);
    setOverrides({}); // a different composition has a different layer stack
    void resolveAndEmit(slug, mode, {});
  };
  const onPickMode = (slug: string) => {
    setMode(slug);
    if (selected) void resolveAndEmit(selected, slug, overrides);
    else onMode?.(slug);
  };
  // Swap one axis to a different layer of the same kind → re-resolve live.
  const onSwapLayer = (kind: string, slug: string) => {
    setOverrides((prev) => {
      const next = { ...prev, [kind]: slug };
      if (selected) void resolveAndEmit(selected, mode, next);
      return next;
    });
  };

  const compName = resolved?.composition?.name ?? prettySlug(selected) ?? 'No composition';
  const selectedLayers = comps.find((c) => c.slug === selected)?.layers ?? [];
  // Catalog grouped by kind → options for each axis selector.
  const layersByKind = useMemo(() => {
    const map: Record<string, ThemeLabCompositionLayer[]> = {};
    for (const l of catalog) (map[l.kind] ??= []).push(l);
    return map;
  }, [catalog]);

  return (
    <aside className={styles.panel} aria-label="Design System">
      <div className={styles.head}>
        <div className={styles.headLabel}>Design System</div>
        <div className={styles.headTitle} title={compName}>{compName}</div>
      </div>

      <div className={styles.controls}>
        <select
          className={styles.select}
          value={selected}
          onChange={(e) => onPickComposition(e.target.value)}
          disabled={loading || comps.length === 0}
        >
          {comps.length === 0 ? (
            <option value="">No compositions</option>
          ) : (
            comps.map((c) => (
              <option key={c.id} value={c.slug}>
                {c.name || prettySlug(c.slug)}
                {c.active ? ' · active' : ''}
              </option>
            ))
          )}
        </select>
        <div className={styles.modeToggle} role="group" aria-label="Mode">
          {modes.slice(0, 2).map((m) => (
            <button
              key={m.id}
              type="button"
              className={m.slug === mode ? `${styles.modeBtn} ${styles.modeBtnActive}` : styles.modeBtn}
              onClick={() => onPickMode(m.slug)}
              title={m.name}
              aria-pressed={m.slug === mode}
            >
              {m.slug === 'dark' ? <MoonIcon /> : <SunIcon />}
            </button>
          ))}
        </div>
      </div>

      {error && <div className={styles.error} role="alert">{error}</div>}

      <div className={styles.body}>
        {loading ? (
          <p className={styles.hint}>Loading brandings from KGS…</p>
        ) : comps.length === 0 ? (
          <p className={styles.hint}>No compositions found. Is theme-lab running and seeded?</p>
        ) : (
          <>
            {resolving && <p className={styles.hint}><span className={styles.applying}>applying…</span></p>}
            <CompositionPicker
              workspaceId={workspaceId}
              layers={selectedLayers}
              layersByKind={layersByKind}
              overrides={overrides}
              onSwap={onSwapLayer}
              disabled={resolving}
            />
            <TypographySection cssVars={resolved?.cssVars ?? {}} />
            <ColorsSection tokens={resolved?.tokens ?? []} cssVars={resolved?.cssVars ?? {}} />
          </>
        )}
      </div>
    </aside>
  );
}

/* ── Composition layers — the axes the active composition is built from
   (brand, visual, color, typography, icon, rounded …), mirroring design-v3's
   layer stack. Read-only here: shows which theme each axis resolves to. */
const KIND_LABEL: Record<string, string> = {
  brand: 'Brand',
  visual: 'Visual',
  color: 'Color',
  typography: 'Typography',
  font: 'Typography',
  icon: 'Icon',
  spacing: 'Spacing',
  density: 'Density',
  'component-size': 'Density',
  rounded: 'Rounded',
  'form-radius': 'Form radius',
};
const KIND_ORDER = [
  'brand', 'visual', 'color', 'typography', 'font', 'icon',
  'spacing', 'component-size', 'density', 'rounded', 'form-radius',
];

function layerThemeName(layer: ThemeLabCompositionLayer): string {
  if (layer.themeName) return layer.themeName;
  if (layer.name) return layer.name;
  // "brand.vnpay-merchant" → "vnpay-merchant"; "icon.lucide.outline" → "lucide.outline".
  const slug = layer.themeSlug || layer.slug || '';
  const dot = slug.indexOf('.');
  return dot >= 0 ? slug.slice(dot + 1) : slug;
}

function CompositionPicker({
  workspaceId,
  layers,
  layersByKind,
  overrides,
  onSwap,
  disabled,
}: {
  workspaceId?: string;
  layers: ThemeLabCompositionLayer[];
  layersByKind: Record<string, ThemeLabCompositionLayer[]>;
  overrides: Record<string, string>;
  onSwap: (kind: string, slug: string) => void;
  disabled?: boolean;
}) {
  const visible = layers
    .filter((l) => l.enabled !== false && l.slug)
    .slice()
    .sort((a, b) => {
      const ra = KIND_ORDER.indexOf(a.kind);
      const rb = KIND_ORDER.indexOf(b.kind);
      return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || (a.order ?? 0) - (b.order ?? 0);
    });

  // Brand/visual cards paint a color-swatch preview from each layer's palette.
  const [palettes, setPalettes] = useState<Record<string, string[]>>({});
  const swatchSlugs = useMemo(() => {
    const out = new Set<string>();
    for (const l of visible) {
      if (l.kind !== 'brand' && l.kind !== 'visual') continue;
      out.add(l.slug);
      for (const o of layersByKind[l.kind] ?? []) out.add(o.slug);
    }
    return [...out];
  }, [visible, layersByKind]);
  const swatchKey = swatchSlugs.join('|');
  useEffect(() => {
    // workspaceId may be undefined — the daemon proxy defaults it to
    // ws-catalog-shadcn, so don't gate the fetch on it.
    if (swatchSlugs.length === 0) return;
    let cancelled = false;
    void Promise.all(
      swatchSlugs.map((slug) =>
        fetchLayerPalette(workspaceId, slug)
          .then((c) => [slug, c] as const)
          .catch(() => [slug, [] as string[]] as const),
      ),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<string, string[]> = {};
      for (const [slug, cols] of entries) next[slug] = cols;
      setPalettes(next);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, swatchKey]);

  if (visible.length === 0) return null;
  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <span className={styles.sectionLabel}>Composition</span>
        <span className={styles.sectionMeta}>{visible.length} layers</span>
      </header>
      <div className={styles.axisList}>
        {visible.map((l) => {
          const catalogOptions = layersByKind[l.kind] ?? [];
          // Keep the composition default selectable even if the catalog omits it.
          const options = catalogOptions.some((o) => o.slug === l.slug)
            ? catalogOptions
            : [{ slug: l.slug, kind: l.kind } as ThemeLabCompositionLayer, ...catalogOptions];
          const value = overrides[l.kind] ?? l.slug;
          return (
            <div key={l.kind} className={styles.axisGroup}>
              <span className={styles.axisLabel}>{KIND_LABEL[l.kind] ?? l.kind}</span>
              <div className={l.kind === 'icon' ? styles.cardGridWide : styles.cardGrid}>
                {options.map((o) => {
                  const active = o.slug === value;
                  const tier = extractTier(o.slug, o.kind);
                  const meta = previewValue(o.kind, tier);
                  return (
                    <button
                      key={o.slug}
                      type="button"
                      aria-pressed={active}
                      disabled={disabled}
                      title={o.slug}
                      className={active ? `${styles.card} ${styles.cardActive}` : styles.card}
                      onClick={() => onSwap(l.kind, o.slug)}
                    >
                      <span className={styles.cardPreview}>
                        <CardPreview kind={o.kind} tier={tier} colors={palettes[o.slug]} />
                      </span>
                      <span className={styles.cardFoot}>
                        <span className={styles.cardName}>
                          {tier ? labelForTier(o.kind, tier) : layerThemeName(o)}
                        </span>
                        {meta && <span className={styles.cardMeta}>{meta}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ── Card preview visuals (mirror design-v3): brand/visual → color swatches,
   rounded/form-radius/density → CSS shapes, typography → font specimen. */
const ICON_LABEL: Record<string, string> = {
  'lucide-outline': 'Lucide',
  'tabler-outline': 'Tabler',
  'hugeicons-stroke': 'HugeIcons',
  'phosphor-regular': 'Phosphor',
  'phosphor-duotone': 'Phosphor Duo',
  'remix-line': 'Remix',
};
const FONT_FAMILIES: Record<string, string> = {
  classic: "'Inter', system-ui, sans-serif",
  modern: "'Geist', system-ui, sans-serif",
  editorial: "'Fraunces', 'Times New Roman', Georgia, serif",
  dashboard: "'Bricolage Grotesque', system-ui, sans-serif",
  glass: "'Geist', system-ui, sans-serif",
};

function extractTier(slug: string, kind?: string): string | null {
  const parts = slug.split('.');
  if (kind === 'icon' && parts.length >= 3) return parts.slice(1).join('-');
  return parts.length >= 2 ? parts[1]! : null;
}

function labelForTier(kind: string, tier: string): string {
  if (kind === 'icon') {
    return (
      ICON_LABEL[tier] ??
      tier.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
    );
  }
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

function previewValue(kind: string, tier: string | null): string | null {
  if (!tier) return null;
  const maps: Record<string, Record<string, string>> = {
    'form-radius': { sharp: '2px', rounded: '12px', pill: '999px', default: '8px' },
    'component-size': { small: '32px', medium: '36px', large: '40px', xlarge: '44px' },
    rounded: { none: '0', sharp: '2px', soft: '8px', rounded: '12px', pill: '999px' },
    typography: { classic: 'Inter', modern: 'Geist', editorial: 'Fraunces', dashboard: 'Bricolage', glass: 'Geist' },
    font: { classic: 'Inter', modern: 'Geist', editorial: 'Fraunces', dashboard: 'Bricolage', glass: 'Geist' },
  };
  return maps[kind]?.[tier] ?? null;
}

function CardPreview({ kind, tier, colors }: { kind: string; tier: string | null; colors?: string[] }) {
  if (kind === 'brand' || kind === 'visual') {
    if (!colors || colors.length === 0) return <span className={styles.previewFallback}>…</span>;
    return (
      <span className={styles.swatchRow}>
        {colors.map((c, i) => (
          <span key={i} className={styles.swatch} style={{ background: c }} aria-hidden />
        ))}
      </span>
    );
  }
  if (!tier) return null;
  if (kind === 'rounded') {
    const r = ({ none: 0, sharp: 2, soft: 8, rounded: 14, pill: 999 } as Record<string, number>)[tier] ?? 8;
    return <span className={styles.previewBox} style={{ borderRadius: r }} />;
  }
  if (kind === 'form-radius') {
    const w = ({ sharp: 8, rounded: 26, pill: 40, default: 16 } as Record<string, number>)[tier] ?? 20;
    return (
      <span className={styles.radiusRow}>
        <span className={styles.radiusDot} />
        <span className={styles.radiusLine} style={{ width: w }} />
        <span className={styles.radiusDot} />
      </span>
    );
  }
  if (kind === 'component-size') {
    const h = ({ small: 14, medium: 20, large: 26, xlarge: 32 } as Record<string, number>)[tier] ?? 18;
    return <span className={styles.sizeBox} style={{ height: h }} />;
  }
  if (kind === 'font' || kind === 'typography') {
    return (
      <span className={styles.fontSpecimen} style={{ fontFamily: FONT_FAMILIES[tier] ?? 'system-ui' }}>
        Aa
      </span>
    );
  }
  if (kind === 'icon') {
    return <span className={styles.iconPreview}>▢ ▢ ▢ ▢</span>;
  }
  return null;
}

/* ── Typography specimen — hero in the display font + Display/Body/Mono tiles.
   Font stacks come from the resolved cssVars (--font-display / -sans / -mono). */
function TypographySection({ cssVars }: { cssVars: Record<string, string> }) {
  const display = cssVars['--font-display'] ?? cssVars['--font-sans'] ?? 'system-ui, sans-serif';
  const body = cssVars['--font-sans'] ?? 'system-ui, sans-serif';
  const mono = cssVars['--font-mono'] ?? 'ui-monospace, monospace';
  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <span className={styles.sectionLabel}>Typography</span>
        <span className={styles.sectionMeta} title={display}>{shortFont(display)}</span>
      </header>
      <div className={styles.typoHero}>
        <div className={styles.typoHeroSample} style={{ fontFamily: display }}>Aa Bb Gg</div>
        <div className={styles.typoHeroMeta}>Display · {shortFont(display)}</div>
      </div>
      <div className={styles.fontTiles}>
        <FontTile label="Display" family={display} />
        <FontTile label="Body" family={body} />
        <FontTile label="Mono" family={mono} />
      </div>
    </section>
  );
}

function FontTile({ label, family }: { label: string; family: string }) {
  return (
    <div className={styles.fontTile}>
      <span className={styles.fontTileSample} style={{ fontFamily: family }}>Ag</span>
      <span className={styles.fontTileLabel}>{label}</span>
      <span className={styles.fontTileName} style={{ fontFamily: family }} title={family}>{shortFont(family)}</span>
    </div>
  );
}

/* ── Color swatches — renderable color/paint/gradient tokens, palette-ordered. */
const PALETTE_ORDER = [
  'background', 'surface', 'card', 'popover', 'primary', 'secondary',
  'accent', 'foreground', 'muted', 'destructive', 'success', 'warning',
  'border', 'ring', 'input',
];
const COLOR_TYPES = new Set(['color', 'paint', 'gradient', 'material']);

function ColorsSection({ tokens, cssVars }: { tokens: ThemeLabResolvedToken[]; cssVars: Record<string, string> }) {
  const colorTokens = tokens
    .filter((t) => COLOR_TYPES.has(t.type))
    .filter((t) => usableColor(cssVars[`--${t.path}`] ?? t.cssValue ?? '') !== null)
    .sort((a, b) => paletteRank(a.path) - paletteRank(b.path) || a.path.localeCompare(b.path))
    .slice(0, 28);

  if (colorTokens.length === 0) return null;
  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <span className={styles.sectionLabel}>Color</span>
        <span className={styles.sectionMeta}>{colorTokens.length} tokens</span>
      </header>
      <div className={styles.colorList}>
        {colorTokens.map((t) => {
          const value = usableColor(cssVars[`--${t.path}`] ?? t.cssValue ?? '') ?? '';
          const solid = usableColor(t.solidValue ?? '') ?? value;
          return (
            <div key={t.path} className={styles.colorRow}>
              <span className={styles.swatch} style={{ background: solid }} />
              <div className={styles.colorText}>
                <span className={styles.colorName} title={t.path}>{t.path}</span>
                <span className={styles.colorValue} title={value}>{compactValue(solid)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function paletteRank(path: string): number {
  const key = path.split(/[/.]/)[0] ?? path;
  const i = PALETTE_ORDER.indexOf(key);
  return i === -1 ? PALETTE_ORDER.length : i;
}

function usableColor(raw: string): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  if (/^(oklch|oklab|hsla?|rgba?|lab|lch|color|(?:linear|radial|conic)-gradient)\s*\(/i.test(s)) return s;
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
  return null;
}

function compactValue(value: string): string {
  if (!value) return '—';
  const m = value.match(/^oklch\(([^)]+)\)$/i);
  if (m) return (m[1] ?? '').trim();
  return value.length > 30 ? `${value.slice(0, 28)}…` : value;
}

function shortFont(family: string): string {
  if (!family) return '—';
  const first = family.split(',')[0]?.trim() ?? family;
  return first.replace(/^['"]|['"]$/g, '');
}

function prettySlug(slug: string | undefined): string | undefined {
  if (!slug) return undefined;
  return slug.replace(/^composition\./, '');
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}
