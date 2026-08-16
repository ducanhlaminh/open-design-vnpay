// Web client for the daemon's Figma token endpoints (see
// packages/contracts/src/api/figma-config.ts). `GET /api/figma-config` never
// returns the real token, only whether one is saved (`hasToken`).

import type {
  FigmaConfigResponse,
  PutFigmaConfigRequest,
  TestFigmaConfigRequest,
  TestFigmaConfigResponse,
  VerifyFigmaLinksRequest,
  VerifyFigmaLinksResponse,
} from '@open-design/contracts';

export type {
  FigmaConfigResponse,
  PutFigmaConfigRequest,
  TestFigmaConfigRequest,
  TestFigmaConfigResponse,
  VerifyFigmaLinksRequest,
  VerifyFigmaLinksResponse,
};

async function readJson<T>(res: Response): Promise<T | null> {
  try { return (await res.json()) as T; } catch { return null; }
}

export async function fetchFigmaConfig(): Promise<FigmaConfigResponse | null> {
  try {
    const res = await fetch('/api/figma-config');
    if (!res.ok) return null;
    const data = await readJson<FigmaConfigResponse>(res);
    return { hasToken: Boolean(data?.hasToken) };
  } catch {
    return null;
  }
}

export async function saveFigmaConfig(body: PutFigmaConfigRequest): Promise<FigmaConfigResponse | null> {
  try {
    const res = await fetch('/api/figma-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = await readJson<FigmaConfigResponse>(res);
    return { hasToken: Boolean(data?.hasToken) };
  } catch {
    return null;
  }
}

export async function testFigmaConnection(body: TestFigmaConfigRequest = {}): Promise<TestFigmaConfigResponse> {
  try {
    const res = await fetch('/api/figma-config/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, detail: `Daemon trả về ${res.status}` };
    return (await readJson<TestFigmaConfigResponse>(res)) ?? { ok: false, detail: 'Phản hồi không hợp lệ.' };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : 'Không gọi được daemon.' };
  }
}

export async function verifyFigmaLinks(body: VerifyFigmaLinksRequest, signal?: AbortSignal): Promise<VerifyFigmaLinksResponse | null> {
  try {
    const res = await fetch('/api/figma-config/verify-links', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) return null;
    return await readJson<VerifyFigmaLinksResponse>(res);
  } catch {
    return null;
  }
}

// Local shape mirroring the daemon's `GET /api/figma-desktop/status` (see
// specs/change/20260816-figma-desktop-tools/wp2-*.md, owned by a parallel
// work package). Declared here instead of imported from `@open-design/contracts`
// because that package may not be rebuilt yet when this module typechecks.
export interface FigmaDesktopStatusResponse {
  available: boolean;
  detail?: string;
  activeFileTitle?: string | null;
  canSwitch: boolean;
  platform: string;
}

export async function fetchFigmaDesktopStatus(signal?: AbortSignal): Promise<FigmaDesktopStatusResponse | null> {
  try {
    const res = await fetch('/api/figma-desktop/status', { signal });
    if (!res.ok) return null;
    return await readJson<FigmaDesktopStatusResponse>(res);
  } catch {
    return null;
  }
}
