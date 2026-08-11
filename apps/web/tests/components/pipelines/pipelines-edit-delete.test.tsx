// @vitest-environment jsdom
//
// Phase 2 của drill-down Pipelines: đổi tên / xóa App và Feature.
//
// Bẫy chính được canh ở đây là HTML: card App và row Feature CHÍNH NÓ là một
// <button> điều hướng, nên kebab "…" phải là phần tử ANH EM chứ không lồng vào
// trong — trình duyệt tự sửa markup button-trong-button và kebab sẽ rơi ra
// ngoài card. Còn lại là hợp đồng gửi lên server: PATCH chỉ mang trường người
// dùng thật sự đổi, ô App bỏ trống nghĩa là `appId: null` (gỡ khỏi App) chứ
// không phải "không đổi", và hộp thoại xóa phải GIỮ NGUYÊN khi server từ chối
// để người dùng đọc được lý do.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineProject } from '@open-design/contracts';

import { PipelinesAppsView } from '../../../src/components/pipelines/PipelinesAppsView';
import { PipelinesFeaturesView } from '../../../src/components/pipelines/PipelinesFeaturesView';
import { EditFeatureModal } from '../../../src/components/pipelines/EditFeatureModal';
import { EditAppModal } from '../../../src/components/pipelines/EditAppModal';
import { ConfirmDeleteModal } from '../../../src/components/pipelines/ConfirmDeleteModal';
import { appDeleteMessage, deleteAppFromMachine } from '../../../src/components/pipelines/PipelinesRoute';
import { groupByApp, localPipelineApps } from '../../../src/components/pipelines/usePipelineNav';

function feature(o: Partial<PipelineProject> & { id: string; name: string }): PipelineProject {
  return { done: 0, total: 3, running: 0, ...o };
}

function navFor(projects: PipelineProject[], knownApps: Array<{ id: string; name?: string }> = []) {
  const apps = groupByApp(projects, knownApps);
  return {
    apps,
    projects,
    loading: false,
    loaded: true,
    error: null,
    reload: async () => {},
    appById: (id: string) => apps.find((a) => a.id === id) ?? null,
    featureOf: (appId: string, fid: string) =>
      apps.find((a) => a.id === appId)?.features.find((f) => f.id === fid) ?? null,
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ apps: [] }), { status: 200 })));
  window.history.pushState(null, '', '/pipelines');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('kebab trên card App', () => {
  const projects = [
    feature({ id: 'f1', name: 'Thanh toán', app: { id: 'retail', name: 'Retail' } }),
    feature({ id: 'f2', name: 'Mồ côi' }),
  ];

  it('không lồng button trong button', () => {
    render(<PipelinesAppsView nav={navFor(projects)} onEditApp={() => {}} onDeleteApp={() => {}} />);
    for (const b of Array.from(document.querySelectorAll('button'))) {
      expect(b.querySelector('button')).toBeNull();
    }
  });

  it('không render kebab cho rổ "Chưa gán app"', () => {
    render(<PipelinesAppsView nav={navFor(projects)} onEditApp={() => {}} onDeleteApp={() => {}} />);
    expect(screen.queryByLabelText('Thao tác với Retail')).not.toBeNull();
    expect(screen.queryByLabelText('Thao tác với Chưa gán app')).toBeNull();
  });

  it('bấm kebab không điều hướng vào App, và chọn được Đổi tên / Xóa', () => {
    const onEditApp = vi.fn();
    const onDeleteApp = vi.fn();
    render(<PipelinesAppsView nav={navFor(projects)} onEditApp={onEditApp} onDeleteApp={onDeleteApp} />);

    fireEvent.click(screen.getByLabelText('Thao tác với Retail'));
    expect(window.location.pathname).toBe('/pipelines');

    fireEvent.click(screen.getByRole('menuitem', { name: 'Đổi tên' }));
    expect(onEditApp).toHaveBeenCalledOnce();
    expect(onEditApp.mock.calls[0]?.[0].id).toBe('retail');

    fireEvent.click(screen.getByLabelText('Thao tác với Retail'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Xóa khỏi máy' }));
    expect(onDeleteApp).toHaveBeenCalledOnce();
  });

  it('Escape đóng menu', () => {
    render(<PipelinesAppsView nav={navFor(projects)} onEditApp={() => {}} onDeleteApp={() => {}} />);
    fireEvent.click(screen.getByLabelText('Thao tác với Retail'));
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('click ngoài đóng menu', () => {
    render(<PipelinesAppsView nav={navFor(projects)} onEditApp={() => {}} onDeleteApp={() => {}} />);
    fireEvent.click(screen.getByLabelText('Thao tác với Retail'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('kebab trên row Feature', () => {
  const projects = [feature({ id: 'f1', name: 'Thanh toán', app: { id: 'retail', name: 'Retail' } })];

  it('row vẫn điều hướng, kebab thì không, và không có button lồng nhau', () => {
    const onEditFeature = vi.fn();
    render(
      <PipelinesFeaturesView
        nav={navFor(projects)}
        appId="retail"
        onEditFeature={onEditFeature}
        onDeleteFeature={() => {}}
      />,
    );
    for (const b of Array.from(document.querySelectorAll('button'))) {
      expect(b.querySelector('button')).toBeNull();
    }

    fireEvent.click(screen.getByLabelText('Thao tác với Thanh toán'));
    expect(window.location.pathname).toBe('/pipelines');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Đổi tên' }));
    expect(onEditFeature.mock.calls[0]?.[0].id).toBe('f1');
  });
});

describe('EditFeatureModal', () => {
  it('bỏ trống ô App gửi appId: null', async () => {
    const f = feature({ id: 'f1', name: 'Thanh toán', app: { id: 'retail', name: 'Retail' } });
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).startsWith('/api/pipelines/apps')
        ? new Response(JSON.stringify({ apps: [{ id: 'retail', name: 'Retail', origin: 'local' }] }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const onSaved = vi.fn();
    render(<EditFeatureModal feature={f} onClose={() => {}} onSaved={onSaved} />);

    const appInput = screen.getByLabelText('Thuộc dự án (tuỳ chọn)') as HTMLInputElement;
    expect(appInput.value).toBe('Retail');
    fireEvent.change(appInput, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const patch = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pipelines/projects/'));
    expect(patch?.[1]?.method).toBe('PATCH');
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ appId: null });
  });

  it('chỉ gửi tên khi chỉ đổi tên', async () => {
    const f = feature({ id: 'f1', name: 'Thanh toán', app: { id: 'retail', name: 'Retail' } });
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).startsWith('/api/pipelines/apps')
        ? new Response(JSON.stringify({ apps: [{ id: 'retail', name: 'Retail', origin: 'local' }] }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();
    render(<EditFeatureModal feature={f} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Tên tính năng'), { target: { value: 'Thanh toán QR' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const patch = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pipelines/projects/'));
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ name: 'Thanh toán QR' });
  });
});

describe('EditAppModal', () => {
  it('PATCH tên mới và hiện lỗi server', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url) === '/api/pipelines/apps'
        ? new Response(JSON.stringify({ apps: [] }), { status: 200 })
        : new Response(JSON.stringify({ error: 'tên đã dùng' }), { status: 400 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<EditAppModal app={{ id: 'retail', name: 'Retail' }} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText('Tên dự án'), { target: { value: 'Retail VN' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(screen.queryByText('tên đã dùng')).not.toBeNull());
    const patch = fetchMock.mock.calls.find((c) => c[1]?.method === 'PATCH');
    expect(patch?.[1]?.method).toBe('PATCH');
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ name: 'Retail VN' });
  });
});

describe('ConfirmDeleteModal', () => {
  it('giữ hộp thoại mở và hiện nguyên văn lỗi server', async () => {
    const onClose = vi.fn();
    render(
      <ConfirmDeleteModal
        title='Xóa dự án "Retail" khỏi máy?'
        body={appDeleteMessage(2)}
        confirmLabel="Xóa khỏi máy"
        onClose={onClose}
        onConfirm={async () => {
          throw new Error('Không thể xóa dữ liệu trên máy');
        }}
      />,
    );
    expect(screen.queryByText('2 tính năng và toàn bộ dữ liệu của dự án trên máy này sẽ bị xóa. Bản đã chia sẻ trong kho chung không bị ảnh hưởng. Bạn có thể lấy lại dự án sau.')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Xóa khỏi máy' }));
    await waitFor(() =>
      expect(screen.queryByText('Không thể xóa dữ liệu trên máy')).not.toBeNull(),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('thành công thì đóng', async () => {
    const onClose = vi.fn();
    render(
      <ConfirmDeleteModal
        title="Xóa Feature?"
        body="Xóa thư mục làm việc và trạng thái chạy trên máy này."
        confirmLabel="Xóa Feature"
        onClose={onClose}
        onConfirm={async () => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Xóa Feature' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe('xóa dự án local', () => {
  it('gọi đúng DELETE API và không gọi endpoint xóa trên kho chung', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await deleteAppFromMachine('retail/vn');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/pipelines/apps/retail%2Fvn', { method: 'DELETE' });
  });

  it('ẩn Dự án chỉ có trên kho chung khỏi danh sách local', () => {
    expect(localPipelineApps([
      { id: 'local-app', name: 'Trên máy', origin: 'local' },
      { id: 'remote-app', name: 'Kho chung', origin: 'remote' },
    ])).toEqual([{ id: 'local-app', name: 'Trên máy', origin: 'local' }]);
  });
});
