// Minimal type shim for kiwi-schema (Evan Wallace's Kiwi binary format) — the published
// package ships no .d.ts. We only use the schema (de)serialize + compile/encode/decode entry points.
declare module "kiwi-schema" {
  /** Self-describing Kiwi schema (parsed from binary). Opaque to us. */
  export type Schema = unknown;
  /** Compiled schema with message codec bound to the embedded definitions. */
  export interface CompiledSchema {
    encodeMessage(message: unknown): Uint8Array;
    decodeMessage(bytes: Uint8Array): Record<string, unknown>;
    [key: string]: unknown;
  }
  export function decodeBinarySchema(bytes: Uint8Array): Schema;
  export function encodeBinarySchema(schema: Schema): Uint8Array;
  export function compileSchema(schema: Schema): CompiledSchema;
}
