// Web → daemon calls for design-v3 KG sync (pull/push/status). Backs the
// KgSyncButtons toolbar action; mirrors the `od kg …` CLI against the same
// /api/projects/:id/kg-* endpoints. See apps/daemon/src/kg-sync-routes.ts.

import type { KgPullResult, KgPushResult, KgSyncCounts } from '@open-design/contracts';

async function postJson<T>(url: string): Promise<T> {
  const resp = await fetch(url, { method: 'POST' });
  const body = await resp.json().catch(() => ({} as Record<string, unknown>));
  if (!resp.ok) {
    const err = (body as { error?: { message?: string } }).error;
    throw new Error(err?.message ?? `${url} → HTTP ${resp.status}`);
  }
  return (body as { data: T }).data;
}

export function kgPull(projectId: string): Promise<KgPullResult> {
  return postJson<KgPullResult>(`/api/projects/${encodeURIComponent(projectId)}/kg-pull`);
}

export function kgPush(projectId: string): Promise<KgPushResult> {
  return postJson<KgPushResult>(`/api/projects/${encodeURIComponent(projectId)}/kg-push`);
}

export async function kgStatus(projectId: string): Promise<KgSyncCounts> {
  const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/kg-status`);
  const body = await resp.json().catch(() => ({} as Record<string, unknown>));
  if (!resp.ok) {
    const err = (body as { error?: { message?: string } }).error;
    throw new Error(err?.message ?? `kg-status → HTTP ${resp.status}`);
  }
  return (body as { data: KgSyncCounts }).data;
}
