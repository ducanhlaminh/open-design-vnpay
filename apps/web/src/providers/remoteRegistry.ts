// Web → daemon calls for the remote registry (list + delete projects on the
// remote stores). Backs RemoteRegistryView; mirrors `od kg remote …` against
// the same endpoints. See apps/daemon/src/kg-sync-routes.ts.

import type { RemoteDeleteResult, RemoteDeleteScope, RemoteProject } from '@open-design/contracts';

function errorMessage(body: unknown, fallback: string): string {
  return (body as { error?: { message?: string } })?.error?.message ?? fallback;
}

/** List every project on the remote stores (KGS graph ⊕ media files). */
export async function listRemoteProjects(): Promise<RemoteProject[]> {
  const res = await fetch('/api/kg/remote-projects');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorMessage(body, `remote-projects → HTTP ${res.status}`));
  return (body as { data: RemoteProject[] }).data;
}

/** Delete a project's remote data. Phase 1 supports scope `files` only. */
export async function deleteRemoteProject(
  projectId: string,
  scope: RemoteDeleteScope = 'files',
): Promise<RemoteDeleteResult> {
  const res = await fetch(
    `/api/kg/remote-projects/${encodeURIComponent(projectId)}?scope=${encodeURIComponent(scope)}`,
    { method: 'DELETE' },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorMessage(body, `remote delete → HTTP ${res.status}`));
  return (body as { data: RemoteDeleteResult }).data;
}
