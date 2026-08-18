// @vitest-environment jsdom
//
// Màn 1 (Apps) sau khi thiết kế lại: card có monogram + chip đang-chạy, ô tìm luôn
// hiện, và lưới được phân trang 12 card/trang.
//
// Hai lớp được canh riêng. `pageItems` là số học thuần — dải nút phải rút gọn
// đúng chỗ và không bao giờ trả ra trang ngoài [1, total], nên nó được test
// KHÔNG cần dựng DOM. Phần render thì canh đúng ba chỗ dễ vỡ: trang chỉ hiện
// đúng lát cắt của nó, gõ tìm kiếm phải kéo về trang 1 (nếu không, kết quả
// mới rơi vào trang cũ và người dùng thấy lưới trống), và ≤1 trang thì không
// có thanh phân trang.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineProject } from '@open-design/contracts';

import {
  APPS_PAGE_SIZE,
  PipelinesAppsView,
  monogramOf,
  pageItems,
} from '../../../src/components/pipelines/PipelinesAppsView';
import { groupByApp } from '../../../src/components/pipelines/usePipelineNav';

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

/** N app, mỗi app một feature. Tên đánh số 2 chữ số ("App 01") để thứ tự
 *  localeCompare của groupByApp trùng với thứ tự sinh ra. */
function appsOf(n: number): PipelineProject[] {
  return Array.from({ length: n }, (_, i) => {
    const label = String(i + 1).padStart(2, '0');
    return {
      id: `f${label}`,
      name: `Feature ${label}`,
      done: 0,
      total: 3,
      running: 0,
      app: { id: `app-${label}`, name: `App ${label}` },
    } satisfies PipelineProject;
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ apps: [] }), { status: 200 })));
  window.history.pushState(null, '', '/pipelines');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('pageItems', () => {
  it('một trang → đúng một nút', () => {
    expect(pageItems(1, 1)).toEqual([1]);
  });

  it('total 0 (chưa có gì để phân) → dải rỗng', () => {
    expect(pageItems(1, 0)).toEqual([]);
  });

  it('7 trang → hiện đủ, không rút gọn', () => {
    expect(pageItems(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('12 trang, đứng giữa → gap cả hai phía', () => {
    expect(pageItems(6, 12)).toEqual([1, 'gap', 5, 6, 7, 'gap', 12]);
  });

  it('12 trang, đầu dải → chỉ gap bên phải', () => {
    expect(pageItems(1, 12)).toEqual([1, 2, 3, 4, 5, 'gap', 12]);
  });

  it('12 trang, cuối dải → chỉ gap bên trái', () => {
    expect(pageItems(12, 12)).toEqual([1, 'gap', 8, 9, 10, 11, 12]);
  });

  it('dải không bao giờ dài quá 7 ô', () => {
    for (let cur = 1; cur <= 40; cur += 1) expect(pageItems(cur, 40).length).toBeLessThanOrEqual(7);
  });

  it('trang ngoài biên bị kẹp lại chứ không sinh số lạ', () => {
    expect(pageItems(99, 12)).toEqual(pageItems(12, 12));
    expect(pageItems(0, 12)).toEqual(pageItems(1, 12));
  });
});

describe('monogramOf', () => {
  it('lấy 2 ký tự chữ/số đầu, bỏ khoảng trắng và dấu', () => {
    expect(monogramOf('Retail')).toBe('RE');
    expect(monogramOf('Retail – VN')).toBe('RE');
    expect(monogramOf('- 4b')).toBe('4B');
    expect(monogramOf('')).toBe('');
  });
});

describe('phân trang lưới App', () => {
  it(`13 app → trang 1 hiện ${APPS_PAGE_SIZE} card + thanh phân trang; "Sau" ra card thứ 13`, () => {
    render(<PipelinesAppsView nav={navFor(appsOf(13))} />);

    expect(screen.getAllByText(/^App \d\d$/)).toHaveLength(APPS_PAGE_SIZE);
    expect(screen.queryByText('App 01')).not.toBeNull();
    expect(screen.queryByText('App 13')).toBeNull();
    expect(screen.queryByLabelText('Phân trang')).not.toBeNull();
    expect(screen.queryByText('1–12 trong 13 dự án')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Sau/ }));
    expect(screen.queryByText('App 13')).not.toBeNull();
    expect(screen.queryByText('App 01')).toBeNull();
    expect(screen.getByLabelText('Trang 2').getAttribute('aria-current')).toBe('page');
  });

  it('nút Trước/Sau bị khóa ở hai biên', () => {
    render(<PipelinesAppsView nav={navFor(appsOf(13))} />);
    expect((screen.getByRole('button', { name: /Trước/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Sau/ }));
    expect((screen.getByRole('button', { name: /Sau/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Trước/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it(`≤${APPS_PAGE_SIZE} app → không có thanh phân trang`, () => {
    render(<PipelinesAppsView nav={navFor(appsOf(APPS_PAGE_SIZE))} />);
    expect(screen.getAllByText(/^App \d\d$/)).toHaveLength(APPS_PAGE_SIZE);
    expect(screen.queryByLabelText('Phân trang')).toBeNull();
  });

  it('gõ tìm kiếm kéo về trang 1', () => {
    render(<PipelinesAppsView nav={navFor(appsOf(30))} />);
    fireEvent.click(screen.getByLabelText('Trang 3'));
    expect(screen.queryByText('App 25')).not.toBeNull();

    fireEvent.change(screen.getByLabelText('Tìm dự án'), { target: { value: 'App 0' } });
    // 9 kết quả (App 01..09) → gọn trong một trang, và không còn pager.
    expect(screen.getAllByText(/^App \d\d$/)).toHaveLength(9);
    expect(screen.queryByLabelText('Phân trang')).toBeNull();
    expect(screen.queryByText('9 dự án')).not.toBeNull();
  });

  it('danh sách co lại dưới trang đang đứng → kẹp về trang cuối, không để lưới trống', () => {
    const { rerender } = render(<PipelinesAppsView nav={navFor(appsOf(30))} />);
    fireEvent.click(screen.getByLabelText('Trang 3'));
    expect(screen.queryByText('App 25')).not.toBeNull();

    // Xóa bớt app ngoài màn này (kebab → Xóa, hoặc poll của usePipelineNav)
    // làm tổng trang co từ 3 xuống 2 trong khi state trang vẫn là 3.
    rerender(<PipelinesAppsView nav={navFor(appsOf(13))} />);
    expect(screen.queryByText('App 13')).not.toBeNull();
    expect(screen.getByLabelText('Trang 2').getAttribute('aria-current')).toBe('page');
    expect((screen.getByRole('button', { name: /Sau/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('lọc mà vẫn còn nhiều trang thì cũng bắt đầu lại từ trang 1', () => {
    render(<PipelinesAppsView nav={navFor(appsOf(30))} />);
    fireEvent.click(screen.getByLabelText('Trang 3'));
    // Query khớp cả 30 app: pager vẫn còn, nên đây kiểm đúng việc "về trang 1"
    // chứ không phải việc pager biến mất.
    fireEvent.change(screen.getByLabelText('Tìm dự án'), { target: { value: 'app' } });
    expect(screen.getByLabelText('Trang 1').getAttribute('aria-current')).toBe('page');
    expect(screen.queryByText('App 01')).not.toBeNull();
  });
});

describe('toolbar', () => {
  it('ô tìm hiện cả khi ít app (trước đây chỉ >8 mới hiện)', () => {
    render(<PipelinesAppsView nav={navFor(appsOf(2))} />);
    expect(screen.queryByLabelText('Tìm dự án')).not.toBeNull();
    expect(screen.queryByText('2 dự án')).not.toBeNull();
  });

  it('không khớp gì thì báo rõ thay vì lưới trống', () => {
    render(<PipelinesAppsView nav={navFor(appsOf(2))} />);
    fireEvent.change(screen.getByLabelText('Tìm dự án'), { target: { value: 'zzz' } });
    expect(screen.queryByText('0 dự án')).not.toBeNull();
    expect(screen.queryByText(/Không có dự án nào khớp/)).not.toBeNull();
  });

  it('lưới trống hoàn toàn thì vẫn là hero empty-state, không phải toolbar', () => {
    render(<PipelinesAppsView nav={navFor([])} />);
    expect(screen.queryByLabelText('Tìm dự án')).toBeNull();
    expect(screen.queryByText('Chưa có dự án nào trên máy này')).not.toBeNull();
  });

  it('lưới trống vẫn có điểm vào lấy dự án đã chia sẻ về máy', () => {
    const onPullAll = vi.fn();
    render(<PipelinesAppsView nav={navFor([])} onPullAll={onPullAll} syncReady />);

    fireEvent.click(screen.getByRole('button', { name: 'Lấy dự án về máy' }));
    expect(onPullAll).toHaveBeenCalledOnce();
    expect(screen.queryByText('Chưa có dự án nào trên máy này')).not.toBeNull();
  });

  it('khóa lấy dự án khi chưa kết nối kho và cho kết nối lại ngay tại trang App', () => {
    const reconnect = vi.fn();
    render(<PipelinesAppsView nav={navFor([])} onPullAll={() => {}} onReconnectSync={reconnect} syncReady={false} />);

    expect((screen.getByRole('button', { name: 'Lấy dự án về máy' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('Kết nối lại');
    fireEvent.click(screen.getByRole('button', { name: 'Kết nối lại' }));
    expect(reconnect).toHaveBeenCalledOnce();
  });
});

describe('card App', () => {
  const projects: PipelineProject[] = [
    { id: 'f1', name: 'A', done: 3, total: 3, running: 0, app: { id: 'retail', name: 'Retail' } },
    { id: 'f2', name: 'B', done: 1, total: 3, running: 1, app: { id: 'retail', name: 'Retail' } },
    { id: 'f3', name: 'C', done: 0, total: 3, running: 0, app: { id: 'retail', name: 'Retail' } },
    { id: 'f4', name: 'Mồ côi', done: 0, total: 3, running: 0 },
  ];

  it('hiện monogram + meta + chip "đang chạy" (không còn nhãn %)', () => {
    render(<PipelinesAppsView nav={navFor(projects)} />);
    expect(screen.queryByText('RE')).not.toBeNull();
    expect(screen.queryByText('3 tính năng · 1 xong')).not.toBeNull();
    // % đã bỏ theo yêu cầu — con số nói được điều gì đang DIỄN RA là số
    // feature đang chạy.
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.queryByText('1 đang chạy')).not.toBeNull();
  });

  it('không feature nào chạy thì không render chip "đang chạy"', () => {
    const idle = projects.map((p) => ({ ...p, running: 0 }));
    render(<PipelinesAppsView nav={navFor(idle)} />);
    expect(screen.queryByText(/đang chạy/)).toBeNull();
  });

  it('app rỗng (0 feature) không có thanh tiến độ lẫn nhãn %', () => {
    render(<PipelinesAppsView nav={navFor([], [{ id: 'empty', name: 'Trống' }])} />);
    expect(screen.queryByText('0 tính năng · 0 xong')).not.toBeNull();
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('card vẫn không lồng button, và kebab vẫn ngoài card', () => {
    render(<PipelinesAppsView nav={navFor(projects)} onEditApp={() => {}} onDeleteApp={() => {}} />);
    for (const b of Array.from(document.querySelectorAll('button'))) {
      expect(b.querySelector('button')).toBeNull();
    }
    expect(screen.queryByLabelText('Thao tác với Retail')).not.toBeNull();
    expect(screen.queryByLabelText('Thao tác với Chưa gán app')).toBeNull();
  });
});

// Cảnh báo "Phiên đăng nhập đã hết hạn" chỉ được hiện SAU KHI /api/auth/me đã
// trả lời. Trước đó (syncChecked=false) trang đang tải — nút đồng bộ tắt, nhưng
// không được nháy alert đòi đăng nhập lại (bug báo 2026-08-18 trên /pipelines).
describe('PipelinesAppsView sync alert timing', () => {
  it('does not show the re-login alert while the sync check is still pending', () => {
    render(
      <PipelinesAppsView
        nav={navFor(appsOf(2))}
        onNewApp={() => {}}
        onPullAll={() => {}}
        syncReady={false}
        syncChecked={false}
      />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    const pull = screen.getByRole('button', { name: /Lấy dự án|Lấy về/ }) as HTMLButtonElement;
    expect(pull.disabled).toBe(true);
    expect(pull.title).toContain('Đang kiểm tra');
  });

  it('shows the alert once the check answered "not ready"', () => {
    render(
      <PipelinesAppsView
        nav={navFor(appsOf(2))}
        onNewApp={() => {}}
        onPullAll={() => {}}
        onReconnectSync={() => {}}
        syncReady={false}
        syncChecked={true}
        syncIssue={null}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Phiên đăng nhập đã hết hạn');
  });

  it('shows nothing when ready', () => {
    render(
      <PipelinesAppsView nav={navFor(appsOf(2))} onNewApp={() => {}} onPullAll={() => {}} syncReady={true} syncChecked={true} />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
