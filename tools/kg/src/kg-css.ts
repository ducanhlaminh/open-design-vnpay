/**
 * KG rawValue → plain CSS resolver. Verbatim port of `kgRawValueToCss` and
 * friends from skills/react-shadcn/builder/make-showcase.mjs (the audited
 * design-v3 theme-lab mirror) — keep the two in sync when formats evolve.
 *
 * The KG stores each token value in one of FOUR formats:
 *   • plain        "oklch(…)" | "16px"                     → use as-is
 *   • paint  JSON  {type:"paint",  layers:[…]}             → solid | linear-gradient
 *   • shadow JSON  {type:"shadow", layers:[…]}             → box-shadow
 *   • class-token  "bg-[…] backdrop-… shadow-[…] before:…" → parsed to plain CSS
 * Plus typography JSON ({type:"typography", family,size,…}) handled here too.
 */

export interface SurfaceCss {
  type: "surface";
  color: string | null;
  background: string | null;
  backdropBlur: string | null;
  backdropSat: string | null;
  boxShadow: string | null;
  before: Record<string, string>;
}

export interface PaintCss {
  type: "paint";
  value: string;
  gradient: string | null;
  mid: string | null;
}

export interface TypographyCss {
  type: "typography";
  family?: string;
  size?: string;
  lineHeight?: string;
  weight?: string | number;
  tracking?: string;
}

export type ResolvedCss =
  | { type: "plain"; value: string }
  | { type: "shadow"; value: string }
  | PaintCss
  | SurfaceCss
  | TypographyCss;

const sp = (s: string): string => String(s).replace(/_/g, " ").trim(); // Tailwind underscore → space

interface PaintLayer { kind: string; color?: string; angle?: number; stops?: Array<{ color: string; position: number }> }
interface ShadowLayer { kind?: string; x?: number; y?: number; blur?: number; spread?: number; color?: string }

function paintToCss(layers: PaintLayer[]): string {
  const one = (L: PaintLayer): string | null => {
    if (L.kind === "solid") return L.color ?? null;
    if (L.kind === "gradient" && L.stops) {
      const stops = L.stops.map((s) => `${s.color} ${s.position}%`).join(", ");
      return `linear-gradient(${L.angle ?? 0}deg, ${stops})`;
    }
    return null;
  };
  return layers.map(one).filter(Boolean).join(", ");
}

function shadowToCss(layers: ShadowLayer[]): string {
  return layers
    .map((L) => `${L.kind === "inner" ? "inset " : ""}${L.x || 0}px ${L.y || 0}px ${L.blur || 0}px ${L.spread || 0}px ${L.color ?? "transparent"}`)
    .join(", ");
}

// Map one Tailwind utility fragment → [cssProp, value] (or null if unknown).
function utilToDecl(t: string): [string, string] | null {
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^bg-\[(.+)\]$/))) return ["background", sp(m[1])];
  if ((m = t.match(/^backdrop-blur-\[(.+)\]$/))) return ["__blur", sp(m[1])];
  if ((m = t.match(/^backdrop-saturate-\[(.+)\]$/))) return ["__sat", sp(m[1])];
  if ((m = t.match(/^shadow-\[(.+)\]$/))) return ["box-shadow", sp(m[1])];
  if ((m = t.match(/^content-\[(.*)\]$/))) return ["content", m[1] ? sp(m[1]) : '""'];
  if ((m = t.match(/^rounded-\[(.+)\]$/))) return ["border-radius", sp(m[1])];
  if ((m = t.match(/^\[([a-z-]+):(.+)\]$/))) return [m[1], sp(m[2])]; // arbitrary [prop:value]
  if (t === "relative") return ["position", "relative"];
  if (t === "absolute") return ["position", "absolute"];
  if (t === "inset-0") return ["inset", "0"];
  if (t === "p-px") return ["padding", "1px"];
  if (t === "pointer-events-none") return ["pointer-events", "none"];
  if (t === "border-0") return ["border", "0"];
  return null;
}

// Parse a Tailwind class-composition string → plain-CSS pieces.
function classTokenToCss(str: string, warn: (msg: string) => void): SurfaceCss {
  const out: SurfaceCss = { type: "surface", color: null, background: null, backdropBlur: null, backdropSat: null, boxShadow: null, before: {} };
  for (const raw of str.split(/\s+/).filter(Boolean)) {
    const isBefore = raw.startsWith("before:");
    const t = isBefore ? raw.slice(7) : raw;
    const decl = utilToDecl(t);
    if (!decl) { warn(`unknown class fragment: "${t}"`); continue; }
    if (isBefore) { out.before[decl[0]] = decl[1]; continue; }
    if (decl[0] === "background") { out.background = decl[1]; if (/^(oklch|rgb|#)/.test(decl[1])) out.color = decl[1]; }
    else if (decl[0] === "__blur") out.backdropBlur = decl[1];
    else if (decl[0] === "__sat") out.backdropSat = decl[1];
    else if (decl[0] === "box-shadow") out.boxShadow = decl[1];
    // structural fragments (border-0 / relative) are applied by the slot rule.
  }
  return out;
}

/** Dispatcher → normalized descriptor the CSS assembly consumes. */
export function kgRawValueToCss(rawValue: unknown, warn: (msg: string) => void = () => {}): ResolvedCss {
  const v = String(rawValue).trim();
  if (v[0] === "{") {
    try {
      const o = JSON.parse(v) as { type?: string; layers?: unknown[]; [k: string]: unknown };
      if (o.type === "paint" && Array.isArray(o.layers)) {
        const layers = o.layers as PaintLayer[];
        const grad = layers.find((L) => L.kind === "gradient" && L.stops);
        const value = paintToCss(layers);
        const mid = grad?.stops
          ? grad.stops.slice().sort((a, b) => Math.abs(a.position - 50) - Math.abs(b.position - 50))[0].color
          : null;
        return { type: "paint", value, gradient: grad ? value : null, mid };
      }
      if (o.type === "shadow" && Array.isArray(o.layers)) {
        return { type: "shadow", value: shadowToCss(o.layers as ShadowLayer[]) };
      }
      if (o.type === "typography") {
        return {
          type: "typography",
          family: o.family as string | undefined,
          size: o.size as string | undefined,
          lineHeight: (o.lineHeight ?? o["line-height"]) as string | undefined,
          weight: o.weight as string | number | undefined,
          tracking: o.tracking as string | undefined,
        };
      }
    } catch {
      warn(`unparseable JSON rawValue: ${v.slice(0, 60)}…`);
      return { type: "plain", value: v };
    }
  }
  if (/(^|\s)(bg-\[|backdrop-|shadow-\[|relative|border-0|before:)/.test(v)) {
    return classTokenToCss(v, warn);
  }
  return { type: "plain", value: v };
}
