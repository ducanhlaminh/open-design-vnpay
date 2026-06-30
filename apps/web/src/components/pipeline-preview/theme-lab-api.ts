// Thin client over the daemon's theme-lab proxy (/api/pipelines/theme/*), which
// forwards to design-v3's theme-lab (resolves the KGS theme data into
// compositions + cssVars). Used by ThemeInspectorPanel to list brandings and
// resolve one into the cssVars the preview iframe applies.

// One axis of a composition (brand / visual / color / typography / icon /
// rounded / …). Mirrors design-v3's layer stack so the inspector can show what
// the active composition is built from.
export interface ThemeLabCompositionLayer {
  slug: string;
  kind: string;
  name?: string;
  themeSlug?: string;
  themeName?: string;
  weight?: number;
  order?: number;
  enabled?: boolean;
}

export interface ThemeLabCompositionSummary {
  id: string;
  slug: string;
  name: string;
  status: string;
  active?: boolean;
  layers?: ThemeLabCompositionLayer[];
}

export interface ThemeLabMode {
  id: string;
  slug: string;
  name: string;
  contrastTier?: string;
}

export interface ThemeLabResolvedToken {
  path: string;
  type: string;
  rawValue: string;
  /** Resolved CSS value (e.g. an oklch color / gradient) — used for swatches. */
  cssValue?: string;
  solidValue?: string;
  [key: string]: unknown;
}

export interface ThemeLabResolved {
  composition?: { id: string; slug: string; name: string };
  resolverVersion?: string;
  cssVars: Record<string, string>;
  cssText?: string;
  shadcnCssVars?: Record<string, string>;
  // The runtime needs tokens for typography-field expansion + asset/icon
  // resolution; cssText carries the [data-theme-frame] surface rules that paint
  // the branding (gradients, glass) — both must reach the iframe, not just cssVars.
  tokens?: ThemeLabResolvedToken[];
}

// The daemon proxy returns theme-lab's envelope verbatim: { ok, data, ... }.
function unwrap<T>(payload: unknown): T {
  if (payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`theme-lab: non-JSON response (${res.status})`);
  }
  if (!res.ok) {
    const err = (body as { error?: string })?.error;
    throw new Error(err || `theme-lab request failed: ${res.status}`);
  }
  return body;
}

interface RawComposition {
  id: string;
  slug: string;
  name: string;
  status: string;
  isActive?: boolean;
  layers?: ThemeLabCompositionLayer[];
}

export async function fetchCompositions(workspaceId?: string): Promise<ThemeLabCompositionSummary[]> {
  const q = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
  const data = unwrap<RawComposition[]>(await getJson(`/api/pipelines/theme/compositions${q}`));
  if (!Array.isArray(data)) return [];
  return data
    // Drop smoke/test fixtures (empty layers → resolve to nothing); they would
    // otherwise sort first and become a broken default selection.
    .filter((c) => Array.isArray(c.layers) && c.layers.length > 0 && !/^comp-smoke/.test(c.slug ?? ''))
    .map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      status: c.status,
      active: Boolean(c.isActive), // theme-lab uses `isActive`; normalize for the panel
      layers: (c.layers ?? []).map((l) => ({
        slug: l.slug ?? '',
        kind: l.kind ?? '',
        name: l.name,
        themeSlug: l.themeSlug,
        themeName: l.themeName,
        weight: l.weight,
        order: l.order,
        enabled: l.enabled,
      })),
    }));
}

// The full theme catalog — every available layer per kind, for the per-axis
// swap selectors in the inspector.
export async function fetchLayers(workspaceId?: string): Promise<ThemeLabCompositionLayer[]> {
  const q = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
  const data = unwrap<ThemeLabCompositionLayer[]>(await getJson(`/api/pipelines/theme/layers${q}`));
  if (!Array.isArray(data)) return [];
  return data
    .filter((l) => l && typeof l.slug === 'string' && typeof l.kind === 'string')
    .map((l) => ({
      slug: l.slug,
      kind: l.kind,
      name: l.name,
      themeSlug: l.themeSlug,
      themeName: l.themeName,
    }));
}

interface RawLayerValue {
  targetPath?: string;
  role?: string;
  type?: string;
  domain?: string;
  rawValue?: string;
}

function usableColor(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^(oklch|oklab|hsla?|rgba?|lab|lch|color|(?:linear|radial|conic)-gradient)\s*\(/i.test(s)) return s;
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
  if (/^[\d.]+\s+[\d.]+%\s+[\d.]+%(\s*\/\s*[\d.]+)?$/.test(s)) return `hsl(${s})`;
  return null;
}

const PALETTE_ORDER = [
  'background', 'surface', 'card', 'primary', 'secondary',
  'accent', 'foreground', 'muted', 'destructive', 'border',
];

/** A few representative palette colors for a layer, for the card swatch preview. */
export async function fetchLayerPalette(workspaceId: string | undefined, slug: string): Promise<string[]> {
  const q = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
  const data = unwrap<RawLayerValue[]>(
    await getJson(`/api/pipelines/theme/layers/${encodeURIComponent(slug)}/values${q}`),
  );
  if (!Array.isArray(data)) return [];
  const byKey = new Map<string, string>();
  for (const v of data) {
    const color = usableColor(v.rawValue);
    if (!color) continue;
    const key = (v.role ?? (v.targetPath ?? '').split(/[/.]/).pop() ?? '').toLowerCase();
    if (!byKey.has(key)) byKey.set(key, color);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (c?: string) => {
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  };
  for (const k of PALETTE_ORDER) push(byKey.get(k));
  for (const v of data) {
    if (out.length >= 6) break;
    push(usableColor(v.rawValue) ?? undefined);
  }
  return out.slice(0, 6);
}

export async function fetchModes(workspaceId?: string): Promise<ThemeLabMode[]> {
  const q = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
  const data = unwrap<ThemeLabMode[]>(await getJson(`/api/pipelines/theme/modes${q}`));
  return Array.isArray(data) ? data : [];
}

export async function resolveTheme(args: {
  workspaceId?: string;
  compositionSlug?: string;
  compositionId?: string;
  modeId?: string;
  /** Per-axis layer swaps keyed by kind → layer slug (live preview, not
   *  persisted). Empty values are ignored. */
  layerOverrides?: Record<string, string>;
}): Promise<ThemeLabResolved> {
  const overrides: Record<string, unknown> = { layerWeights: {} };
  if (args.layerOverrides) {
    const cleaned: Record<string, string> = {};
    for (const [kind, slug] of Object.entries(args.layerOverrides)) {
      if (typeof slug === 'string' && slug.length > 0) cleaned[kind] = slug;
    }
    if (Object.keys(cleaned).length > 0) overrides.layers = cleaned;
  }
  const data = unwrap<ThemeLabResolved>(
    await getJson('/api/pipelines/theme/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: args.workspaceId ?? 'ws-catalog-shadcn',
        compositionSlug: args.compositionSlug,
        compositionId: args.compositionId,
        modeId: args.modeId,
        options: { includeDiagnostics: false, includeProvenance: false, materializeCssVars: true },
        overrides,
      }),
    }),
  );
  return { ...data, cssVars: data?.cssVars ?? {} };
}
