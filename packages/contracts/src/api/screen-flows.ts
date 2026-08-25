import type { ScreenOrigin } from './screens-overrides.js';

export type ScreenFlowSourceMode = 'reused' | 'generated';

export interface ScreenFlowSource {
  flowId: string;
  kind: 'drawio' | 'mermaid' | 'text';
  diagram?: string;
  asIs?: string;
}

export interface ScreenFlowScreen {
  key: string;
  name: string;
  /** Draw.io cell ids carrying this screen. Optional for old producers; the
   * viewer can also read `od-screen-key` directly from the XML. */
  cellIds?: string[];
  origin: ScreenOrigin;
  source: string | null;
  line: number | null;
  flowIds: string[];
  linked: boolean;
}

export interface ScreenFlowEdgeEvidence {
  flowId: string;
  fromNode: string;
  toNode: string;
  path: string[];
}

export type ScreenFlowEdgeKind = 'primary' | 'branch' | 'return' | 'secondary' | 'inferred';

export interface ScreenFlowEdge {
  id: string;
  from: string;
  to: string;
  via?: string;
  condition?: string;
  /** Semantic navigation class. Missing on v1 artifacts means `primary`. */
  kind?: ScreenFlowEdgeKind;
  flowIds: string[];
  evidence: ScreenFlowEdgeEvidence[];
}

export interface ScreenFlowModel {
  schema_version: 1;
  flowId: string;
  /** Deprecated alias kept optional for readers of the first draft. */
  id?: string;
  title: string;
  sourceMode: ScreenFlowSourceMode;
  source?: ScreenFlowSource;
  entryScreens: string[];
  screens: ScreenFlowScreen[];
  edges: ScreenFlowEdge[];
  unlinkedScreens: string[];
  warnings: string[];
}

export interface ScreenFlowIndexEntry {
  id: string;
  title: string;
  sourceMode: ScreenFlowSourceMode;
  files: { model: string; drawio: string };
  source?: ScreenFlowSource;
  screenCount: number;
  edgeCount: number;
  unlinkedCount: number;
  warnings: string[];
}

export interface ScreenFlowsIndex {
  schema_version: 1;
  generatedAt: string;
  flows: ScreenFlowIndexEntry[];
  totalScreens: number;
  warnings: string[];
}
