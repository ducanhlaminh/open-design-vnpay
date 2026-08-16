// @vitest-environment jsdom
//
// Route wiring for the shared-results modal and Pull preview. These specs pin
// that cards retain the exact local scope and never hide local rows through a
// legacy remote read.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineProject, ProjectSyncScope } from '@open-design/contracts';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  reload: vi.fn(async () => undefined),
  appMapped: true,
  featureMapped: true,
  route: { kind: 'home', view: 'pipelines' as const } as { kind: 'home'; view: 'pipelines' } | { kind: 'pipelines-app'; appId: string },
}));

vi.mock('../../../src/router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/router')>()),
  navigate: mocks.navigate,
  useRoute: () => mocks.route,
}));

vi.mock('../../../src/components/project-sync', () => ({
  SyncStateBadge: ({ state }: { state: string }) => <span data-sync-state={state}>{state}</span>,
  ProjectSyncPreviewModal: ({ scope, subjectName, onClose, onApplied }: {
    scope: ProjectSyncScope;
    subjectName: string;
    onClose: () => void;
    onApplied?: () => void;
  }) => (
    <div role="dialog" aria-label={`Đồng bộ ${subjectName}`}>
      <output data-direction="pull" data-kind={scope.kind} data-project-id={scope.projectId} data-app-id={scope.appId ?? ''} />
      <button type="button" onClick={() => { onApplied?.(); onClose(); }}>Áp dụng</button>
    </div>
  ),
}));

vi.mock('../../../src/components/pipelines/PullSharedFeaturesModal', () => ({
  PullSharedFeaturesModal: ({
    localAppId,
    remoteAppOriginId,
    existingFeatureMappings,
    preselectedOriginIds,
    onCompleted,
  }: {
    localAppId: string;
    remoteAppOriginId: string;
    existingFeatureMappings?: ReadonlyMap<string, string>;
    preselectedOriginIds?: readonly string[];
    onCompleted: (result: unknown) => void;
  }) => (
    <div role="dialog" aria-label="Lấy tính năng từ kho chung">
      <output
        data-local-app-id={localAppId}
        data-remote-app-origin-id={remoteAppOriginId}
        data-existing-mapping={existingFeatureMappings?.get('checkout-cloud') ?? ''}
        data-preselected={(preselectedOriginIds ?? []).join(',')}
      />
      <button type="button" onClick={() => onCompleted({ succeeded: [], failed: [] })}>Hoàn tất lấy tính năng</button>
    </div>
  ),
}));

const features: PipelineProject[] = [
  { id: 'checkout', name: 'Thanh toán', done: 0, total: 3, running: 0, app: { id: 'retail', name: 'Retail' } },
];

vi.mock('../../../src/components/pipelines/usePipelineNav', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/components/pipelines/usePipelineNav')>()),
  usePipelineNav: () => ({
    apps: [{ id: 'retail', name: 'Retail', unassigned: false, features, doneFeatures: 0, runningFeatures: 0 }],
    projects: features,
    loading: false,
    loaded: true,
    error: null,
    reload: mocks.reload,
    appById: (id: string) => id === 'retail' ? { id: 'retail', name: 'Retail', unassigned: false, features, doneFeatures: 0, runningFeatures: 0 } : null,
    featureOf: () => null,
  }),
}));

const { PipelinesRoute } = await import('../../../src/components/pipelines/PipelinesRoute');

beforeEach(() => {
  mocks.route = { kind: 'home', view: 'pipelines' };
  mocks.navigate.mockReset();
  mocks.reload.mockClear();
  mocks.appMapped = true;
  mocks.featureMapped = true;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/auth/me') return new Response(JSON.stringify({ syncReady: true }), { status: 200 });
    if (url === '/api/workflows') return new Response(JSON.stringify({ workflows: [{ id: 'docs-to-ui', name: 'URD/PRD → UI-Spec', pipelineIds: ['docs'], stages: [{ id: 'docs', name: 'Tài liệu' }] }] }), { status: 200 });
    if (url.startsWith('/api/project-sync/origins')) return new Response(JSON.stringify({ data: { origins: [] } }), { status: 200 });
    if (url === '/api/project-sync/plan') return new Response(JSON.stringify({ data: {
      planId: 'plan-retail',
      createdAt: '2026-08-12T00:00:00.000Z',
      direction: 'push',
      scope: { kind: 'app', projectId: 'retail' },
      origin: { mode: 'existing', originId: 'retail-cloud' },
      features: [],
      entries: [],
      summary: { created: 0, unchanged: 0, changed: 1, deleted: 0 },
    } }), { status: 200 });
    if (url === '/api/project-sync/apply') return new Response(JSON.stringify({ data: {
      planId: 'plan-retail', applied: 1, skipped: 0, unchanged: 0, softHiddenOriginFeatureIds: [], stale: [],
    } }), { status: 200 });
    if (url === '/api/project-sync/status') return new Response(JSON.stringify({
      data: { results: [
        { scope: { kind: 'app', projectId: 'retail' }, state: mocks.appMapped ? 'changed' : 'new', mappingValid: mocks.appMapped, ...(mocks.appMapped ? { origin: { originId: 'retail-cloud', name: 'Retail', kind: 'app', visibility: 'visible', inKgs: true, inMedia: true } } : {}), features: [], summary: { created: mocks.appMapped ? 0 : 1, unchanged: 0, changed: mocks.appMapped ? 1 : 0, deleted: 0 }, entries: [] },
        { scope: { kind: 'feature', projectId: 'checkout', appId: 'retail' }, state: mocks.featureMapped ? 'changed' : 'new', mappingValid: mocks.featureMapped, ...(mocks.featureMapped ? { origin: { originId: 'checkout-cloud', name: 'Thanh toán', kind: 'feature', appId: 'retail-cloud', visibility: 'visible', inKgs: true, inMedia: true } } : {}), features: [], summary: { created: mocks.featureMapped ? 0 : 1, unchanged: 0, changed: mocks.featureMapped ? 1 : 0, deleted: 0 }, entries: [] },
      ] },
    }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PipelinesRoute · App/Feature origin sync', () => {
  it('App chia sẻ mở đúng modal Chia sẻ kết quả và làm mới navigation', async () => {
    render(<PipelinesRoute />);
    await screen.findByText('changed');
    const push = screen.getByLabelText('Chia sẻ kết quả của Dự án Retail');
    await waitFor(() => expect(push.hasAttribute('disabled')).toBe(false));
    fireEvent.click(push);
    const dialog = screen.getByRole('dialog', { name: 'Chia sẻ kết quả — Dự án Retail' });
    expect(dialog).not.toBeNull();
    expect((screen.getByLabelText('Chọn Feature Thanh toán') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText('Chọn Feature Thanh toán'));
    await waitFor(() => {
      expect((screen.getByLabelText('Chia sẻ vào') as HTMLSelectElement).value).toBe('existing:retail-cloud');
    });
    fireEvent.change(screen.getByLabelText('Chia sẻ vào'), { target: { value: 'new' } });
    fireEvent.change(screen.getByLabelText('Tên hiển thị mới trên kho chung'), { target: { value: 'Retail bản demo' } });

    fireEvent.click(screen.getByRole('button', { name: 'Chia sẻ tính năng đã chọn' }));
    await waitFor(() => expect(mocks.reload).toHaveBeenCalledOnce());
    const planCall = vi.mocked(globalThis.fetch).mock.calls.find(([url]) => String(url) === '/api/project-sync/plan');
    const planBody = JSON.parse(String((planCall?.[1] as RequestInit | undefined)?.body));
    expect(planBody.origin).toMatchObject({ mode: 'new', name: 'Retail bản demo' });
    expect(planBody.origin.originId).not.toBe('retail-cloud');
  });

  it('keeps the App action cluster visible and disables Pull without a shared copy', async () => {
    mocks.appMapped = false;
    render(<PipelinesRoute />);
    const more = await screen.findByLabelText('Thao tác với Retail');
    const pull = screen.getByLabelText('Lấy Dự án Retail từ kho chung');
    const push = screen.getByLabelText('Chia sẻ kết quả của Dự án Retail');
    expect(more.closest('[aria-label="Hành động với Retail"]')).not.toBeNull();
    expect(push.closest('[aria-label="Hành động với Retail"]')).not.toBeNull();
    expect(pull.hasAttribute('disabled')).toBe(true);
    expect(pull.getAttribute('title')).toBe('Dự án này chưa có bản trên kho chung');
  });

  it('Feature Pull opens the App-scoped batch picker with that remote Feature preselected', async () => {
    mocks.route = { kind: 'pipelines-app', appId: 'retail' };
    render(<PipelinesRoute />);
    const pull = await screen.findByLabelText('Lấy Tính năng Thanh toán từ kho chung');
    await waitFor(() => expect(pull.hasAttribute('disabled')).toBe(false));
    fireEvent.click(pull);
    const dialog = screen.getByRole('dialog', { name: 'Lấy tính năng từ kho chung' });
    expect(dialog.querySelector('output')?.dataset).toMatchObject({
      localAppId: 'retail',
      remoteAppOriginId: 'retail-cloud',
      existingMapping: 'checkout',
      preselected: 'checkout-cloud',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Hoàn tất lấy tính năng' }));
    expect(await screen.findByText('Đã lấy tính năng về máy. Danh sách bản trên máy đang được làm mới.')).not.toBeNull();
    expect(mocks.reload).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => String(url) === '/api/project-sync/status')).toHaveLength(2);
    });
  });

  it('header CTA opens the same batch picker without a preselection', async () => {
    mocks.route = { kind: 'pipelines-app', appId: 'retail' };
    render(<PipelinesRoute />);
    const pull = await screen.findByRole('button', { name: 'Lấy tính năng từ kho chung' });
    await waitFor(() => expect(pull.hasAttribute('disabled')).toBe(false));
    fireEvent.click(pull);
    const output = screen.getByRole('dialog', { name: 'Lấy tính năng từ kho chung' }).querySelector('output');
    expect(output?.dataset).toMatchObject({
      localAppId: 'retail', remoteAppOriginId: 'retail-cloud', preselected: '',
    });
  });

  it('disables Pull when the local Feature has no shared copy yet', async () => {
    mocks.featureMapped = false;
    mocks.route = { kind: 'pipelines-app', appId: 'retail' };
    render(<PipelinesRoute />);
    const pull = await screen.findByLabelText('Lấy Tính năng Thanh toán từ kho chung');
    expect(pull.hasAttribute('disabled')).toBe(true);
    expect(pull.getAttribute('title')).toBe('Tính năng này chưa có bản trên kho chung');
    expect(screen.getByText('Chỉ có trên máy · Đưa lên kho chung để tránh mất dữ liệu')).not.toBeNull();
  });

  it('loads status from the new engine and never hides local rows through the legacy endpoint', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<PipelinesRoute />);
    await screen.findByText('changed');
    expect(fetchMock).toHaveBeenCalledWith('/api/project-sync/status', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain('/api/kg/hidden-projects');
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/project-sync/status')).toHaveLength(1);
    expect(screen.getByText('Retail')).not.toBeNull();
  });
});
