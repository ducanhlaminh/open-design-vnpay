import type {
  BindFeatureContextResult,
  PublishAppContextResult,
  PullAppContextResult,
} from '@open-design/contracts';

import type { ContextTransferSelection } from './PipelineModals';

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

export async function bindFeatureContext(input: {
  featureId: string;
  appId: string;
  contextVersion: string;
  contentDigest: string;
}): Promise<BindFeatureContextResult> {
  const response = await fetch(`/api/projects/${encodeURIComponent(input.featureId)}/context-binding`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      appId: input.appId,
      contextVersion: input.contextVersion,
      contentDigest: input.contentDigest,
    }),
  });
  const payload = await readPayload(response);
  if (!response.ok) throw new Error(String(payload.error ?? 'Không thể nâng version Context cho Feature.'));
  return payload.data as BindFeatureContextResult;
}

/** App Context has its own immutable package and endpoint. The Feature bulk
 * endpoint remains responsible only for Feature output files. */
export async function transferSelectedAppContexts(
  kind: 'push' | 'pull',
  selection: ContextTransferSelection,
): Promise<Array<PublishAppContextResult | PullAppContextResult | { status: 'kept_local'; appId: string }>> {
  const grouped = await Promise.all(selection.appIds.map(async (appId) => {
    if (kind === 'pull' && selection.contextConflictResolutions?.[appId] === 'keep_local') {
      return [{ status: 'kept_local' as const, appId }];
    }
    const versions = selection.contextVersions?.[appId]?.length
      ? selection.contextVersions[appId]!
      : [null];
    const results: Array<PublishAppContextResult | PullAppContextResult> = [];
    // Sequential within an App: historical bindings first, current last. This
    // keeps context/current.json on the App's chosen version after Pull.
    for (const contextVersion of versions) {
      const response = await fetch(
        `/api/pipelines/apps/${encodeURIComponent(appId)}/context/${kind}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(contextVersion ? { contextVersion } : {}),
        },
      );
      const payload = await readPayload(response);
      const data = payload.data as PublishAppContextResult | PullAppContextResult | undefined;
      if (!response.ok && data?.status !== 'conflict') {
        throw new Error(String(payload.error ?? ('message' in (data ?? {}) ? (data as { message: string }).message : `Không thể ${kind === 'push' ? 'chia sẻ' : 'lấy'} Context App.`)));
      }
      if (!data) throw new Error('Máy chủ không trả về kết quả Context App.');
      results.push(data);
    }
    return results;
  }));
  return grouped.flat();
}
