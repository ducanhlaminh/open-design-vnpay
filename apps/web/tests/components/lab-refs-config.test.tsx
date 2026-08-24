// @vitest-environment jsdom
//
// Section "Concept tham khảo" (rail cấu hình + modal, WP-lab-refs-web):
// - Gate rail/section CHỈ hiện khi workflow có bước `lab-compose` (ds-lab) —
//   test bằng hàm thuần `hasLabRefsStage`, không mount cả `PipelinesView`
//   (nặng, kéo theo fetch dự án/pipeline/design-system — xem
//   stage-run-uses-config.test.tsx cho cùng lý do).
// - Nội dung section (GET prefill, PUT quét & lưu, lỗi token) test trực tiếp
//   trên `LabRefsSection` — component con export riêng để mount rẻ trong
//   jsdom (spec cho phép tách khi PipelinesView quá nặng để mount).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hasLabRefsStage } from '../../src/components/PipelinesView';
import { LabRefsSection } from '../../src/components/pipelines/LabRefsSection';

vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('hasLabRefsStage — gate rail/section theo bước lab-compose', () => {
  it('workflow có lab-compose → true', () => {
    expect(hasLabRefsStage([{ id: 'lab-docs' }, { id: 'lab-compose' }, { id: 'lab-kit' }])).toBe(true);
  });

  it('workflow khác (docs-to-ui) → false', () => {
    expect(hasLabRefsStage([{ id: 'confluence-ingest' }, { id: 'ux-spec' }, { id: 'ui-html' }])).toBe(false);
  });

  it('workflow rỗng → false', () => {
    expect(hasLabRefsStage([])).toBe(false);
  });
});

const REFS_WITH_DATA = {
  schema_version: 1,
  pages: [
    { url: 'https://www.figma.com/design/ABC/Concepts?node-id=1-1', fileKey: 'ABC', nodeId: '1:1', name: 'Trang concept', ok: true },
  ],
  concepts: [
    { id: 'c1', fileKey: 'ABC', nodeId: '2:2', name: 'Concept đăng nhập', png: 'ds-lab/refs/c1.png', width: 800, height: 600 },
  ],
};

const EMPTY_REFS = { schema_version: 1, pages: [], concepts: [] };

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

describe('LabRefsSection', () => {
  it('mở section → GET /ds-lab/lab-refs được gọi, textarea prefill từ pages[].url', async () => {
    const { calls } = stubFetch({ getResponse: REFS_WITH_DATA });
    render(<LabRefsSection projectId="proj-1" />);

    const textarea = await screen.findByPlaceholderText(/Dán link page Figma/);
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe(REFS_WITH_DATA.pages[0]!.url));

    const getCall = calls.find((c) => c.method === 'GET');
    expect(getCall?.url).toBe('/api/projects/proj-1/ds-lab/lab-refs');
  });

  it('bấm "Quét & lưu" → PUT đúng body {links}, render page ok/lỗi + thumbnail đúng projectFileUrl', async () => {
    const { calls } = stubFetch({ getResponse: EMPTY_REFS, putResponse: { refs: REFS_WITH_DATA, warnings: ['1 link bị bỏ qua vì trùng.'] } });
    render(<LabRefsSection projectId="proj-1" />);

    const textarea = await screen.findByPlaceholderText(/Dán link page Figma/);
    fireEvent.change(textarea, { target: { value: 'https://www.figma.com/design/ABC/Concepts?node-id=1-1' } });

    fireEvent.click(screen.getByRole('button', { name: /Quét & lưu/ }));

    await screen.findByText('Trang concept');
    const putCall = calls.find((c) => c.method === 'PUT');
    expect(putCall?.url).toBe('/api/projects/proj-1/ds-lab/lab-refs');
    expect(putCall?.body).toEqual({ links: ['https://www.figma.com/design/ABC/Concepts?node-id=1-1'] });

    expect(screen.getByText('Concept đăng nhập')).toBeTruthy();
    const img = screen.getByAltText('Concept đăng nhập') as HTMLImageElement;
    expect(img.src).toContain('/api/projects/proj-1/raw/ds-lab/refs/c1.png');

    expect(screen.getByText('1 link bị bỏ qua vì trùng.')).toBeTruthy();
  });

  it('PUT 400 FIGMA_TOKEN_REQUIRED → hiện detail + gợi ý mở Cài đặt Figma', async () => {
    stubFetch({
      getResponse: EMPTY_REFS,
      putStatus: 400,
      putResponse: { error: 'FIGMA_TOKEN_REQUIRED', detail: 'Chưa có token Figma trên máy này.' },
    });
    render(<LabRefsSection projectId="proj-1" />);

    const textarea = await screen.findByPlaceholderText(/Dán link page Figma/);
    fireEvent.change(textarea, { target: { value: 'https://www.figma.com/design/ABC/Concepts?node-id=1-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Quét & lưu/ }));

    await screen.findByText(/Chưa có token Figma trên máy này\./);
    expect(screen.getByRole('button', { name: /Cài đặt.*Figma/ })).toBeTruthy();
  });
});
