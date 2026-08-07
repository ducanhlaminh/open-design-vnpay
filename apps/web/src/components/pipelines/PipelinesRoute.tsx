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

import { useState } from 'react';
import type { PipelineProject } from '@open-design/contracts';

import { UNASSIGNED_APP, navigate, useRoute } from '../../router';
import { PipelinesView } from '../PipelinesView';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { EditAppModal } from './EditAppModal';
import { EditFeatureModal } from './EditFeatureModal';
import { NewAppModal } from './NewAppModal';
import { NewFeatureModal } from './NewFeatureModal';
import { PipelinesAppsView } from './PipelinesAppsView';
import { PipelinesFeaturesView } from './PipelinesFeaturesView';
import { PipelinePickerView } from './PipelinePickerView';
import { usePipelineNav } from './usePipelineNav';
import type { NavApp } from './usePipelineNav';

// Một App/Feature bị xóa thì màn đang xem nó không còn nghĩa gì — lùi lên một
// cấp thay vì để người dùng ngồi nhìn "Không tìm thấy app này".
async function deleteApp(appId: string): Promise<void> {
  const res = await fetch(`/api/pipelines/apps/${encodeURIComponent(appId)}`, { method: 'DELETE' });
  const j = await res.json().catch(() => ({}));
  // 409 = App thuộc Pipeline Studio (remote). Message của server nói rõ lý do
  // hơn bất cứ câu nào ta tự viết ở đây, nên hiện nguyên văn.
  if (!res.ok) throw new Error(j?.error || `xóa App thất bại: ${res.status}`);
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
  // Đang tạo gì. Dùng union chứ không dùng một chuỗi "rỗng nghĩa là App": App
  // và Feature giờ là hai form khác nhau, và appId là dữ liệu người dùng nhập
  // nên không có giá trị nào của nó đủ an toàn để làm cờ chọn form.
  const [creating, setCreating] = useState<
    { kind: 'app' } | { kind: 'feature'; appId: string } | null
  >(null);
  // Sửa/xóa dùng một state riêng, và mang theo cả OBJECT chứ không chỉ id:
  // hộp thoại cần tên hiện tại để prefill, còn hộp thoại xóa App cần số
  // feature để nói đúng "X feature sẽ chuyển về…". Sau khi xóa, object trong
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
        app={{
          id: acting.app.id,
          name: acting.app.name,
          confluenceRoots: acting.app.confluenceRoots,
          confluenceRoot: acting.app.confluenceRoot,
        }}
        onClose={closeActing}
        onSaved={() => nav.reload()}
      />
    ) : acting.kind === 'edit-feature' ? (
      <EditFeatureModal feature={acting.feature} onClose={closeActing} onSaved={() => nav.reload()} />
    ) : acting.kind === 'delete-app' ? (
      <ConfirmDeleteModal
        title={`Xóa App "${acting.app.name}"?`}
        body={
          (acting.app.features.length > 0
            ? `${acting.app.features.length} feature sẽ chuyển về "Chưa gán app". `
            : '') + 'Không xóa gì trên Pipeline Studio.'
        }
        confirmLabel="Xóa App"
        onClose={closeActing}
        onConfirm={async () => {
          await deleteApp(acting.app.id);
          await nav.reload();
          // Đang đứng trong màn Features của chính App vừa xóa → về màn Apps.
          if (route.kind === 'pipelines-app' && route.appId === acting.app.id) {
            navigate({ kind: 'home', view: 'pipelines' });
          }
        }}
      />
    ) : (
      <ConfirmDeleteModal
        title={`Xóa Feature "${acting.feature.name}"?`}
        body={
          'Xóa thư mục làm việc và trạng thái chạy trên máy này. ' +
          'Bản đã Push trên Pipeline Studio không bị ảnh hưởng.'
        }
        confirmLabel="Xóa Feature"
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
      />
      {createModal}
      {actionModal}
    </>
  );
}
