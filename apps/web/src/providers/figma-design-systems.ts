import type {
  CreateFigmaDesignSystemSourceRequest,
  FigmaDesignSystemSource,
  GetFigmaDesignSystemSourceResponse,
  ListFigmaDesignSystemSourcesResponse,
  RefreshFigmaDesignSystemSourceResponse,
} from '@open-design/contracts';

export type { FigmaDesignSystemSource } from '@open-design/contracts';

type SourcePayload = CreateFigmaDesignSystemSourceRequest;

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: string | { message?: string } } | null;
  if (typeof body?.error === 'string') return body.error;
  if (body?.error && typeof body.error.message === 'string') return body.error.message;
  return fallback;
}

export async function fetchFigmaDesignSystems(): Promise<FigmaDesignSystemSource[]> {
  const response = await fetch('/api/figma-design-systems');
  if (!response.ok) throw new Error(await errorMessage(response, 'Không tải được Design system Figma.'));
  const body = await response.json() as ListFigmaDesignSystemSourcesResponse;
  return body.sources ?? [];
}

export async function fetchFigmaDesignSystemDetail(id: string): Promise<GetFigmaDesignSystemSourceResponse> {
  const response = await fetch(`/api/figma-design-systems/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(await errorMessage(response, 'Không tải được Design system Figma.'));
  return await response.json() as GetFigmaDesignSystemSourceResponse;
}

export async function fetchFigmaDesignSystem(id: string): Promise<FigmaDesignSystemSource> {
  return (await fetchFigmaDesignSystemDetail(id)).source;
}

export async function createFigmaDesignSystem(payload: SourcePayload): Promise<FigmaDesignSystemSource> {
  const response = await fetch('/api/figma-design-systems', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await errorMessage(response, 'Không tạo được Design system Figma.'));
  const body = await response.json() as { source?: FigmaDesignSystemSource } | FigmaDesignSystemSource;
  return 'source' in body && body.source ? body.source : body as FigmaDesignSystemSource;
}

export async function updateFigmaDesignSystem(id: string, payload: SourcePayload): Promise<FigmaDesignSystemSource> {
  const response = await fetch(`/api/figma-design-systems/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await errorMessage(response, 'Không cập nhật được Design system Figma.'));
  const body = await response.json() as { source?: FigmaDesignSystemSource } | FigmaDesignSystemSource;
  return 'source' in body && body.source ? body.source : body as FigmaDesignSystemSource;
}

export async function refreshFigmaDesignSystem(id: string): Promise<RefreshFigmaDesignSystemSourceResponse> {
  const response = await fetch(`/api/figma-design-systems/${encodeURIComponent(id)}/refresh`, { method: 'POST' });
  if (!response.ok) throw new Error(await errorMessage(response, 'Không thể làm mới danh mục component.'));
  return await response.json() as RefreshFigmaDesignSystemSourceResponse;
}

export async function deleteFigmaDesignSystem(id: string): Promise<void> {
  const response = await fetch(`/api/figma-design-systems/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(await errorMessage(response, 'Không thể xóa Design system Figma.'));
}
