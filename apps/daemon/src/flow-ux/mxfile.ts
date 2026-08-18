// draw.io mxfile helpers for the `dr-flow` (docs-flow-ux) stage.
//
// A `.drawio` file is `<mxfile><diagram name=… id=…>…</diagram>…</mxfile>`. The
// content of each `<diagram>` is either plain `<mxGraphModel>` XML or — the
// Confluence plugin default — base64(deflateRaw(encodeURIComponent(xml))).
// Agents cannot read or patch the compressed form, so the stage decodes every
// page ONCE (prepare step) and always writes plain XML back.
//
// Cell reading/writing goes through cheerio in XML mode: the mxfile grammar is
// small (mxCell / object / UserObject / mxGeometry) but attribute quoting and
// self-closing tags are exactly where a regex approach breaks on real files.

import zlib from 'node:zlib';
import { load, type CheerioAPI } from 'cheerio';

export interface MxPage {
  /** `<diagram id>` — kept when re-encoding so draw.io links stay valid. */
  id: string;
  name: string;
  /** Plain `<mxGraphModel>…</mxGraphModel>` XML. */
  graphXml: string;
}

/** One vertex or edge of a page, as the agent sees it (`cells.json`). */
export interface MxCellInfo {
  id: string;
  kind: 'vertex' | 'edge';
  /** Plain-text label (HTML tags/entities stripped, whitespace collapsed). */
  label: string;
  style: string;
  /** Edge endpoints (vertex ids); absent on vertices / dangling edges. */
  source?: string;
  target?: string;
  /** Vertex geometry (absolute page coordinates). */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Custom attributes carried by an `<object>` wrapper (draw.io "Edit Data"). */
  attrs?: Record<string, string>;
}

const OPEN_MXFILE = /<mxfile\b[^>]*>/i;

/** Decode one `<diagram>` body: compressed → plain; plain passes through. */
export function decodeDiagramContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  if (/^<mxGraphModel\b/i.test(trimmed) || /^<\?xml/i.test(trimmed)) return trimmed;
  // Compressed payload: base64 → raw-deflate → URI-encoded XML.
  try {
    const raw = zlib.inflateRawSync(Buffer.from(trimmed, 'base64')).toString('utf8');
    const xml = safeDecodeURIComponent(raw).trim();
    if (/^<mxGraphModel\b/i.test(xml)) return xml;
  } catch {
    /* fall through */
  }
  // Some exporters HTML-escape a plain model inside <diagram>.
  const unescaped = unescapeXmlEntities(trimmed);
  if (/^<mxGraphModel\b/i.test(unescaped)) return unescaped;
  throw new Error('diagram content is neither plain <mxGraphModel> nor a deflate+base64 payload');
}

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function unescapeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Split an mxfile into decoded pages. A bare `<mxGraphModel>` (no mxfile
 *  wrapper) is treated as one unnamed page. */
export function decodeMxfile(xml: string): MxPage[] {
  const src = xml.replace(/^﻿/, '');
  if (!OPEN_MXFILE.test(src)) {
    const plain = decodeDiagramContent(src);
    return [{ id: 'page-1', name: 'Page-1', graphXml: plain }];
  }
  const pages: MxPage[] = [];
  const re = /<diagram\b([^>]*)>([\s\S]*?)<\/diagram>/gi;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(src))) {
    i += 1;
    const attrs = m[1] ?? '';
    const name = unescapeXmlEntities(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? `Page-${i}`);
    const id = /\bid="([^"]*)"/.exec(attrs)?.[1] ?? `page-${i}`;
    pages.push({ id, name, graphXml: decodeDiagramContent(m[2] ?? '') });
  }
  if (!pages.length) {
    // `<diagram …/>` self-closing or a model outside any diagram tag.
    const model = /<mxGraphModel\b[\s\S]*<\/mxGraphModel>/i.exec(src)?.[0];
    if (model) pages.push({ id: 'page-1', name: 'Page-1', graphXml: model });
  }
  return pages;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build a plain (uncompressed) mxfile from pages. `compressed="false"` tells
 *  draw.io to keep it that way on save. */
export function encodeMxfile(pages: MxPage[], opts?: { host?: string }): string {
  const host = opts?.host ?? 'open-design';
  const body = pages
    .map((p) => `  <diagram id="${escapeAttr(p.id)}" name="${escapeAttr(p.name)}">\n${indent(p.graphXml.trim(), 4)}\n  </diagram>`)
    .join('\n');
  return `<mxfile host="${escapeAttr(host)}" compressed="false">\n${body}\n</mxfile>\n`;
}

function indent(s: string, n: number): string {
  const pad = ' '.repeat(n);
  return s
    .split('\n')
    .map((l) => (l.length ? pad + l : l))
    .join('\n');
}

/** Load a page's graph XML into cheerio (XML mode, no entity decoding). */
export function loadGraph(graphXml: string): CheerioAPI {
  return load(graphXml, { xml: { decodeEntities: false } }, false);
}

/** Serialize a cheerio graph back to XML. */
export function serializeGraph($: CheerioAPI): string {
  return $.xml();
}

/** Strip HTML from a draw.io label into one-line plain text. */
export function plainLabel(value: string | undefined | null): string {
  if (!value) return '';
  return unescapeXmlEntities(
    value
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(div|p|li|tr)>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every mxCell in the page (skips the two structural roots `0` and `1`). */
export function listCells(graphXml: string): MxCellInfo[] {
  const $ = loadGraph(graphXml);
  const out: MxCellInfo[] = [];
  $('mxCell').each((_, el) => {
    const cell = $(el);
    const id = cell.attr('id') ?? '';
    const isVertex = cell.attr('vertex') === '1';
    const isEdge = cell.attr('edge') === '1';
    if (!isVertex && !isEdge) return; // roots / layers
    const wrapper = cell.parent();
    const wrapped = wrapper.length && /^(object|UserObject)$/i.test(wrapper.prop('tagName') ?? '');
    const rawLabel = wrapped ? (wrapper.attr('label') ?? cell.attr('value') ?? '') : (cell.attr('value') ?? '');
    const info: MxCellInfo = {
      id: wrapped ? (wrapper.attr('id') ?? id) : id,
      kind: isEdge ? 'edge' : 'vertex',
      label: plainLabel(rawLabel),
      style: cell.attr('style') ?? '',
    };
    if (isEdge) {
      const s = cell.attr('source');
      const t = cell.attr('target');
      if (s) info.source = s;
      if (t) info.target = t;
    } else {
      const g = cell.children('mxGeometry').first();
      if (g.length) {
        const num = (k: string) => {
          const v = Number(g.attr(k));
          return Number.isFinite(v) ? v : undefined;
        };
        const x = num('x');
        const y = num('y');
        const w = num('width');
        const h = num('height');
        if (x !== undefined) info.x = x;
        if (y !== undefined) info.y = y;
        if (w !== undefined) info.width = w;
        if (h !== undefined) info.height = h;
      }
    }
    if (wrapped) {
      const attrs: Record<string, string> = {};
      const raw = (wrapper.get(0) as { attribs?: Record<string, string> } | undefined)?.attribs ?? {};
      for (const [k, v] of Object.entries(raw)) {
        if (k === 'label' || k === 'id') continue;
        attrs[k] = unescapeXmlEntities(v);
      }
      if (Object.keys(attrs).length) info.attrs = attrs;
    }
    out.push(info);
  });
  return out;
}

/** Style helpers — draw.io styles are `k=v;k=v;shape;` lists. */
export function styleGet(style: string, key: string): string | undefined {
  for (const part of style.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === key) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function styleSet(style: string, patch: Record<string, string>): string {
  const parts = style.split(';').filter((p) => p.trim().length > 0);
  const keys = new Set(Object.keys(patch));
  const kept = parts.filter((p) => {
    const eq = p.indexOf('=');
    return !(eq > 0 && keys.has(p.slice(0, eq).trim()));
  });
  for (const [k, v] of Object.entries(patch)) kept.push(`${k}=${v}`);
  return `${kept.join(';')};`;
}

export function styleHas(style: string, token: string): boolean {
  return style.split(';').some((p) => p.trim() === token);
}
