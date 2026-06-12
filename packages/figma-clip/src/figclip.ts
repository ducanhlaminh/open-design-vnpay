// figclip — read/write the current Figma clipboard container (version 106):
//   archive = "fig-kiwi" + u32 version + [u32 size + data]*
//   file[0] = Kiwi schema, raw DEFLATE
//   file[1] = message, ZSTD (Figma switched deflate→zstd)
// We frame the archive ourselves and only borrow kiwi-schema for the embedded codec.
import {
  type CompiledSchema,
  type Schema,
  compileSchema,
  decodeBinarySchema,
  encodeBinarySchema,
} from "kiwi-schema";

import { deflateRawSync, inflateRawSync, zstdCompress, zstdDecompress } from "./zlib-compat.js";

const FIG_PRELUDE = "fig-kiwi";
export const FIG_VERSION = 106;

const META_START = "<!--(figmeta)";
const META_END = "(/figmeta)-->";
const FIG_START = "<!--(figma)";
const FIG_END = "(/figma)-->";

export interface FigMeta {
  fileKey: string;
  pasteID: number;
  dataType: string;
  [key: string]: unknown;
}

export type FigMessage = Record<string, unknown>;

export interface ReadResult {
  header: { prelude: string; version: number };
  meta: FigMeta | null;
  schema: Schema;
  compiled: CompiledSchema;
  message: FigMessage;
}

// Browser clipboard capture escapes the comment markers; base64 never contains entities so
// blanket-unescaping the captured HTML is safe.
export function unescapeHTML(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function sliceBetween(html: string, a: string, b: string): string | null {
  const i = html.indexOf(a);
  if (i < 0) return null;
  const j = html.indexOf(b, i + a.length);
  if (j < 0) return null;
  return html.slice(i + a.length, j);
}

function parseArchive(bytes: Uint8Array): { header: { prelude: string; version: number }; files: Uint8Array[] } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const prelude = new TextDecoder().decode(bytes.subarray(0, FIG_PRELUDE.length));
  let off = FIG_PRELUDE.length;
  const version = dv.getUint32(off, true);
  off += 4;
  const files: Uint8Array[] = [];
  while (off + 4 <= bytes.length) {
    const size = dv.getUint32(off, true);
    off += 4;
    files.push(bytes.subarray(off, off + size));
    off += size;
  }
  return { header: { prelude, version }, files };
}

// prelude + u32 version + [u32 size + data]*
function buildArchive(version: number, chunks: Uint8Array[]): Uint8Array {
  const headerSize = FIG_PRELUDE.length + 4;
  const total = chunks.reduce((s, c) => s + 4 + c.byteLength, headerSize);
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  let off = new TextEncoder().encodeInto(FIG_PRELUDE, buf).written ?? FIG_PRELUDE.length;
  view.setUint32(off, version, true);
  off += 4;
  for (const c of chunks) {
    view.setUint32(off, c.byteLength, true);
    off += 4;
    buf.set(c, off);
    off += c.byteLength;
  }
  return buf;
}

function composeHTML(meta: unknown, figmaBytes: Uint8Array): string {
  const metaB64 = Buffer.from(JSON.stringify(meta), "utf8").toString("base64");
  const figB64 = Buffer.from(figmaBytes).toString("base64");
  // Markers stay literal (NOT escaped) — the exact shape Figma reads on paste.
  return (
    '<meta charset="utf-8"><div>' +
    `<span data-metadata="${META_START}${metaB64}${META_END}"></span>` +
    `<span data-buffer="${FIG_START}${figB64}${FIG_END}"></span>` +
    "</div>"
  );
}

/** Decode a captured clipboard payload back into its meta + schema + message. */
export function readClip(htmlRaw: string): ReadResult {
  const html = unescapeHTML(htmlRaw);
  const figB64 = sliceBetween(html, FIG_START, FIG_END);
  if (!figB64) throw new Error("Không thấy marker (figma) trong HTML");
  const metaB64 = sliceBetween(html, META_START, META_END);
  const meta = metaB64 ? (JSON.parse(Buffer.from(metaB64, "base64").toString("utf8")) as FigMeta) : null;

  const figma = Buffer.from(figB64, "base64");
  const { header, files } = parseArchive(new Uint8Array(figma));
  if (files.length < 2) throw new Error("Archive thiếu chunk (cần schema + message)");

  const schema = decodeBinarySchema(inflateRawSync(files[0]!));
  const compiled = compileSchema(schema);
  const message = compiled.decodeMessage(zstdDecompress(files[1]!));
  return { header, meta, schema, compiled, message };
}

export interface WriteClipArgs {
  meta: unknown;
  schema: Schema;
  message: FigMessage;
  compiled?: CompiledSchema;
  version?: number;
}

/** Encode meta + schema + message into a clipboard-ready `text/html` payload. */
export function writeClip({ meta, schema, message, compiled, version = FIG_VERSION }: WriteClipArgs): string {
  const codec = compiled ?? compileSchema(schema);
  const schemaChunk = deflateRawSync(encodeBinarySchema(schema));
  const msgChunk = zstdCompress(codec.encodeMessage(message));
  const archive = buildArchive(version, [new Uint8Array(schemaChunk), new Uint8Array(msgChunk)]);
  return composeHTML(meta, archive);
}
