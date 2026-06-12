// Pinned scaffold: the Kiwi schema + base message (DOCUMENT + CANVAS roots, empty blobs)
// + meta, snapshotted once from a real Figma copy (see spec D3). Lets irToClip synthesise a
// payload without a live reference file. Refresh assets/snapshot.json when Figma bumps format.
import { type CompiledSchema, type Schema, compileSchema, decodeBinarySchema } from "kiwi-schema";

import { readAssetJSON } from "./assets.js";
import type { FigMessage, FigMeta } from "./figclip.js";

interface Snapshot {
  version: number;
  schemaB64: string;
  meta: FigMeta;
  message: FigMessage;
}

interface Guid {
  sessionID: number;
  localID: number;
}
interface ScaffoldNode {
  guid?: Guid;
  [key: string]: unknown;
}

const snapshot = readAssetJSON<Snapshot>("snapshot.json");
const schema: Schema = decodeBinarySchema(new Uint8Array(Buffer.from(snapshot.schemaB64, "base64")));
const compiled: CompiledSchema = compileSchema(schema);

export interface Scaffold {
  version: number;
  schema: Schema;
  compiled: CompiledSchema;
  meta: FigMeta;
  message: FigMessage & { nodeChanges: ScaffoldNode[]; blobs: unknown[] };
  document: ScaffoldNode;
  canvas: ScaffoldNode;
}

function findRoot(nodes: ScaffoldNode[], localID: number): ScaffoldNode {
  const n = nodes.find((node) => node.guid?.sessionID === 0 && node.guid?.localID === localID);
  if (!n) throw new Error(`figma-clip scaffold: thiếu node gốc 0:${localID}`);
  return n;
}

/** A fresh, mutable copy of the pinned scaffold (deep-cloned per call). */
export function getScaffold(): Scaffold {
  const message = structuredClone(snapshot.message) as Scaffold["message"];
  const meta = structuredClone(snapshot.meta);
  const document = findRoot(message.nodeChanges, 0);
  const canvas = findRoot(message.nodeChanges, 1);
  return { version: snapshot.version, schema, compiled, meta, message, document, canvas };
}
