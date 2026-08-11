// @vitest-environment jsdom
//
// Row feature xổ ra: trạng thái TỪNG workflow của feature đó.
//
// Hai thứ được canh ở đây. Một là HTML: row CHÍNH NÓ là <button> điều hướng,
// nên nút xổ (như kebab) phải là phần tử ANH EM — lồng button trong button thì
// trình duyệt tự sửa markup và nút rơi ra ngoài row. Hai là badge tổng: trước
// đây nó chỉ đọc `running` của MỘT workflow (cái mặc định), nên feature đang
// chạy workflow khác vẫn báo "Chưa chạy".
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineProject } from '@open-design/contracts';

import { PipelinesFeaturesView } from '../../../src/components/pipelines/PipelinesFeaturesView';
import { groupByApp } from '../../../src/components/pipelines/usePipelineNav';

function navFor(projects: PipelineProject[]) {
  const apps = groupByApp(projects, []);
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

// Feature với workflow mặc định (docs-to-ui) chưa chạy gì, nhưng docs-review
// đang chạy dở — đúng trường hợp badge cũ đọc sai.
const RUNNING_ELSEWHERE: PipelineProject = {
  id: 'f1',
  name: 'Thanh toán',
  done: 0,
  total: 9,
  running: 0,
  app: { id: 'retail', name: 'Retail' },
  workflows: [
    { id: 'docs-to-ui', name: 'Docs → UI-Spec', done: 0, total: 9, running: 0 },
    { id: 'docs-to-prd', name: 'Docs → PRD Review', done: 4, total: 4, running: 0 },
    { id: 'docs-review', name: 'Docs → Review tài liệu', done: 1, total: 2, running: 1 },
  ],
};

const renderView = (projects: PipelineProject[]) =>
  render(<PipelinesFeaturesView nav={navFor(projects)} appId="retail" />);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ apps: [] }), { status: 200 })));
  window.history.pushState(null, '', '/pipelines');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('nút xổ trên row feature', () => {
  it('không lồng button trong button', () => {
    renderView([RUNNING_ELSEWHERE]);
    for (const b of Array.from(document.querySelectorAll('button'))) {
      expect(b.querySelector('button')).toBeNull();
    }
  });

  it('bấm nút xổ KHÔNG điều hướng, chỉ đảo aria-expanded', () => {
    renderView([RUNNING_ELSEWHERE]);
    const toggle = screen.getByLabelText('Trạng thái từng workflow của Thanh toán');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(window.location.pathname).toBe('/pipelines');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('liệt kê MỌI workflow kèm tiến độ và trạng thái riêng', () => {
    renderView([RUNNING_ELSEWHERE]);
    fireEvent.click(screen.getByLabelText('Trạng thái từng workflow của Thanh toán'));

    const panel = document.getElementById('pnv-wf-f1')!;
    const rows = Array.from(panel.querySelectorAll('button'));
    expect(rows.map((r) => r.textContent)).toEqual([
      'Docs → UI-Spec0/9Chưa chạy',
      'Docs → PRD Review4/4Xong',
      'Docs → Review tài liệu1/2Đang chạy',
    ]);
    // Workflow đang chạy có spinner; hai dòng còn lại không.
    expect(panel.querySelectorAll('.icon-spin')).toHaveLength(1);
  });

  it('dòng workflow điều hướng vào màn 3 của feature — nơi chọn workflow', () => {
    renderView([RUNNING_ELSEWHERE]);
    fireEvent.click(screen.getByLabelText('Trạng thái từng workflow của Thanh toán'));
    fireEvent.click(screen.getByRole('button', { name: /Docs → Review tài liệu/ }));
    expect(window.location.pathname).toBe('/pipelines/app/retail/f1');
  });

  it('không có nút xổ khi server chưa trả workflows', () => {
    const legacy: PipelineProject = { id: 'f2', name: 'Hoàn tiền', done: 0, total: 9, running: 0, app: { id: 'retail' } };
    renderView([legacy]);
    expect(screen.queryByLabelText('Trạng thái từng workflow của Hoàn tiền')).toBeNull();
  });
});

describe('badge tổng của row tính trên MỌI workflow', () => {
  // Chỉ lấy badge của CHÍNH row: nút xổ cũng mang tên feature trong aria-label,
  // còn các dòng trong phần xổ cũng có chip trạng thái riêng.
  const rowBadge = (name: string) =>
    screen
      .getByText(name)
      .closest('button')!
      .querySelector('[data-status]')!;

  it('"Đang chạy" khi workflow KHÁC workflow mặc định đang chạy', () => {
    renderView([RUNNING_ELSEWHERE]);
    expect(rowBadge('Thanh toán').textContent).toBe('Đang chạy');
    // Chip bộ lọc đọc cùng định nghĩa nên không thể nói khác badge.
    expect(screen.getByRole('button', { name: /^Đang chạy/ }).textContent).toContain('1');
  });

  it('nói ra số khi ≥2 workflow chạy song song', () => {
    renderView([
      {
        ...RUNNING_ELSEWHERE,
        workflows: [
          { id: 'docs-to-ui', name: 'Docs → UI-Spec', done: 2, total: 9, running: 1 },
          { id: 'docs-to-prd', name: 'Docs → PRD Review', done: 0, total: 4, running: 0 },
          { id: 'docs-review', name: 'Docs → Review tài liệu', done: 1, total: 2, running: 1 },
        ],
      },
    ]);
    expect(rowBadge('Thanh toán').textContent).toBe('Đang chạy · 2 wf');
  });

  it('"Đang chạy" thắng "Xong": workflow mặc định xong mà workflow khác còn chạy', () => {
    renderView([
      {
        ...RUNNING_ELSEWHERE,
        done: 9,
        workflows: [
          { id: 'docs-to-ui', name: 'Docs → UI-Spec', done: 9, total: 9, running: 0 },
          { id: 'docs-review', name: 'Docs → Review tài liệu', done: 0, total: 2, running: 1 },
        ],
      },
    ]);
    expect(rowBadge('Thanh toán').textContent).toBe('Đang chạy');
  });

  it('"Xong" giữ nguyên nghĩa cũ: workflow mặc định xong, không workflow nào chạy', () => {
    renderView([
      {
        ...RUNNING_ELSEWHERE,
        done: 9,
        workflows: [
          { id: 'docs-to-ui', name: 'Docs → UI-Spec', done: 9, total: 9, running: 0 },
          { id: 'docs-review', name: 'Docs → Review tài liệu', done: 0, total: 2, running: 0 },
        ],
      },
    ]);
    expect(rowBadge('Thanh toán').textContent).toBe('Xong');
  });

  it('"Chưa chạy" chỉ khi KHÔNG workflow nào nhúc nhích', () => {
    renderView([
      {
        ...RUNNING_ELSEWHERE,
        workflows: [
          { id: 'docs-to-ui', name: 'Docs → UI-Spec', done: 0, total: 9, running: 0 },
          { id: 'docs-review', name: 'Docs → Review tài liệu', done: 0, total: 2, running: 0 },
        ],
      },
    ]);
    expect(rowBadge('Thanh toán').textContent).toBe('Chưa chạy');
    expect(screen.getByRole('button', { name: /^Chưa chạy/ }).textContent).toContain('1');
  });
});
