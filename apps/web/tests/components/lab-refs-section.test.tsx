// @vitest-environment jsdom
//
// WP-lab-refs-v2 (web): rail "Concept tham khảo" phải cho user THẤY và TIN
// được kết quả verify — sự cố 24/08 là 40/40 ảnh lỗi + warnings không lưu
// nên mở lại modal thấy lưới trống trơn, user kết luận nhầm "không detect
// được frame". Bốn hành vi cần khoá lại bằng test đỏ-trước:
//   1. Badge kind/size trên mỗi dòng page-list (page vs frame/section/…).
//   2. Warnings ĐÃ LƯU (refs.warnings) hiện ngay sau GET, không cần bấm quét.
//   3. Dòng cảnh báo "N concept chưa có ảnh" xuất hiện đúng lúc, ẩn khi đủ ảnh.
//   4. refs.json cũ (không có field mới) vẫn parse/render được, không crash.
// Tách file riêng khỏi lab-refs-config.test.tsx (đã có từ WP-lab-refs-web đợt
// 1) theo đúng phạm vi touches của WP này — không sửa file test cũ.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LabRefsSection } from '../../src/components/pipelines/LabRefsSection';

vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const EMPTY_REFS = { schemaVersion: 1, pages: [], concepts: [] };

function stubFetch(state: {
  getResponse?: unknown;
  getStatus?: number;
  putResponse?: unknown;
  putStatus?: number;
}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (method === 'GET') {
      return new Response(JSON.stringify(state.getResponse ?? EMPTY_REFS), { status: state.getStatus ?? 200 });
    }
    if (method === 'PUT') {
      return new Response(JSON.stringify(state.putResponse ?? { refs: EMPTY_REFS, warnings: [] }), {
        status: state.putStatus ?? 200,
      });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

describe('LabRefsSection — hint mới', () => {
  it('placeholder + hint đúng chữ theo spec v2 (frame của màn là luồng chính, page/section vẫn được)', async () => {
    stubFetch({ getResponse: EMPTY_REFS });
    render(<LabRefsSection projectId="proj-1" />);

    const expected = 'Dán link frame của màn (Copy link to selection) — mỗi dòng một màn; link page/section cũng được. Tối đa 10.';
    await screen.findByPlaceholderText(expected);
    expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
  });
});

describe('LabRefsSection — badge kind/size', () => {
  it('kind=page → badge "Page", không có size', async () => {
    stubFetch({
      getResponse: {
        schemaVersion: 1,
        pages: [{ url: 'https://www.figma.com/design/ABC/X?node-id=1-1', fileKey: 'ABC', nodeId: '1:1', name: 'Trang concept', ok: true, kind: 'page' }],
        concepts: [],
      },
    });
    render(<LabRefsSection projectId="proj-1" />);

    await screen.findByText('Trang concept');
    expect(screen.getByText('Page')).toBeTruthy();
  });

  it('kind=frame + size → badge "Frame · 390×1359"', async () => {
    stubFetch({
      getResponse: {
        schemaVersion: 1,
        pages: [{ url: 'https://www.figma.com/design/ABC/X?node-id=2-2', fileKey: 'ABC', nodeId: '2:2', name: 'Màn đăng nhập', ok: true, kind: 'frame', size: '390x1359' }],
        concepts: [],
      },
    });
    render(<LabRefsSection projectId="proj-1" />);

    await screen.findByText('Màn đăng nhập');
    expect(screen.getByText('Frame · 390×1359')).toBeTruthy();
  });

  it('kind=section không có size → badge "Section" (không có dấu ·)', async () => {
    stubFetch({
      getResponse: {
        schemaVersion: 1,
        pages: [{ url: 'https://www.figma.com/design/ABC/X?node-id=3-3', fileKey: 'ABC', nodeId: '3:3', name: 'Khối section', ok: true, kind: 'section' }],
        concepts: [],
      },
    });
    render(<LabRefsSection projectId="proj-1" />);

    await screen.findByText('Khối section');
    expect(screen.getByText('Section')).toBeTruthy();
  });

  it('refs cũ không có field kind → không hiện badge, không crash', async () => {
    stubFetch({
      getResponse: {
        schemaVersion: 1,
        pages: [{ url: 'https://www.figma.com/design/ABC/X?node-id=4-4', fileKey: 'ABC', nodeId: '4:4', name: 'Page cũ', ok: true }],
        concepts: [{ id: 'c1', fileKey: 'ABC', nodeId: '5:5', name: 'Concept cũ', png: 'ds-lab/refs/c1.png' }],
      },
    });
    render(<LabRefsSection projectId="proj-1" />);

    await screen.findByText('Page cũ');
    expect(screen.getByText('Concept cũ')).toBeTruthy();
    expect(screen.queryByText('Page')).toBeNull();
    expect(screen.queryByText('Frame')).toBeNull();
  });
});

describe('LabRefsSection — warnings đã lưu (persist)', () => {
  it('refs.warnings từ GET hiện ngay, không cần bấm "Quét & lưu"', async () => {
    stubFetch({
      getResponse: {
        schemaVersion: 1,
        pages: [],
        concepts: [],
        warnings: ['40 concept lỗi ảnh do Figma nhất thời — bấm Quét & lưu để thử lại.'],
      },
    });
    render(<LabRefsSection projectId="proj-1" />);

    await screen.findByText('40 concept lỗi ảnh do Figma nhất thời — bấm Quét & lưu để thử lại.');
  });

  it('merge warnings đã lưu + warnings của lượt PUT vừa chạy, dedupe chuỗi trùng', async () => {
    const { calls } = stubFetch({
      getResponse: { schemaVersion: 1, pages: [], concepts: [], warnings: ['Cảnh báo cũ đã lưu.'] },
      putResponse: {
        refs: { schemaVersion: 1, pages: [], concepts: [], warnings: ['Cảnh báo cũ đã lưu.', 'Cảnh báo mới từ PUT.'] },
        warnings: ['Cảnh báo cũ đã lưu.', 'Cảnh báo mới từ PUT.'],
      },
    });
    render(<LabRefsSection projectId="proj-1" />);

    await screen.findByText('Cảnh báo cũ đã lưu.');
    const textarea = await screen.findByPlaceholderText(/Dán link frame của màn/);
    fireEvent.change(textarea, { target: { value: 'https://www.figma.com/design/ABC/X?node-id=1-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Quét & lưu/ }));

    await screen.findByText('Cảnh báo mới từ PUT.');
    // dedupe: chỉ MỘT bản "Cảnh báo cũ đã lưu." dù xuất hiện ở cả refs.warnings lẫn warnings PUT
    expect(screen.getAllByText('Cảnh báo cũ đã lưu.').length).toBe(1);
    expect(calls.some((c) => c.method === 'PUT')).toBe(true);
  });
});

describe('LabRefsSection — cảnh báo N concept chưa có ảnh', () => {
  it('có concept png rỗng → hiện dòng cảnh báo role=alert đúng số N', async () => {
    stubFetch({
      getResponse: {
        schemaVersion: 1,
        pages: [],
        concepts: [
          { id: 'c1', fileKey: 'ABC', nodeId: '1:1', name: 'Concept A', png: '' },
          { id: 'c2', fileKey: 'ABC', nodeId: '2:2', name: 'Concept B', png: '' },
          { id: 'c3', fileKey: 'ABC', nodeId: '3:3', name: 'Concept C', png: 'ds-lab/refs/c3.png' },
        ],
      },
    });
    render(<LabRefsSection projectId="proj-1" />);

    await screen.findByText('Concept A');
    const alert = await screen.findByText('2 concept chưa có ảnh (lỗi tải từ Figma) — bấm Quét & lưu để thử lại.');
    expect(alert.getAttribute('role')).toBe('alert');
  });

  it('đủ ảnh (không concept nào png rỗng) → không hiện dòng cảnh báo', async () => {
    stubFetch({
      getResponse: {
        schemaVersion: 1,
        pages: [],
        concepts: [{ id: 'c1', fileKey: 'ABC', nodeId: '1:1', name: 'Concept A', png: 'ds-lab/refs/c1.png' }],
      },
    });
    render(<LabRefsSection projectId="proj-1" />);

    await screen.findByText('Concept A');
    expect(screen.queryByText(/concept chưa có ảnh/)).toBeNull();
  });
});
