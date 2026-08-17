// Nguồn dữ liệu DUY NHẤT cho drill-down Pipelines (App → Feature → Pipeline).
//
// Ba màn đầu đều hỏi cùng một câu — "có những app nào, mỗi app có feature nào,
// mỗi feature tới đâu rồi" — nên chúng dùng chung một hook. Ba màn tự gọi API
// riêng là ba cách đếm tiến độ khác nhau, và người dùng sẽ thấy màn 1 nói 4/6
// còn màn 2 nói 3/6.
//
// Tiến độ ở cấp app/feature lấy theo PIPELINE MẶC ĐỊNH (server trả về khi
// không truyền workflowId). Tiến độ theo từng pipeline là câu hỏi của màn 3 và
// được hỏi riêng ở đó — hỏi sẵn cả ba pipeline cho mọi feature ngay từ màn 1 là
// N×3 lượt gọi cho dữ liệu hầu hết không ai nhìn.
//
// Riêng TRẠNG THÁI (đang chạy / xong / chưa chạy) thì cùng một lượt gọi đó đã
// trả kèm `PipelineProject.workflows` — tóm tắt done/total/running của TỪNG
// workflow — nên không phải fetch thêm gì: row feature xổ ra đọc thẳng mảng
// này, và badge tổng cũng tính trên nó (xem featureStatus bên dưới).

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PipelineApp, PipelineProject } from '@open-design/contracts';

import { UNASSIGNED_APP } from '../../router';
import type { AppContextSyncInfo } from './context-sync-tree';
import type { DocsReviewComponentSource } from '@open-design/contracts';

export interface NavApp {
  id: string;
  name: string;
  /** Design System gắn ở cấp App. */
  designSystemId?: string | null;
  figmaDesignSystemSourceId?: string | null;
  docsReviewComponentSource?: DocsReviewComponentSource;
  context?: AppContextSyncInfo | null;
  /** Rổ "Chưa gán app" — hiển thị khác, không có trang cấu hình app. */
  unassigned: boolean;
  features: PipelineProject[];
  /** Feature đã chạy xong toàn bộ pipeline mặc định. */
  doneFeatures: number;
  runningFeatures: number;
}

export interface PipelineNav {
  apps: NavApp[];
  projects: PipelineProject[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  reload: () => Promise<void>;
  appById: (appId: string) => NavApp | null;
  featureOf: (appId: string, featureId: string) => PipelineProject | null;
}

/** Feature "xong" = mọi bước của pipeline mặc định đã chạy xong. `total === 0`
 *  (pipeline chưa nạp được) KHÔNG tính là xong — nếu không, một feature trống
 *  sẽ hiện 100% ngay khi API lỗi. */
export function isFeatureDone(p: Pick<PipelineProject, 'done' | 'total'>): boolean {
  return p.total > 0 && p.done >= p.total;
}

/** Số workflow của feature đang chạy. `done/total/running` ở cấp feature chỉ
 *  nói về MỘT workflow (cái mặc định), nên một feature đang chạy workflow khác
 *  đọc thành "Chưa chạy" — đếm trên cả mảng `workflows` mới sửa đúng chỗ đó.
 *  Mảng vắng (server cũ) thì fallback về field cũ. */
export function runningWorkflows(p: Pick<PipelineProject, 'running' | 'workflows'>): number {
  if (p.workflows) return p.workflows.filter((w) => w.running > 0).length;
  return p.running > 0 ? 1 : 0;
}

/** "Chưa chạy" = KHÔNG workflow nào chạy dở hay xong được bước nào. */
export function isFeatureUntouched(
  p: Pick<PipelineProject, 'done' | 'running' | 'workflows'>,
): boolean {
  if (p.workflows) return p.workflows.every((w) => w.done === 0 && w.running === 0);
  return p.done === 0 && p.running === 0;
}

/** Trạng thái tổng của một feature — badge trên row và các chip bộ lọc đều đọc
 *  từ đây nên chúng không thể nói khác nhau.
 *
 *  "Đang chạy" xét trên MỌI workflow và đứng TRƯỚC "Xong": badge trả lời câu
 *  "đang có gì chạy không", nên một workflow đang chạy phải thắng việc workflow
 *  mặc định đã xong. Định nghĩa "Xong" thì giữ nguyên như cũ (isFeatureDone —
 *  theo workflow mặc định), không đòi mọi workflow phải xong. */
export function featureStatus(
  p: Pick<PipelineProject, 'done' | 'total' | 'running' | 'workflows'>,
): 'done' | 'running' | 'idle' {
  if (runningWorkflows(p) > 0) return 'running';
  if (isFeatureDone(p)) return 'done';
  return 'idle';
}

export function appIdOf(p: PipelineProject): string {
  return p.app?.id?.trim() || UNASSIGNED_APP;
}

/** Danh sách điều hướng chỉ phản ánh những Dự án đã có trên máy. Dự án chỉ
 * tồn tại trong kho chung thuộc modal "Lấy dự án về máy", không được trộn vào
 * màn local — nếu không một Dự án vừa xóa sẽ xuất hiện trở lại sau reload. */
export function localPipelineApps(apps: PipelineApp[]): PipelineApp[] {
  return apps.filter((app) => app.origin !== 'remote');
}

export function groupByApp(
  projects: PipelineProject[],
  knownApps: Array<{ id: string; name?: string; designSystemId?: string | null; figmaDesignSystemSourceId?: string | null; docsReviewComponentSource?: DocsReviewComponentSource; context?: AppContextSyncInfo | null }>,
): NavApp[] {
  const byId = new Map<string, NavApp>();
  const ensure = (id: string, name?: string, designSystemId?: string | null, context?: AppContextSyncInfo | null, docsReviewComponentSource?: DocsReviewComponentSource, figmaDesignSystemSourceId?: string | null): NavApp => {
    const hit = byId.get(id);
    if (hit) {
      // Tên đến sau từ danh sách app (feature chỉ mang bản sao có thể cũ).
      if (name && hit.name === hit.id) hit.name = name;
      if (designSystemId !== undefined) hit.designSystemId = designSystemId;
      if (docsReviewComponentSource !== undefined) hit.docsReviewComponentSource = docsReviewComponentSource;
      if (figmaDesignSystemSourceId !== undefined) hit.figmaDesignSystemSourceId = figmaDesignSystemSourceId;
      if (context !== undefined) hit.context = context;
      return hit;
    }
    const row: NavApp = {
      id,
      name: name || id,
      designSystemId,
      figmaDesignSystemSourceId,
      docsReviewComponentSource,
      context,
      unassigned: id === UNASSIGNED_APP,
      features: [],
      doneFeatures: 0,
      runningFeatures: 0,
    };
    byId.set(id, row);
    return row;
  };

  // App rỗng vẫn phải hiện: vừa tạo xong mà không thấy nó ở đâu là bế tắc.
  for (const a of knownApps) ensure(a.id, a.name, a.designSystemId, a.context, a.docsReviewComponentSource, a.figmaDesignSystemSourceId);

  for (const p of projects) {
    const row = ensure(appIdOf(p), p.app?.name);
    row.features.push(p);
    if (isFeatureDone(p)) row.doneFeatures += 1;
    if (p.running > 0) row.runningFeatures += 1;
  }

  for (const row of byId.values()) {
    row.features.sort((a, b) => a.name.localeCompare(b.name));
  }
  // Rổ "chưa gán app" luôn xuống cuối — nó là phần dư, không phải một sản phẩm.
  return [...byId.values()].sort((a, b) => {
    if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

export function usePipelineNav(): PipelineNav {
  const [projects, setProjects] = useState<PipelineProject[]>([]);
  const [knownApps, setKnownApps] = useState<Array<{ id: string; name?: string; designSystemId?: string | null; figmaDesignSystemSourceId?: string | null; docsReviewComponentSource?: DocsReviewComponentSource; context?: AppContextSyncInfo | null }>>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      // App list là phụ trợ (nó chỉ thêm app RỖNG vào lưới): nó hỏng thì vẫn
      // dựng được cây từ chính các feature, nên đừng để nó làm hỏng cả màn.
      const [projRes, appsRes] = await Promise.all([
        fetch('/api/pipelines/projects'),
        fetch('/api/pipelines/apps').catch(() => null),
      ]);
      const projJson = await projRes.json().catch(() => ({}));
      if (!projRes.ok) throw new Error(projJson?.error || `HTTP ${projRes.status}`);
      setProjects(Array.isArray(projJson?.projects) ? projJson.projects : []);
      if (appsRes?.ok) {
        const appsJson = await appsRes.json().catch(() => ({}));
        const apps = Array.isArray(appsJson?.apps) ? appsJson.apps as PipelineApp[] : [];
        setKnownApps(localPipelineApps(apps).map((app) => ({
          id: app.id,
          name: app.name,
          designSystemId: app.designSystemId,
          figmaDesignSystemSourceId: app.figmaDesignSystemSourceId,
          docsReviewComponentSource: app.docsReviewComponentSource,
          context: app.context ? {
            currentVersion: app.context.current?.contextVersion ?? app.context.latestVersion,
            latestVersion: app.context.latestVersion,
            localDigest: app.context.localCurrentDigest ?? app.context.current?.contentDigest,
            sharedDigest: app.context.latestDigest,
          } : null,
        })));
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    // Trạng thái chạy đổi NGOÀI các màn này (bấm Chạy ở màn 3/màn Chạy rồi
    // quay lại) — fetch một lần lúc mount là dữ liệu chết: badge "Đang chạy"
    // không bao giờ sáng. Poll nhẹ khi tab đang nhìn thấy; tab ẩn thì thôi,
    // quay lại là refetch ngay.
    const tick = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    const id = setInterval(tick, 10_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [reload]);

  const apps = useMemo(() => groupByApp(projects, knownApps), [projects, knownApps]);

  const appById = useCallback((appId: string) => apps.find((a) => a.id === appId) ?? null, [apps]);
  const featureOf = useCallback(
    (appId: string, featureId: string) =>
      apps.find((a) => a.id === appId)?.features.find((f) => f.id === featureId) ?? null,
    [apps],
  );

  return { apps, projects, loading, loaded, error, reload, appById, featureOf };
}
