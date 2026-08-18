// SVG copied out of a browser DOM (Mermaid/Stratus `createViewer`, mermaid.js
// `innerHTML`) is HTML-serialised: `<br>` inside <foreignObject> labels stays
// unclosed, `&nbsp;` is an HTML entity. That is fine for `innerHTML` but NOT
// well-formed XML — browsers refuse to load such a file as `<img src=x.svg>`
// (broken-image icon), which is how the ingested Markdown references it. Make
// it well-formed before writing to disk; the result still works via innerHTML.

const VOID_TAGS = /<(br|hr|img|input|wbr|area|base|col|embed|link|meta|param|source|track)\b([^<>]*?)(?<!\/)>/gi;

// HTML entities that XML does not define (XML only knows lt/gt/amp/quot/apos).
const HTML_ONLY_ENTITIES: Record<string, string> = {
  nbsp: '#160',
  ensp: '#8194',
  emsp: '#8195',
  thinsp: '#8201',
  hellip: '#8230',
  ndash: '#8211',
  mdash: '#8212',
  lsquo: '#8216',
  rsquo: '#8217',
  ldquo: '#8220',
  rdquo: '#8221',
  laquo: '#171',
  raquo: '#187',
  copy: '#169',
  reg: '#174',
  trade: '#8482',
  bull: '#8226',
  middot: '#183',
  times: '#215',
  rarr: '#8594',
  larr: '#8592',
  uarr: '#8593',
  darr: '#8595',
  harr: '#8596',
  check: '#10003',
};

export function svgToWellFormedXml(svg: string): string {
  let out = svg.replace(VOID_TAGS, (_m, tag: string, attrs: string) => `<${tag}${attrs}/>`);
  out = out.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name: string) => {
    if (name === 'lt' || name === 'gt' || name === 'amp' || name === 'quot' || name === 'apos') return m;
    const num = HTML_ONLY_ENTITIES[name];
    return num ? `&${num};` : m;
  });
  return out;
}

// Mermaid emits `width="100%"` and no height on the root — as `<img>` that has
// no intrinsic size, so browsers pick 150px tall (aspect from viewBox) and the
// diagram shows as a thumbnail. Give the root explicit width/height from the
// viewBox so `max-width:100%; height:auto` scales it properly.
export function ensureSvgIntrinsicSize(svg: string): string {
  const rootMatch = /<svg\b[^>]*>/i.exec(svg);
  if (!rootMatch) return svg;
  const root = rootMatch[0];
  const vb = /\bviewBox\s*=\s*"([^"]+)"/i.exec(root)?.[1]?.trim().split(/[\s,]+/).map(Number);
  if (!vb || vb.length !== 4 || !(vb[2]! > 0) || !(vb[3]! > 0)) return svg;
  const w = Math.ceil(vb[2]!);
  const h = Math.ceil(vb[3]!);
  const widthAttr = /\bwidth\s*=\s*"([^"]*)"/i.exec(root)?.[1];
  const heightAttr = /\bheight\s*=\s*"([^"]*)"/i.exec(root)?.[1];
  const isPx = (v: string | undefined) => v !== undefined && /^\d+(\.\d+)?(px)?$/.test(v.trim());
  if (isPx(widthAttr) && isPx(heightAttr)) return svg;
  let next = root.replace(/\s+width\s*=\s*"[^"]*"/i, '').replace(/\s+height\s*=\s*"[^"]*"/i, '');
  next = next.replace(/^<svg\b/i, `<svg width="${w}" height="${h}"`);
  return svg.slice(0, rootMatch.index) + next + svg.slice(rootMatch.index + root.length);
}

/** What we write to disk for a diagram SVG that Markdown references via `<img>`. */
export function svgForImgEmbedding(svg: string): string {
  return ensureSvgIntrinsicSize(svgToWellFormedXml(svg));
}
