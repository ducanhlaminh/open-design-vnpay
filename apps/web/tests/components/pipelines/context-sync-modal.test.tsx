// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@open-design/contracts';
import type { ContextTransferSelection } from '../../../src/components/pipelines/PipelineModals';

vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));

const { PushAllModal } = await import('../../../src/components/pipelines/PipelineModals');

const workflows: Workflow[] = [{ id: 'docs-review', name: 'Review tài liệu', pipelineIds: ['docs'] }];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { results: [] } }), { status: 200 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PushAllModal · App Context tree', () => {
  it('App chưa có Feature chỉ là thư mục Context, không thể chia sẻ riêng', async () => {
    const onConfirm = vi.fn(async (_selection: ContextTransferSelection, _stages: string[]) => undefined);
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
        syncReady
        onReconnect={() => {}}
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.queryByText('App chưa có Feature')).not.toBeNull();
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Thông tin tài liệu dùng chung của App chưa có Feature' }));
    expect(screen.queryByText('Tài liệu dùng chung của App chưa có Feature')).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Chia sẻ' }) as HTMLButtonElement).disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
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

    const featureRow = screen.getByText('Thanh toán QR').closest('.pl-pullall__row');
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

    const search = screen.getByRole('searchbox', { name: 'Tìm App hoặc tính năng' });
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

  it('chỉ cho chọn một Feature để đối chiếu và chia sẻ', () => {
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
    expect((screen.getByRole('checkbox', { name: 'Chọn Feature Tính năng A' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Chọn Feature Tính năng B' }) as HTMLInputElement).checked).toBe(true);
  });
});
