import type {
  ScreenFlowLayoutEntry,
  ScreenFlowLayoutOverrides,
  ScreenFlowPosition,
  UpdateScreenFlowLayoutRequest,
} from '@open-design/contracts';

export const SCREEN_FLOW_LAYOUT_OVERRIDES_REL = 'screen-flow-layout-overrides.json';
const MAX_FLOWS = 100;
const MAX_POSITIONS = 500;
const MAX_COORDINATE = 1_000_000;

const empty = (): ScreenFlowLayoutOverrides => ({ schema_version: 1, flows: {} });
const str = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

function positionOf(value: unknown): ScreenFlowPosition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const point = value as Record<string, unknown>;
  if (typeof point.x !== 'number' || typeof point.y !== 'number') return null;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  if (Math.abs(point.x) > MAX_COORDINATE || Math.abs(point.y) > MAX_COORDINATE) return null;
  return { x: point.x, y: point.y };
}

function entryOf(value: unknown, warnings: string[], prefix: string): ScreenFlowLayoutEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    warnings.push(`${prefix}: layout phải là object.`);
    return null;
  }
  const input = value as Record<string, unknown>;
  const rawPositions = input.positions;
  if (!rawPositions || typeof rawPositions !== 'object' || Array.isArray(rawPositions)) {
    warnings.push(`${prefix}: positions phải là object.`);
    return null;
  }
  const positions: Record<string, ScreenFlowPosition> = {};
  for (const [rawKey, rawPoint] of Object.entries(rawPositions).slice(0, MAX_POSITIONS)) {
    const key = str(rawKey);
    const point = positionOf(rawPoint);
    if (!key || !point) {
      warnings.push(`${prefix}: position không hợp lệ cho "${rawKey}".`);
      continue;
    }
    positions[key] = point;
  }
  return {
    positions,
    locked: input.locked === true,
    updatedAt: str(input.updatedAt) || new Date(0).toISOString(),
  };
}

/** Fail-soft reader for a user-owned file that may have been edited by hand. */
export function parseScreenFlowLayoutOverrides(raw: string): {
  doc: ScreenFlowLayoutOverrides;
  warnings: string[];
} {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { doc: empty(), warnings: [`layout JSON không hợp lệ: ${(error as Error).message}`] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { doc: empty(), warnings: ['layout phải là object.'] };
  }
  const input = parsed as Record<string, unknown>;
  if (input.schema_version !== 1 || !input.flows || typeof input.flows !== 'object' || Array.isArray(input.flows)) {
    return { doc: empty(), warnings: ['layout phải có schema_version=1 và flows object.'] };
  }
  const flows: ScreenFlowLayoutOverrides['flows'] = {};
  for (const [rawFlowId, rawEntry] of Object.entries(input.flows).slice(0, MAX_FLOWS)) {
    const flowId = str(rawFlowId);
    if (!flowId) continue;
    const entry = entryOf(rawEntry, warnings, `flows.${flowId}`);
    if (entry) flows[flowId] = entry;
  }
  return { doc: { schema_version: 1, flows }, warnings };
}

/** Strict request application. Any malformed position rejects the whole update
 * so a UI bug cannot silently discard a user's previously saved layout. */
export function applyScreenFlowLayoutUpdate(
  current: ScreenFlowLayoutOverrides,
  input: unknown,
  now = new Date().toISOString(),
): { doc: ScreenFlowLayoutOverrides; error?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { doc: current, error: 'Body phải là object.' };
  const request = input as UpdateScreenFlowLayoutRequest;
  const flowId = str(request.flowId);
  if (!flowId || flowId.length > 200) return { doc: current, error: 'flowId không hợp lệ.' };
  const flows = { ...current.flows };
  if (request.reset === true) {
    delete flows[flowId];
    return { doc: { schema_version: 1, flows } };
  }
  if (!request.positions || typeof request.positions !== 'object' || Array.isArray(request.positions)) {
    return { doc: current, error: 'positions phải là object.' };
  }
  const entries = Object.entries(request.positions);
  if (entries.length > MAX_POSITIONS) return { doc: current, error: `positions vượt giới hạn ${MAX_POSITIONS}.` };
  const positions: Record<string, ScreenFlowPosition> = {};
  for (const [rawKey, rawPoint] of entries) {
    const key = str(rawKey);
    const point = positionOf(rawPoint);
    if (!key || !point) return { doc: current, error: `position không hợp lệ cho "${rawKey}".` };
    positions[key] = point;
  }
  flows[flowId] = { positions, locked: request.locked === true, updatedAt: now };
  return { doc: { schema_version: 1, flows } };
}

export function reconcileScreenFlowLayout(
  current: ScreenFlowLayoutOverrides,
  validKeysByFlow: ReadonlyMap<string, ReadonlySet<string>>,
): ScreenFlowLayoutOverrides {
  const flows: ScreenFlowLayoutOverrides['flows'] = {};
  for (const [flowId, entry] of Object.entries(current.flows)) {
    const valid = validKeysByFlow.get(flowId);
    if (!valid) continue;
    const positions = Object.fromEntries(Object.entries(entry.positions).filter(([key]) => valid.has(key)));
    flows[flowId] = { ...entry, positions };
  }
  return { schema_version: 1, flows };
}
