// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSyncOperation, Workflow } from '@open-design/contracts';
import type { ContextTransferSelection } from '../../../src/components/pipelines/PipelineModals';

vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));

const { PullAllModal, PushAllModal } = await import('../../../src/components/pipelines/PipelineModals');

const workflows: Workflow[] = [{ id: 'docs-review', name: 'Review tài liệu', pipelineIds: ['docs'] }];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { results: [] } }), { status: 200 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PullAllModal · tiến độ và lỗi', () => {
  it('giữ danh sách trên màn hình và hiện progress bar khi endpoint cũ đang chạy', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/kg/remote-projects') {
        return new Response(JSON.stringify({ data: [{
          projectId: 'feature-remote', name: 'Feature Remote', displayName: 'Feature Remote',
          isApp: false, files: 2, availableOutputs: ['docs'], alreadyOnThisDevice: false,
        }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ apps: [] }), { status: 200 });
    }));
    let finish!: () => void;
    render(
      <PullAllModal
        localIds={new Set()}
        workflows={workflows}
        initialSelectedIds={['feature-remote']}
        syncReady
        onReconnect={() => {}}
        onClose={() => {}}
        onConfirm={() => new Promise<void>((resolve) => { finish = resolve; })}
      />,
    );

    expect(await screen.findByText('Feature Remote')).not.toBeNull();
    fireEvent.click(screen.getByTestId('pipeline-pull-confirm'));
    const progress = await screen.findByRole('progressbar');
    expect(progress.getAttribute('aria-valuenow')).toBeNull();
    expect(screen.getByText('Đang lấy dữ liệu từ kho chung…')).not.toBeNull();
    expect(screen.getByText('Feature Remote')).not.toBeNull();
    finish();
  });
});

describe('PushAllModal · App Context tree', () => {
  it('App chưa có Feature vẫn chia sẻ được Context và có progress bar', async () => {
    let finish!: () => void;
    const onConfirm = vi.fn((
      _selection: ContextTransferSelection,
      _stages: string[],
      _stagesByFeature: Record<string, string[]> | undefined,
      onProgress: ((operation: ProjectSyncOperation) => void) | undefined,
    ) => {
      onProgress?.({
        operationId: 'push-app', planId: 'plan-app', state: 'running', phase: 'transferring',
        progress: { completedItems: 1, totalItems: 2, percent: 50 }, createdAt: '', updatedAt: '', expiresAt: '',
      });
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    render(
      <PushAllModal
        projects={[]}
        apps={[{
          id: 'app-empty',
          name: 'App chưa có Feature',
          context: { currentVersion: 'v1', latestVersion: 'v1' },
          features: [],
        }]}
        workflows={workflows}
        initialAppIds={['app-empty']}
        syncReady
        onReconnect={() => {}}
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.queryByText('App chưa có Feature')).not.toBeNull();
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Thông tin tài liệu dùng chung của App chưa có Feature' }));
    expect(screen.queryByText('Tài liệu dùng chung của App chưa có Feature')).not.toBeNull();
    const share = screen.getByRole('button', { name: 'Chia sẻ dự án' }) as HTMLButtonElement;
    await waitFor(() => expect(share.disabled).toBe(false));
    fireEvent.click(share);
    const progress = await screen.findByRole('progressbar');
    expect(progress.getAttribute('aria-valuenow')).toBe('50');
    expect(screen.getByText('Đang chia sẻ · 1/2 mục (50%)')).not.toBeNull();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ appIds: ['app-empty'], projectIds: [] }),
      [],
      {},
      expect.any(Function),
    ));
    finish();
  });

  it('báo số file Confluence không cần tải lên khi kết quả push có manifested', async () => {
    let finish!: () => void;
    render(
      <PushAllModal
        projects={[]}
        apps={[{ id: 'app-wiki', name: 'App Wiki', features: [] }]}
        workflows={workflows}
        initialAppIds={['app-wiki']}
        syncReady
        onReconnect={() => {}}
        onClose={() => {}}
        onConfirm={(_selection, _stages, _stagesByFeature, onProgress) => {
          onProgress?.({
            operationId: 'push-wiki', planId: 'plan-wiki', state: 'succeeded', phase: 'finalizing',
            progress: { completedItems: 5, totalItems: 5, percent: 100 }, createdAt: '', updatedAt: '', expiresAt: '',
            result: { planId: 'plan-wiki', applied: 2, skipped: 0, unchanged: 0, softHiddenOriginFeatureIds: [], stale: [], manifested: 3 },
          });
          return new Promise<void>((resolve) => { finish = resolve; });
        }}
      />,
    );

    const share = screen.getByRole('button', { name: 'Chia sẻ dự án' }) as HTMLButtonElement;
    await waitFor(() => expect(share.disabled).toBe(false));
    fireEvent.click(share);
    expect((await screen.findByTestId('pipeline-push-manifested')).textContent)
      .toBe('3 file tài liệu Confluence không cần tải lên (máy pull sẽ lấy từ wiki)');
    finish();
  });

  it('hiện cảnh báo và mở lại thao tác khi Push bị timeout', async () => {
    render(
      <PushAllModal
        projects={[]}
        apps={[{ id: 'app-timeout', name: 'App Timeout', features: [] }]}
        workflows={workflows}
        initialAppIds={['app-timeout']}
        syncReady
        onReconnect={() => {}}
        onClose={() => {}}
        onConfirm={async () => {
          throw new Error('Thao tác đồng bộ mất quá nhiều thời gian. Vui lòng thử lại.');
        }}
      />,
    );

    const share = screen.getByRole('button', { name: 'Chia sẻ dự án' });
    await waitFor(() => expect((share as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(share);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('mất quá nhiều thời gian'));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Chia sẻ dự án' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('tree hiện binding cũ, cho xem diff và chỉ nâng Feature sau khi xác nhận', async () => {
    const onUpgrade = vi.fn(async () => undefined);
    render(
      <PushAllModal
        projects={[{ id: 'qr', name: 'Thanh toán QR', app: { id: 'pay', name: 'Thanh toán' }, appContextBinding: { contextVersion: 'v2' } }]}
        apps={[{
          id: 'pay',
          name: 'Thanh toán',
          context: {
            currentVersion: 'v3',
            latestVersion: 'v3',
            localDigest: 'sha256:context-v3',
            changedFiles: [
              { path: 'design-system/criteria/components.md', operation: 'edit' },
              { path: 'design-system/tokens/colors.json', operation: 'add' },
            ],
          },
          features: [{ id: 'qr', name: 'Thanh toán QR', boundVersion: 'v2' }],
        }]}
        workflows={workflows}
        initialSelectedIds={['qr']}
        syncReady
        onReconnect={() => {}}
        onClose={() => {}}
        onConfirm={async () => {}}
        onUpgradeFeatureContext={onUpgrade}
      />,
    );

    const featureName = screen.getAllByText('Thanh toán QR').find((node) => node.classList.contains('pl-pullall__name'));
    const featureRow = featureName?.closest('.pl-pullall__row');
    if (!featureRow) throw new Error('Không thấy hàng Feature');
    expect(within(featureRow as HTMLElement).queryByText('Đang dùng bộ tài liệu v2')).not.toBeNull();
    fireEvent.click(within(featureRow as HTMLElement).getByRole('button', { name: 'Xem thay đổi' }));
    expect(onUpgrade).not.toHaveBeenCalled();
    const review = screen.getByRole('dialog', { name: 'Xác nhận nâng Context cho Thanh toán QR' });
    expect(within(review).queryByText('Sửa: design-system/criteria/components.md')).not.toBeNull();
    expect(within(review).queryByText('Thêm: design-system/tokens/colors.json')).not.toBeNull();
    fireEvent.click(within(review).getByRole('button', { name: 'Xác nhận dùng v3' }));
    await waitFor(() => expect(onUpgrade).toHaveBeenCalledWith('qr', 'pay', 'v3', 'sha256:context-v3'));
    expect(within(featureRow as HTMLElement).queryByText('Đang dùng bộ tài liệu v3')).not.toBeNull();
  });

  it('luôn có ô tìm kiếm và lọc cây theo tên App hoặc Feature', () => {
    render(
      <PushAllModal
        projects={[
          { id: 'ke-toan-thue', name: 'Kế toán thuế', app: { id: 'ke-toan', name: 'Kế toán' } },
          { id: 'thanh-toan', name: 'Thanh toán', app: { id: 'thu-chi', name: 'Thu chi' } },
        ]}
        apps={[
          { id: 'ke-toan', name: 'Kế toán', features: [{ id: 'ke-toan-thue', name: 'Kế toán thuế' }] },
          { id: 'thu-chi', name: 'Thu chi', features: [{ id: 'thanh-toan', name: 'Thanh toán' }] },
        ]}
        workflows={workflows}
        syncReady
        onReconnect={() => {}}
        onClose={() => {}}
        onConfirm={async () => {}}
      />,
    );

    const search = screen.getByRole('searchbox', { name: 'Tìm dự án hoặc tính năng' });
    fireEvent.change(search, { target: { value: 'thuế' } });
    expect(screen.queryByText('Kế toán thuế')).not.toBeNull();
    expect(screen.queryByText('Thanh toán')).toBeNull();
    expect(screen.queryByText('Thu chi')).toBeNull();
  });

  it('chỉ hiện workflow đã có kết quả khi đã chọn Feature', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/kg/sync-status') {
        return new Response(JSON.stringify({ data: { results: [{
          projectId: 'feature-a',
          stages: [{ stage: 'docs', local: 1, remote: 0, changed: 0, localOnly: 1, remoteOnly: 0, differs: true }],
        }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { results: [] } }), { status: 200 });
    }));
    render(
      <PushAllModal
        projects={[{ id: 'feature-a', name: 'Tính năng A', app: { id: 'app-a', name: 'App A' } }]}
        apps={[{ id: 'app-a', name: 'App A', features: [{ id: 'feature-a', name: 'Tính năng A' }] }]}
        workflows={[
          { id: 'ran', name: 'Đã chạy', pipelineIds: ['docs'], stages: [{ id: 'docs', name: 'Tài liệu' }] },
          { id: 'not-run', name: 'Chưa chạy', pipelineIds: ['ux'], stages: [{ id: 'ux', name: 'Nghiên cứu UX' }] },
        ]}
        syncReady
        onReconnect={() => {}}
        onClose={() => {}}
        onConfirm={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Chọn Feature Tính năng A' }));
    await waitFor(() => expect(screen.queryByText('Đã chạy')).not.toBeNull());
    expect(screen.queryByText('Chưa chạy')).toBeNull();
  });

  it('tách Các bước cần đồng bộ theo từng Feature trong một App', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/kg/sync-status') {
        return new Response(JSON.stringify({ data: { results: [
          {
            projectId: 'feature-a',
            stages: [{ stage: 'docs', local: 1, remote: 0, changed: 0, localOnly: 1, remoteOnly: 0, differs: true }],
          },
          {
            projectId: 'feature-b',
            stages: [{ stage: 'ux', local: 1, remote: 0, changed: 0, localOnly: 1, remoteOnly: 0, differs: true }],
          },
        ] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { results: [] } }), { status: 200 });
    }));
    const onConfirm = vi.fn(async (
      _selection: ContextTransferSelection,
      _stages: string[],
      _stagesByFeature?: Record<string, string[]>,
    ) => undefined);
    render(
      <PushAllModal
        projects={[
          { id: 'feature-a', name: 'Tính năng A', app: { id: 'app-a', name: 'Dự án A' } },
          { id: 'feature-b', name: 'Tính năng B', app: { id: 'app-a', name: 'Dự án A' } },
        ]}
        apps={[{ id: 'app-a', name: 'Dự án A', features: [
          { id: 'feature-a', name: 'Tính năng A' },
          { id: 'feature-b', name: 'Tính năng B' },
        ] }]}
        workflows={[
          { id: 'docs', name: 'URD/PRD → UI-Spec', pipelineIds: ['docs'], stages: [{ id: 'docs', name: 'Tài liệu' }] },
          { id: 'ux', name: 'Nghiên cứu UX', pipelineIds: ['ux'], stages: [{ id: 'ux', name: 'UX Research' }] },
        ]}
        initialSelectedIds={['feature-a', 'feature-b']}
        initialAppIds={['app-a']}
        selectionLocked
        syncReady
        onReconnect={() => {}}
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );

    const stepsA = await screen.findByRole('region', { name: 'Các bước của Tính năng A' });
    const stepsB = screen.getByRole('region', { name: 'Các bước của Tính năng B' });
    expect(within(stepsA).queryByText('URD/PRD → UI-Spec')).not.toBeNull();
    expect(within(stepsA).queryByText('Nghiên cứu UX')).toBeNull();
    expect(within(stepsB).queryByText('Nghiên cứu UX')).toBeNull();
    expect(screen.getByRole('button', { name: 'Thu gọn các bước của Tính năng A' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Mở các bước của Tính năng B' }));
    expect(within(stepsB).queryByText('Nghiên cứu UX')).not.toBeNull();
    expect(within(stepsB).queryByText('URD/PRD → UI-Spec')).toBeNull();

    fireEvent.click(within(stepsA).getByRole('button', { name: /Tài liệu/ }));
    expect((screen.getByRole('button', { name: 'Chia sẻ 2 tính năng đã chọn' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(stepsA).getByRole('button', { name: /Tài liệu/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Chia sẻ 2 tính năng đã chọn' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0]?.[2]).toEqual({ 'feature-a': ['docs'], 'feature-b': ['ux'] });
  });

  it('cho chọn nhiều Feature thuộc App để chia sẻ', () => {
    render(
      <PushAllModal
        projects={[
          { id: 'a', name: 'Tính năng A', app: { id: 'app', name: 'App' } },
          { id: 'b', name: 'Tính năng B', app: { id: 'app', name: 'App' } },
        ]}
        apps={[{ id: 'app', name: 'App', features: [{ id: 'a', name: 'Tính năng A' }, { id: 'b', name: 'Tính năng B' }] }]}
        workflows={workflows}
        syncReady
        onReconnect={() => {}}
        onClose={() => {}}
        onConfirm={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Chọn Feature Tính năng A' }));
    expect(screen.getByText('Đã chọn 1 tính năng')).not.toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Chọn Feature Tính năng B' }));
    expect((screen.getByRole('checkbox', { name: 'Chọn Feature Tính năng A' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Chọn Feature Tính năng B' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Đã chọn 2 tính năng')).not.toBeNull();
  });
});

describe('PushAllModal · bước đang chạy', () => {
  const apps = [{
    id: 'app-run',
    name: 'App đang chạy',
    context: { currentVersion: 'v1', latestVersion: 'v1' },
    features: [
      { id: 'feat-running', name: 'Tính năng đang chạy', boundVersion: 'v1' },
      { id: 'feat-idle', name: 'Tính năng rảnh', boundVersion: 'v1' },
    ],
  }];

  it('feature đang chạy hiện chip Đang chạy và không tick được; feature rảnh vẫn chọn được', async () => {
    render(
      <PushAllModal
        projects={[]}
        apps={apps}
        workflows={workflows}
        initialAppIds={['app-run']}
        runningByFeatureId={{ 'feat-running': ['Đánh giá tài liệu'] }}
        syncReady
        onReconnect={() => {}}
        onClose={() => {}}
        onConfirm={async () => {}}
      />,
    );

    const runningBox = screen.getByRole('checkbox', { name: 'Chọn Feature Tính năng đang chạy' }) as HTMLInputElement;
    const idleBox = screen.getByRole('checkbox', { name: 'Chọn Feature Tính năng rảnh' }) as HTMLInputElement;
    expect(runningBox.disabled).toBe(true);
    expect(idleBox.disabled).toBe(false);
    const chip = screen.getByTestId('pipeline-push-running-feat-running');
    expect(chip.textContent).toBe('Đang chạy: Đánh giá tài liệu');
    expect(chip.getAttribute('title')).toBe('Đợi bước chạy xong rồi chia sẻ.');
    expect(screen.queryByTestId('pipeline-push-running-feat-idle')).toBeNull();
    // jsdom still flips `checked` on a disabled input; React skips onChange,
    // so the real signal is the selection counter staying at zero.
    fireEvent.click(runningBox);
    expect(screen.getByText('Chưa chọn tính năng')).not.toBeNull();
    fireEvent.click(idleBox);
    expect(idleBox.checked).toBe(true);
    expect(screen.getByText('Đã chọn 1 tính năng')).not.toBeNull();
  });

  it('mọi feature đã chọn đều đang chạy → nút xác nhận disabled + gợi ý đợi', async () => {
    const onConfirm = vi.fn(async () => {});
    render(
      <PushAllModal
        projects={[]}
        apps={apps}
        workflows={workflows}
        initialSelectedIds={['feat-running']}
        initialAppIds={['app-run']}
        selectionLocked
        runningByFeatureId={{ 'feat-running': ['Đánh giá tài liệu'] }}
        syncReady
        onReconnect={() => {}}
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );

    const confirm = screen.getByTestId('pipeline-push-confirm') as HTMLButtonElement;
    // Sync status has loaded by then (fetch stub) — the only reason left to
    // stay disabled is the running feature.
    await waitFor(() => expect(screen.getByTestId('pipeline-push-running-hint')).not.toBeNull());
    expect(confirm.disabled).toBe(true);
    expect(confirm.getAttribute('title')).toBe('Đợi bước chạy xong rồi chia sẻ.');
    expect(screen.getByTestId('pipeline-push-running-hint').textContent).toBe('Đợi bước chạy xong rồi chia sẻ.');
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('feature đang chạy lẫn trong lựa chọn bị loại khỏi phần gửi đi', async () => {
    const onConfirm = vi.fn(async (
      _selection: ContextTransferSelection,
      _stages: string[],
      _stagesByFeature?: Record<string, string[]>,
    ) => {});
    render(
      <PushAllModal
        projects={[]}
        apps={apps}
        workflows={workflows}
        initialSelectedIds={['feat-running', 'feat-idle']}
        initialAppIds={['app-run']}
        runningByFeatureId={{ 'feat-running': ['Đánh giá tài liệu'] }}
        syncReady
        onReconnect={() => {}}
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );

    const confirm = screen.getByTestId('pipeline-push-confirm') as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    expect(screen.getByTestId('pipeline-push-running-hint').textContent).toContain('Tính năng đang chạy');
    fireEvent.click(confirm);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    expect(onConfirm.mock.calls[0]?.[0]).toMatchObject({ appIds: ['app-run'], projectIds: ['feat-idle'] });
    expect(Object.keys(onConfirm.mock.calls[0]?.[2] ?? {})).toEqual(['feat-idle']);
  });
});

describe('runningLabelsByFeatureId', () => {
  it('ưu tiên tên bước; liệt kê workflow khi nhiều workflow cùng chạy; bỏ feature rảnh', async () => {
    const { runningLabelsByFeatureId } = await import('../../../src/components/pipelines/PipelineModals');
    expect(runningLabelsByFeatureId([
      { id: 'a', running: 1, runningStage: { id: 'dr-review', name: 'Đánh giá tài liệu' }, workflows: [{ id: 'docs-review', name: 'Review', running: 1 }] },
      { id: 'b', running: 1, runningStage: { id: 'docs', name: 'Tài liệu' }, workflows: [{ id: 'docs-review', name: 'Review', running: 1 }, { id: 'ds-lab', name: 'DS Lab', running: 2 }] },
      { id: 'c', running: 0, workflows: [{ id: 'docs-review', name: 'Review', running: 0 }, { id: 'ds-lab', name: 'DS Lab', running: 1 }] },
      { id: 'd', running: 1 },
      { id: 'e', running: 0 },
    ])).toEqual({
      a: ['Đánh giá tài liệu'],
      b: ['Review', 'DS Lab'],
      c: ['DS Lab'],
      d: ['bước hiện tại'],
    });
  });
});
