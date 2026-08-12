// Điều phối bốn cấp của Pipelines: App → Feature → Pipeline → Chạy.
//
// Cấp đang xem đọc từ URL, không phải từ state, nên F5 không mất chỗ và link
// dán được. Ba màn đầu là màn chọn; màn Chạy là PipelinesView — nó giữ nguyên
// toàn bộ logic chạy/đồng bộ/lịch sử đã có, chỉ khác là feature và pipeline
// giờ đến từ route thay vì từ bộ chọn của chính nó.
//
// Hook dữ liệu được giữ Ở ĐÂY và truyền xuống: ba màn đầu hỏi cùng một câu
// ("có app nào, feature nào, tới đâu rồi"), nên chúng phải đọc cùng một câu
// trả lời — ba lần fetch riêng là ba cách đếm tiến độ khác nhau, và người dùng
// sẽ thấy màn 1 nói 4/6 còn màn 2 nói 3/6.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AuthMeResponse,
  PipelineProject,
  ProjectSyncOrigin,
  ProjectSyncOriginSelection,
  ProjectSyncResolution,
  ProjectSyncScope,
  ProjectSyncScopeStatus,
  Workflow,
} from '@open-design/contracts';

import { UNASSIGNED_APP, navigate, useRoute } from '../../router';
import { Toast } from '../Toast';
import { PipelinesView } from '../PipelinesView';
import { ProjectSyncPreviewModal } from '../project-sync';
import { PushAllModal, type ContextTransferSelection, type FeatureStageSelections } from './PipelineModals';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { EditAppModal } from './EditAppModal';
import { EditFeatureModal } from './EditFeatureModal';
import { NewAppModal } from './NewAppModal';
import { NewFeatureModal } from './NewFeatureModal';
import { PipelinesAppsView } from './PipelinesAppsView';
import { PipelinesFeaturesView } from './PipelinesFeaturesView';
import { PipelinePickerView } from './PipelinePickerView';
import { applyProjectSync, getProjectSyncStatuses, listProjectSyncOrigins, planProjectSync } from '../../providers/project-sync';
import { usePipelineNav } from './usePipelineNav';
import type { NavApp } from './usePipelineNav';

function generatedShareOriginId(scope: ProjectSyncScope): string {
  const prefix = scope.projectId
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || scope.kind;
  const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8)
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `${prefix}--${suffix}`;
}

function stageIdFromEntryPath(path: string): string | null {
  const parts = path.split('/');
  const outputIndex = parts.findIndex((part) => part === 'output' || part === 'outputs');
  return outputIndex >= 0 ? parts[outputIndex + 1] ?? null : null;
}

// Một App/Feature bị xóa thì màn đang xem nó không còn nghĩa gì — lùi lên một
// cấp thay vì để người dùng ngồi nhìn "Không tìm thấy app này".
export async function deleteAppFromMachine(appId: string): Promise<void> {
  const res = await fetch(`/api/pipelines/apps/${encodeURIComponent(appId)}`, { method: 'DELETE' });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || `Không thể xóa dự án khỏi máy: HTTP ${res.status}`);
}

export function appDeleteMessage(featureCount: number, hasSharedCopy = true): string {
  const localScope = featureCount > 0
    ? `${featureCount} tính năng và toàn bộ dữ liệu của dự án trên máy này sẽ bị xóa. `
    : 'Dự án này không có tính năng trên máy. ';
  return hasSharedCopy
    ? `${localScope}Bản trong kho chung không bị ảnh hưởng. Bạn có thể lấy lại dự án sau.`
    : `${localScope}Dự án chưa có bản trong kho chung nên bạn sẽ không thể lấy lại sau khi xóa.`;
}

export function appDeleteWarning(featureCount: number, hasSharedCopy: boolean): string | null {
  if (!hasSharedCopy && featureCount > 0) {
    return `Dự án này chỉ có trên máy và đang chứa ${featureCount} tính năng. Xóa dự án có thể làm mất toàn bộ dữ liệu này.`;
  }
  if (!hasSharedCopy) {
    return 'Dự án này chỉ có trên máy. Hãy đưa lên kho chung trước nếu bạn muốn giữ một bản sao.';
  }
  if (featureCount > 0) {
    return `Thao tác này sẽ xóa cả ${featureCount} tính năng và dữ liệu chạy bên trong khỏi máy.`;
  }
  return null;
}

// Feature dùng route xóa project CÓ SẴN — thư mục làm việc và trạng thái chạy
// là dữ liệu của project, không phải một khái niệm riêng của Pipelines.
async function deleteFeature(featureId: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(featureId)}`, { method: 'DELETE' });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || `xóa Feature thất bại: ${res.status}`);
}

export function PipelinesRoute() {
  const route = useRoute();
  const nav = usePipelineNav();
  const [syncAccess, setSyncAccess] = useState<Pick<AuthMeResponse, 'syncReady' | 'syncIssue'> | null>(null);
  const [syncToast, setSyncToast] = useState<{ message: string; details?: string; error?: boolean } | null>(null);
  const [syncStatusByAppId, setSyncStatusByAppId] = useState<Map<string, ProjectSyncScopeStatus>>(new Map());
  const [syncStatusByFeatureId, setSyncStatusByFeatureId] = useState<Map<string, ProjectSyncScopeStatus>>(new Map());
  const [syncStatusReloadTick, setSyncStatusReloadTick] = useState(0);
  const [syncDialog, setSyncDialog] = useState<{
    scope: ProjectSyncScope;
    subjectName: string;
  } | null>(null);
  const [shareDialog, setShareDialog] = useState<{
    initialFeatureIds: string[];
    initialAppIds: string[];
    scopeName: string;
    scope: ProjectSyncScope;
    subjectName: string;
  } | null>(null);
  const [shareWorkflows, setShareWorkflows] = useState<Workflow[]>([]);
  const [shareDestinations, setShareDestinations] = useState<ProjectSyncOrigin[]>([]);
  const [shareDestination, setShareDestination] = useState<ProjectSyncOriginSelection | null>(null);
  const [shareNewOriginId, setShareNewOriginId] = useState('');

  const refreshSyncAccess = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/me');
      const body = (await response.json().catch(() => ({}))) as Partial<AuthMeResponse>;
      setSyncAccess({ syncReady: response.ok && body.syncReady === true, syncIssue: body.syncIssue ?? null });
    } catch {
      setSyncAccess({ syncReady: false, syncIssue: 'identity_unavailable' });
    }
  }, []);
  useEffect(() => { void refreshSyncAccess(); }, [refreshSyncAccess]);
  useEffect(() => {
    void fetch('/api/workflows')
      .then(async (response) => response.ok ? response.json() : null)
      .then((body) => setShareWorkflows(Array.isArray(body?.workflows) ? body.workflows : []))
      .catch(() => setShareWorkflows([]));
  }, []);

  const shareSelectedResults = useCallback(async (
    selection: ContextTransferSelection,
    stages: string[],
    stagesByFeature: FeatureStageSelections = {},
  ) => {
    if (!shareDialog || !shareDestination) {
      throw new Error('Hãy chọn nơi chia sẻ trước khi tiếp tục.');
    }
    // The modal keeps the familiar workflow-step picker.  The plan remains
    // authoritative: its scope controls the App/Feature tree and its selected
    // origin controls where the result is actually written.
    const plan = await planProjectSync({
      direction: 'push',
      scope: shareDialog.scope,
      origin: shareDestination,
      includeDeleted: true,
    });
    const selectedStages = new Set(stages);
    const selectedFeatureIds = new Set(selection.projectIds);
    const resolutions: Record<string, ProjectSyncResolution> = {};
    for (const entry of plan.entries) {
      if (entry.featureId && !selectedFeatureIds.has(entry.featureId)) {
        resolutions[entry.path] = 'skip';
        continue;
      }
      const stageId = entry.kind === 'output' ? entry.stage ?? stageIdFromEntryPath(entry.path) : null;
      const featureStages = entry.featureId && stagesByFeature[entry.featureId]
        ? new Set(stagesByFeature[entry.featureId])
        : selectedStages;
      resolutions[entry.path] = stageId && !featureStages.has(stageId) ? 'skip' : entry.resolution;
    }
    const result = await applyProjectSync({ planId: plan.planId, resolutions });
    if (result.stale.length > 0) {
      throw new Error('Bản trong kho chung vừa thay đổi. Hãy mở lại để xem lại thay đổi trước khi chia sẻ.');
    }
    await nav.reload();
    setSyncStatusReloadTick((tick) => tick + 1);
    setSyncToast({ message: 'Đã chia sẻ kết quả. Danh sách trên máy đang được làm mới.' });
  }, [nav, shareDestination, shareDialog]);
  const localSyncScopes = useMemo<ProjectSyncScope[]>(() => [
      ...nav.apps.filter((app) => !app.unassigned).map((app) => ({ kind: 'app' as const, projectId: app.id })),
      ...nav.projects.map((feature) => ({
        kind: 'feature' as const,
        projectId: feature.id,
        appId: feature.app?.id?.trim() || null,
      })),
  ], [nav.apps, nav.projects]);
  // The route mock (and some future callers) may create fresh arrays on every
  // render. Depend on the actual scope identities, not array identity, so a
  // status refresh cannot trigger an accidental fetch loop.
  const localSyncScopeKey = localSyncScopes.map((scope) =>
    `${scope.kind}:${scope.projectId}:${scope.appId ?? ''}`,
  ).join('|');
  useEffect(() => {
    if (!nav.loaded) return undefined;
    const scopes: ProjectSyncScope[] = [
      ...nav.apps.filter((app) => !app.unassigned).map((app) => ({ kind: 'app' as const, projectId: app.id })),
      ...nav.projects.map((feature) => ({
        kind: 'feature' as const,
        projectId: feature.id,
        appId: feature.app?.id?.trim() || null,
      })),
    ];
    if (scopes.length === 0) {
      setSyncStatusByAppId(new Map());
      setSyncStatusByFeatureId(new Map());
      return undefined;
    }
    let cancelled = false;
    void getProjectSyncStatuses(scopes)
      .then((statuses) => {
        if (cancelled) return;
        const apps = new Map<string, ProjectSyncScopeStatus>();
        const features = new Map<string, ProjectSyncScopeStatus>();
        for (const status of statuses) {
          if (status.scope.kind === 'app') apps.set(status.scope.projectId, status);
          else features.set(status.scope.projectId, status);
        }
        setSyncStatusByAppId(apps);
        setSyncStatusByFeatureId(features);
      })
      // Status badges are a progressive enhancement. Local navigation and the
      // action modal keep working when kho chung is temporarily unavailable.
      .catch(() => { if (!cancelled) { setSyncStatusByAppId(new Map()); setSyncStatusByFeatureId(new Map()); } });
    return () => { cancelled = true; };
  // `localSyncScopeKey` is intentionally the identity boundary; see above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localSyncScopeKey, nav.loaded, syncStatusReloadTick]);
  useEffect(() => {
    if (!shareDialog) {
      setShareDestinations([]);
      setShareDestination(null);
      setShareNewOriginId('');
      return undefined;
    }
    const status = shareDialog.scope.kind === 'app'
      ? syncStatusByAppId.get(shareDialog.scope.projectId)
      : syncStatusByFeatureId.get(shareDialog.scope.projectId);
    const mappedOrigin = status?.mappingValid && status.origin?.visibility === 'visible'
      ? status.origin
      : null;
    const newOriginId = generatedShareOriginId(shareDialog.scope);
    setShareNewOriginId(newOriginId);
    const initialDestination: ProjectSyncOriginSelection = mappedOrigin
      ? { mode: 'existing', originId: mappedOrigin.originId }
      : { mode: 'new', originId: newOriginId };
    setShareDestination(initialDestination);

    const originScope = shareDialog.scope.kind === 'feature' && shareDialog.scope.appId
      ? { ...shareDialog.scope, appId: status?.app?.originId ?? shareDialog.scope.appId }
      : shareDialog.scope;
    let cancelled = false;
    void listProjectSyncOrigins(originScope)
      .then((origins) => {
        if (cancelled) return;
        const visibleOrigins = origins.filter((origin) => origin.visibility === 'visible');
        if (mappedOrigin && !visibleOrigins.some((origin) => origin.originId === mappedOrigin.originId)) {
          visibleOrigins.unshift(mappedOrigin);
        }
        setShareDestinations(visibleOrigins);
      })
      // Sharing a new copy does not require the optional destination list to
      // load, so keep the modal usable when this lookup is temporarily down.
      .catch(() => { if (!cancelled) setShareDestinations(mappedOrigin ? [mappedOrigin] : []); });
    return () => { cancelled = true; };
  }, [shareDialog, syncStatusByAppId, syncStatusByFeatureId]);
  const reconnectSync = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.reload();
  }, []);
  // Đang tạo gì. Dùng union chứ không dùng một chuỗi "rỗng nghĩa là App": App
  // và Feature giờ là hai form khác nhau, và appId là dữ liệu người dùng nhập
  // nên không có giá trị nào của nó đủ an toàn để làm cờ chọn form.
  const [creating, setCreating] = useState<
    { kind: 'app' } | { kind: 'feature'; appId: string } | null
  >(null);
  // Sửa/xóa dùng một state riêng, và mang theo cả OBJECT chứ không chỉ id:
  // hộp thoại cần tên hiện tại để prefill, còn hộp thoại xóa App cần số
  // feature để nói đúng "X tính năng sẽ bị xóa khỏi máy". Sau khi xóa, object trong
  // nav đã biến mất nên không tra lại được nữa.
  const [acting, setActing] = useState<
    | { kind: 'edit-app'; app: NavApp }
    | { kind: 'delete-app'; app: NavApp }
    | { kind: 'edit-feature'; feature: PipelineProject }
    | { kind: 'delete-feature'; feature: PipelineProject }
    | null
  >(null);

  // Hai nút, hai form RIÊNG và mỗi form chỉ hỏi thông tin của chính nó. Trước
  // đây cả hai dùng chung một hộp thoại nên bấm "App mới" lại thấy ô hỏi tên
  // Feature. App tạo xong tồn tại với 0 feature (xem nhánh "App rỗng vẫn phải
  // hiện" trong usePipelineNav.groupByApp), nên "App mới" không còn phải kèm
  // feature đầu tiên — vào màn Features rỗng bấm CTA là bước tiếp theo.
  const createModal =
    creating === null ? null : creating.kind === 'app' ? (
      <NewAppModal
        onClose={() => setCreating(null)}
        onCreated={async (appId) => {
          await nav.reload();
          navigate({ kind: 'pipelines-app', appId });
        }}
      />
    ) : (
      <NewFeatureModal
        {...(creating.appId !== UNASSIGNED_APP ? { initialAppId: creating.appId } : {})}
        onClose={() => setCreating(null)}
        onCreated={async (featureId) => {
          await nav.reload();
          navigate({ kind: 'pipelines-feature', appId: creating.appId, featureId });
        }}
      />
    );

  // Màn đang xem quyết định lùi về đâu sau khi xóa, nên nó được đọc ngay tại
  // đây thay vì truyền cờ xuống từng view.
  const closeActing = () => setActing(null);
  const actionModal =
    acting === null ? null : acting.kind === 'edit-app' ? (
      <EditAppModal
        app={{ id: acting.app.id, name: acting.app.name }}
        onClose={closeActing}
        onSaved={() => nav.reload()}
      />
    ) : acting.kind === 'edit-feature' ? (
      <EditFeatureModal feature={acting.feature} onClose={closeActing} onSaved={() => nav.reload()} />
    ) : acting.kind === 'delete-app' ? (
      (() => {
        const syncStatus = syncStatusByAppId.get(acting.app.id);
        const hasSharedCopy = Boolean(syncStatus?.mappingValid && syncStatus.origin?.visibility === 'visible');
        return (
          <ConfirmDeleteModal
            title={`Xóa dự án "${acting.app.name}" khỏi máy?`}
            body={appDeleteMessage(acting.app.features.length, hasSharedCopy)}
            warning={appDeleteWarning(acting.app.features.length, hasSharedCopy)}
            confirmLabel="Xóa khỏi máy"
            onClose={closeActing}
            onConfirm={async () => {
              const deletedAppName = acting.app.name;
              await deleteAppFromMachine(acting.app.id);
              await nav.reload();
              setSyncToast({
                message: hasSharedCopy
                  ? `Đã xóa dự án "${deletedAppName}" khỏi máy. Bản trong kho chung vẫn được giữ.`
                  : `Đã xóa dự án "${deletedAppName}" khỏi máy. Dự án này chưa có bản trong kho chung.`,
              });
              navigate({ kind: 'home', view: 'pipelines' });
            }}
          />
        );
      })()
    ) : (
      <ConfirmDeleteModal
        title={`Xóa tính năng "${acting.feature.name}"?`}
        body={
          'Xóa thư mục làm việc và trạng thái chạy trên máy này. ' +
          'Bản đã Push trên Pipeline Studio không bị ảnh hưởng.'
        }
        confirmLabel="Xóa tính năng"
        onClose={closeActing}
        onConfirm={async () => {
          await deleteFeature(acting.feature.id);
          await nav.reload();
          // Đang đứng trong màn Pipeline/Chạy của feature vừa xóa → về màn
          // Features của App cha. Hiện chưa với tới được: kebab chỉ có ở màn
          // Apps và màn Features, nên xóa xong vẫn đang ở màn Features. Giữ
          // nhánh này để khi kebab xuống tới màn 3 thì không ai phải nhớ ra
          // rằng URL đã trỏ vào một feature không còn tồn tại.
          if (
            (route.kind === 'pipelines-feature' || route.kind === 'pipelines-run') &&
            route.featureId === acting.feature.id
          ) {
            navigate({ kind: 'pipelines-app', appId: route.appId });
          }
        }}
      />
    );

  let page: JSX.Element;
  if (route.kind === 'pipelines-app') {
    page = <PipelinesFeaturesView
          nav={nav}
          appId={route.appId}
          onNewFeature={() => setCreating({ kind: 'feature', appId: route.appId })}
          syncStatusByFeatureId={syncStatusByFeatureId}
          syncReady={syncAccess?.syncReady === true}
          syncIssue={syncAccess?.syncIssue}
          onPullFeature={(feature) => setSyncDialog({
            scope: { kind: 'feature', projectId: feature.id, appId: feature.app?.id?.trim() || null },
            subjectName: feature.name,
          })}
          onPushFeature={(feature) => setShareDialog({
            initialFeatureIds: [feature.id],
            initialAppIds: feature.app?.id?.trim() ? [feature.app.id.trim()] : [],
            scopeName: 'Tính năng đã chọn',
            scope: { kind: 'feature', projectId: feature.id, appId: feature.app?.id?.trim() || null },
            subjectName: feature.name,
          })}
          onEditFeature={(feature) => setActing({ kind: 'edit-feature', feature })}
          onDeleteFeature={(feature) => setActing({ kind: 'delete-feature', feature })}
        />;
  } else if (route.kind === 'pipelines-feature') {
    page = <PipelinePickerView nav={nav} appId={route.appId} featureId={route.featureId} />;
  // Màn Chạy + route Quick result cũ (/pipelines/:projectId/result/:pipelineId)
  // đều do PipelinesView dựng — nó là nơi duy nhất giữ danh sách bước đã nạp.
  } else if (route.kind === 'pipelines-run' || route.kind === 'pipeline-result') {
    page = <PipelinesView />;
  } else {
    page = (
      <PipelinesAppsView
          nav={nav}
          onNewApp={() => setCreating({ kind: 'app' })}
          onEditApp={(app) => setActing({ kind: 'edit-app', app })}
          onDeleteApp={(app) => setActing({ kind: 'delete-app', app })}
          onReconnectSync={() => void reconnectSync()}
          syncReady={syncAccess?.syncReady === true}
          syncIssue={syncAccess?.syncIssue}
          syncStatusByAppId={syncStatusByAppId}
          onPullApp={(app) => setSyncDialog({
            scope: { kind: 'app', projectId: app.id },
            subjectName: app.name,
          })}
          onPushApp={(app) => setShareDialog({
            initialFeatureIds: [],
            initialAppIds: [app.id],
            scopeName: `Dự án ${app.name}`,
            scope: { kind: 'app', projectId: app.id },
            subjectName: app.name,
          })}
        />
    );
  }
  return (
    <>
      {page}
      {createModal}
      {actionModal}
      {syncDialog ? (
        <ProjectSyncPreviewModal
          scope={syncDialog.scope}
          subjectName={syncDialog.subjectName}
          onClose={() => setSyncDialog(null)}
          onApplied={() => {
            void nav.reload();
            setSyncStatusReloadTick((tick) => tick + 1);
            setSyncToast({ message: 'Đã áp dụng đồng bộ với kho chung. Danh sách bản trên máy đang được làm mới.' });
          }}
        />
      ) : null}
      {shareDialog ? (
        <PushAllModal
          projects={nav.projects.filter((project) => shareDialog.scope.kind === 'app'
            ? project.app?.id === shareDialog.scope.projectId
            : project.id === shareDialog.scope.projectId).map((project) => ({
            id: project.id,
            name: project.name,
            ...(project.app ? { app: project.app } : {}),
            appContextBinding: project.appContextBinding,
          }))}
          apps={nav.apps.filter((app) => !app.unassigned && (
            shareDialog.scope.kind === 'app'
              ? app.id === shareDialog.scope.projectId
              : app.id === shareDialog.scope.appId
          )).map((app) => ({
            id: app.id,
            name: app.name,
            context: app.context,
            features: app.features.filter((feature) => shareDialog.scope.kind === 'app'
              || feature.id === shareDialog.scope.projectId).map((feature) => ({
              id: feature.id,
              name: feature.name,
              boundVersion: feature.appContextBinding?.contextVersion ?? null,
            })),
          }))}
          workflows={shareWorkflows}
          scopeName={shareDialog.scopeName}
          initialSelectedIds={shareDialog.initialFeatureIds}
          initialAppIds={shareDialog.initialAppIds}
          destination={shareDestination}
          destinations={shareDestinations}
          newDestinationId={shareNewOriginId}
          defaultNewDestinationName={shareDialog.subjectName}
          onDestinationChange={setShareDestination}
          selectionLocked={shareDialog.scope.kind === 'feature'}
          syncReady={syncAccess?.syncReady === true}
          onReconnect={() => void reconnectSync()}
          onClose={() => setShareDialog(null)}
          onConfirm={shareSelectedResults}
        />
      ) : null}
      {syncToast ? (
        <Toast
          message={syncToast.message}
          details={syncToast.details}
          role={syncToast.error ? "alert" : "status"}
          onDismiss={() => setSyncToast(null)}
        />
      ) : null}
    </>
  );
}
