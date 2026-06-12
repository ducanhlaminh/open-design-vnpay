// node:zlib compression used by the .fig container: raw DEFLATE for the schema chunk and
// ZSTD for the message chunk. zstd* landed in Node 24; we access it defensively so a missing
// runtime fails loud rather than at a confusing call site, and we don't depend on @types/node
// shipping the zstd signatures.
import * as zlib from "node:zlib";

type ZstdFn = (buf: Uint8Array) => Buffer;
const z = zlib as unknown as {
  zstdCompressSync?: ZstdFn;
  zstdDecompressSync?: ZstdFn;
};

export function zstdCompress(buf: Uint8Array): Buffer {
  if (!z.zstdCompressSync) {
    throw new Error("node:zlib.zstdCompressSync không khả dụng — cần Node ~24");
  }
  return z.zstdCompressSync(buf);
}

export function zstdDecompress(buf: Uint8Array): Buffer {
  if (!z.zstdDecompressSync) {
    throw new Error("node:zlib.zstdDecompressSync không khả dụng — cần Node ~24");
  }
  return z.zstdDecompressSync(buf);
}

export { deflateRawSync, inflateRawSync } from "node:zlib";
