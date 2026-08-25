export interface ScreenFlowPosition {
  x: number;
  y: number;
}

export interface ScreenFlowLayoutEntry {
  positions: Record<string, ScreenFlowPosition>;
  locked: boolean;
  updatedAt: string;
}

export interface ScreenFlowLayoutOverrides {
  schema_version: 1;
  flows: Record<string, ScreenFlowLayoutEntry>;
}

export interface UpdateScreenFlowLayoutRequest {
  flowId: string;
  /** Remove the saved layout for this flow. */
  reset?: boolean;
  positions?: Record<string, ScreenFlowPosition>;
  locked?: boolean;
}

export interface UpdateScreenFlowLayoutResponse {
  ok: true;
  layout: ScreenFlowLayoutOverrides;
}
