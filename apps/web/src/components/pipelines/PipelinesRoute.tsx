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

import { useCallback, useEffect, useState } from 'react';
import type { AuthMeResponse, PipelineProject, Workflow, WorkflowsResponse } from '@open-design/contracts';

import { UNASSIGNED_APP, navigate, useRoute } from '../../router';
import { Toast } from '../Toast';
import { PipelinesView } from '../PipelinesView';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { EditAppModal } from './EditAppModal';
import { EditFeatureModal } from './EditFeatureModal';
import { NewAppModal } from './NewAppModal';
import { NewFeatureModal } from './NewFeatureModal';
import { PipelinesAppsView } from './PipelinesAppsView';
import { PipelinesFeaturesView } from './PipelinesFeaturesView';
import { PipelinePickerView } from './PipelinePickerView';
import { PullAllModal, PushAllModal, type ContextTransferSelection } from './PipelineModals';
import { SYNC_COPY } from './sync-copy';
import { bindFeatureContext, transferSelectedAppContexts } from './context-sync-api';
import { appIdOf, usePipelineNav } from './usePipelineNav';
import type { NavApp } from './usePipelineNav';

// Một App/Feature bị xóa thì màn đang xem nó không còn nghĩa gì — lùi lên một
// cấp thay vì để người dùng ngồi nhìn "Không tìm thấy app này".
export async function deleteAppFromMachine(appId: string): Promise<void> {
  const res = await fetch(`/api/pipelines/apps/${encodeURIComponent(appId)}`, { method: 'DELETE' });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || `Không thể xóa dự án khỏi máy: HTTP ${res.status}`);
}

export function appDeleteMessage(featureCount: number): string {
  const localScope = featureCount > 0
    ? `${featureCount} tính năng và toàn bộ dữ liệu của dự án trên máy này sẽ bị xóa. `
    : 'Dự án này không có tính năng trên máy. ';
  return `${localScope}Bản đã chia sẻ trong kho chung không bị ảnh hưởng. Bạn có thể lấy lại dự án sau.`;
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
  const [pullAllOpen, setPullAllOpen] = useState(false);
  const [pushAllOpen, setPushAllOpen] = useState(false);
  const [pullBusy, setPullBusy] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [syncAccess, setSyncAccess] = useState<Pick<AuthMeResponse, 'syncReady' | 'syncIssue'> | null>(null);
  const [syncToast, setSyncToast] = useState<{ message: string; details?: string; error?: boolean } | null>(null);

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
      .then(async (response) => response.ok ? (await response.json()) as WorkflowsResponse : null)
      .then((data) => setWorkflows(data?.workflows ?? []))
      .catch(() => setWorkflows([]));
  }, []);
  const reconnectSync = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.reload();
  }, []);
  const pullAll = useCallback(async (selection: ContextTransferSelection, stages: string[]) => {
    setPullBusy(true);
    try {
      const contextResults = await transferSelectedAppContexts('pull', selection);
      let data: Record<string, any> = { data: { results: [] } };
      if (selection.projectIds.length > 0) {
        const response = await fetch('/api/kg/pull-all', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectIds: selection.projectIds, stages }),
        });
        data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error || `pull-all failed: ${response.status}`);
      }
      await nav.reload();
      const results = Array.isArray(data?.data?.results) ? data.data.results : [];
      const fileCount = results.reduce((sum: number, result: { files?: unknown }) => sum + Number(result.files ?? 0), 0);
      setSyncToast({
        message: selection.projectIds.length > 0
          ? `${SYNC_COPY.downloadSuccess(results.length, fileCount)} · ${contextResults.length} bộ tài liệu chung`
          : `Đã lấy ${contextResults.length} bộ tài liệu chung về máy. Tính năng hiện tại chưa bị đổi phiên bản.`,
      });
      if (selection.projectIds.length === 1) {
        // reload updates the App screen; this read is only for immediate route
        // resolution, before React has committed that state update.
        const localResponse = await fetch('/api/pipelines/projects');
        const localData = await localResponse.json().catch(() => ({}));
        const localProjects = localResponse.ok && Array.isArray(localData?.projects)
          ? localData.projects as PipelineProject[]
          : [];
        const imported = localProjects.find((project) => project.id === selection.projectIds[0]);
        if (imported) navigate({ kind: 'pipelines-feature', appId: appIdOf(imported), featureId: imported.id });
      }
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      setSyncToast({ message: SYNC_COPY.downloadError, details, error: true });
      throw error;
    } finally {
      setPullBusy(false);
    }
  }, [nav]);
  const pushAll = useCallback(async (selection: ContextTransferSelection, stages: string[]) => {
    setPushBusy(true);
    try {
      const contextResults = await transferSelectedAppContexts('push', selection);
      let data: Record<string, any> = { data: { results: [] } };
      if (selection.projectIds.length > 0) {
        const response = await fetch('/api/kg/push-all', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectIds: selection.projectIds, stages }),
        });
        data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error || `push-all failed: ${response.status}`);
      }
      const results = Array.isArray(data?.data?.results) ? data.data.results : [];
      const fileCount = results.reduce((sum: number, result: { filesUploaded?: unknown }) => sum + Number(result.filesUploaded ?? 0), 0);
      setSyncToast({
        message: `Đã xử lý ${contextResults.length} bộ tài liệu chung và ${selection.projectIds.length} tính năng · ${fileCount} tệp`,
      });
      await nav.reload();
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      setSyncToast({ message: SYNC_COPY.shareError, details, error: true });
      throw error;
    } finally {
      setPushBusy(false);
    }
  }, [nav]);
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
      <ConfirmDeleteModal
        title={`Xóa dự án "${acting.app.name}" khỏi máy?`}
        body={appDeleteMessage(acting.app.features.length)}
        confirmLabel="Xóa khỏi máy"
        onClose={closeActing}
        onConfirm={async () => {
          const deletedAppName = acting.app.name;
          await deleteAppFromMachine(acting.app.id);
          await nav.reload();
          setSyncToast({
            message: `Đã xóa dự án "${deletedAppName}" khỏi máy. Bản trong kho chung vẫn được giữ.`,
          });
          navigate({ kind: 'home', view: 'pipelines' });
        }}
      />
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

  if (route.kind === 'pipelines-app') {
    return (
      <>
        <PipelinesFeaturesView
          nav={nav}
          appId={route.appId}
          onNewFeature={() => setCreating({ kind: 'feature', appId: route.appId })}
          onEditFeature={(feature) => setActing({ kind: 'edit-feature', feature })}
          onDeleteFeature={(feature) => setActing({ kind: 'delete-feature', feature })}
        />
        {createModal}
        {actionModal}
      </>
    );
  }
  if (route.kind === 'pipelines-feature') {
    return <PipelinePickerView nav={nav} appId={route.appId} featureId={route.featureId} />;
  }
  // Màn Chạy + route Quick result cũ (/pipelines/:projectId/result/:pipelineId)
  // đều do PipelinesView dựng — nó là nơi duy nhất giữ danh sách bước đã nạp.
  if (route.kind === 'pipelines-run' || route.kind === 'pipeline-result') {
    return <PipelinesView />;
  }
  return (
    <>
      <PipelinesAppsView
        nav={nav}
        onNewApp={() => setCreating({ kind: 'app' })}
        onEditApp={(app) => setActing({ kind: 'edit-app', app })}
        onDeleteApp={(app) => setActing({ kind: 'delete-app', app })}
        onPullAll={() => setPullAllOpen(true)}
        onPushAll={() => setPushAllOpen(true)}
        onReconnectSync={() => void reconnectSync()}
        syncReady={syncAccess?.syncReady === true}
        syncIssue={syncAccess?.syncIssue}
        pullBusy={pullBusy}
        pushBusy={pushBusy}
      />
      {pullAllOpen ? (
        <PullAllModal
          localIds={new Set(nav.projects.map((project) => project.id))}
          workflows={workflows}
          scopeName="Tất cả workflow"
          syncReady={syncAccess?.syncReady === true}
          onReconnect={() => void reconnectSync()}
          onClose={() => setPullAllOpen(false)}
          onConfirm={pullAll}
        />
      ) : null}
      {pushAllOpen ? (
        <PushAllModal
          projects={nav.projects.map((project) => ({
            id: project.id,
            name: project.name,
            ...(project.app ? { app: project.app } : {}),
            appContextBinding: project.appContextBinding,
          }))}
          apps={nav.apps.filter((app) => !app.unassigned).map((app) => ({
            id: app.id,
            name: app.name,
            context: app.context,
            features: app.features.map((feature) => ({
              id: feature.id,
              name: feature.name,
              boundVersion: feature.appContextBinding?.contextVersion,
            })),
          }))}
          workflows={workflows}
          scopeName="Tất cả workflow"
          syncReady={syncAccess?.syncReady === true}
          onReconnect={() => void reconnectSync()}
          onClose={() => setPushAllOpen(false)}
          onConfirm={pushAll}
          onUpgradeFeatureContext={async (featureId, appId, contextVersion, contentDigest) => {
            await bindFeatureContext({ featureId, appId, contextVersion, contentDigest });
            setSyncToast({ message: `Tính năng sẽ dùng bản tài liệu chung ${contextVersion} ở lần chạy tiếp theo.` });
            await nav.reload();
          }}
        />
      ) : null}
      {createModal}
      {actionModal}
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
