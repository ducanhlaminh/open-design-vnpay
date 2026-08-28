// @vitest-environment jsdom
//
// StageCommentPanel (wp-docs-review-confirm-v2, Executor J1): cột bình luận
// cấp bước cắm vào các viewer docs-review. Hợp đồng route (daemon do executor
// khác làm, ở đây mock fetch):
//   GET    …/docs-review/comments/:stageId            → { stageId, comments }
//   POST   …/docs-review/comments/:stageId {text,target?} → 201 { comment }
//   DELETE …/docs-review/comments/:stageId/:commentId → 204
// Không optimistic: POST/DELETE xong phải GET lại.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DocsReviewStageComment } from '@open-design/contracts';

const { StageCommentPanel, stageCommentsUrl, fetchDocsReviewCommentCounts, isDocsReviewDocsPage } = await import(
  '../../../src/components/docs-review/StageCommentPanel'
);

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let store: DocsReviewStageComment[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Fetch giả theo đúng hợp đồng route — store trong bộ nhớ cho GET/POST/DELETE. */
function installFetch() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const m = url.match(/^\/api\/projects\/([^/]+)\/docs-review\/comments\/([^/]+)(?:\/([^/]+))?$/);
      if (!m) return jsonResponse(404, { error: 'no route' });
      const stageId = m[2]!;
      const method = init?.method ?? 'GET';
      if (method === 'GET') return jsonResponse(200, { stageId, comments: store.filter((c) => c.stageId === stageId) });
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { text: string; target?: DocsReviewStageComment['target'] };
        const comment: DocsReviewStageComment = {
          id: `c${store.length + 1}`,
          stageId: stageId as DocsReviewStageComment['stageId'],
          text: body.text,
          by: 'Anh',
          at: 1_700_000_000_000 + store.length,
          ...(body.target ? { target: body.target } : {}),
        };
        store.push(comment);
        return jsonResponse(201, { comment });
      }
      if (method === 'DELETE') {
        store = store.filter((c) => c.id !== m[3]);
        return jsonResponse(204, null);
      }
      return jsonResponse(405, { error: 'method' });
    }),
  );
}

beforeEach(() => {
  store = [];
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const seed = (): DocsReviewStageComment[] => [
  { id: 'c1', stageId: 'dr-mockup', text: 'Màn này thiếu nút quay lại', by: 'Anh', at: 1_700_000_000_000, target: { kind: 'screen', key: 'SCR-001', label: 'Trang chủ' } },
  { id: 'c2', stageId: 'dr-mockup', text: 'Bình luận chung cả bước', by: 'Bình', at: 1_700_000_001_000 },
  { id: 'c3', stageId: 'dr-mockup', text: 'Màn 2 cần thêm CTA', by: 'Anh', at: 1_700_000_002_000, target: { kind: 'screen', key: 'SCR-002', label: 'Chọn gói' } },
];

describe('helpers', () => {
  it('stageCommentsUrl encode projectId + commentId; isDocsReviewDocsPage chỉ nhận docs/ và docs-feature/', () => {
    expect(stageCommentsUrl('p x', 'dr-docs')).toBe('/api/projects/p%20x/docs-review/comments/dr-docs');
    expect(stageCommentsUrl('p', 'dr-review', 'c 1')).toBe('/api/projects/p/docs-review/comments/dr-review/c%201');
    expect(isDocsReviewDocsPage('docs-review/docs/confluence/urd.md')).toBe(true);
    expect(isDocsReviewDocsPage('docs-review/docs-feature/spec.md')).toBe(true);
    expect(isDocsReviewDocsPage('docs-review/docs-app/pool.md')).toBe(false);
    expect(isDocsReviewDocsPage('docs-review/review/docs/urd.md')).toBe(false);
    expect(isDocsReviewDocsPage('docs-to-ui/docs/urd.md')).toBe(false);
  });

  it('fetchDocsReviewCommentCounts đếm 5 bước, bước lỗi → 0', async () => {
    store = seed();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.endsWith('/dr-review')) return jsonResponse(500, { error: 'boom' });
        const stageId = url.split('/').pop()!;
        return jsonResponse(200, { stageId, comments: store.filter((c) => c.stageId === stageId) });
      }),
    );
    expect(await fetchDocsReviewCommentCounts('p')).toEqual({ 'dr-docs': 0, 'dr-flow': 0, 'dr-flow-improve': 0, 'dr-mockup': 3, 'dr-review': 0 });
  });
});

describe('StageCommentPanel', () => {
  it('render list: tiêu đề "Bình luận (n)", mỗi dòng by · thời gian · text; không target → không có toggle', async () => {
    store = seed();
    render(<StageCommentPanel projectId="p" stageId="dr-mockup" />);
    const panel = screen.getByTestId('stage-comment-panel');
    expect(panel.getAttribute('data-stage-id')).toBe('dr-mockup');
    await waitFor(() => expect(screen.getByText('Bình luận (3)')).toBeTruthy());
    const items = screen.getAllByTestId('stage-comment-item');
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain('Anh');
    expect(items[0]!.textContent).toContain('Màn này thiếu nút quay lại');
    // Không lọc → comment neo mục hiện nhãn target.
    expect(items[0]!.textContent).toContain('Trang chủ');
    expect(screen.queryByRole('group', { name: 'Phạm vi bình luận' })).toBeNull();
    expect(calls[0]!.url).toBe('/api/projects/p/docs-review/comments/dr-mockup');
  });

  it('có target: mặc định lọc "Chỉ mục này", toggle "Tất cả bước" hiện đủ; POST kèm target khi đang lọc, không kèm khi "Tất cả bước"; sau POST GET lại (không optimistic)', async () => {
    store = seed();
    render(<StageCommentPanel projectId="p" stageId="dr-mockup" target={{ kind: 'screen', key: 'SCR-001', label: 'Trang chủ' }} />);
    await waitFor(() => expect(screen.getByText('Bình luận (1)')).toBeTruthy());
    expect(screen.getAllByTestId('stage-comment-item')).toHaveLength(1);

    const group = screen.getByRole('group', { name: 'Phạm vi bình luận' });
    fireEvent.click(within(group).getByRole('button', { name: 'Tất cả bước' }));
    expect(screen.getByText('Bình luận (3)')).toBeTruthy();
    fireEvent.click(within(group).getByRole('button', { name: 'Chỉ mục này' }));
    expect(screen.getByText('Bình luận (1)')).toBeTruthy();

    // Gửi khi đang lọc theo mục → body { text, target }.
    const input = screen.getByRole('textbox', { name: 'Bình luận mới cho bước' }) as HTMLTextAreaElement;
    const send = () => screen.getByRole('button', { name: /Gửi|Đang gửi/ });
    expect((send() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '  Thiếu trạng thái loading  ' } });
    fireEvent.click(send());
    await waitFor(() => expect(screen.getByText('Bình luận (2)')).toBeTruthy());
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(post.url).toBe('/api/projects/p/docs-review/comments/dr-mockup');
    expect(JSON.parse(String(post.init!.body))).toEqual({
      text: 'Thiếu trạng thái loading',
      target: { kind: 'screen', key: 'SCR-001', label: 'Trang chủ' },
    });
    // POST xong phải GET lại: có GET SAU POST.
    const postIdx = calls.indexOf(post);
    expect(calls.slice(postIdx + 1).some((c) => (c.init?.method ?? 'GET') === 'GET')).toBe(true);
    expect(input.value).toBe('');

    // Cmd/Ctrl+Enter gửi; "Tất cả bước" → không kèm target.
    fireEvent.click(within(group).getByRole('button', { name: 'Tất cả bước' }));
    fireEvent.change(input, { target: { value: 'Ghi chú chung' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(screen.getByText('Bình luận (5)')).toBeTruthy());
    const posts = calls.filter((c) => c.init?.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(JSON.parse(String(posts[1]!.init!.body))).toEqual({ text: 'Ghi chú chung' });
  });

  it('xoá: hỏi confirm nhẹ (Xoá?/Huỷ) rồi DELETE đúng route + GET lại', async () => {
    store = seed();
    render(<StageCommentPanel projectId="p" stageId="dr-mockup" />);
    await waitFor(() => expect(screen.getByText('Bình luận (3)')).toBeTruthy());
    const first = screen.getAllByTestId('stage-comment-item')[0]!;
    fireEvent.click(within(first).getByRole('button', { name: 'Xoá bình luận' }));
    expect(first.textContent).toContain('Xoá?');
    // Huỷ → không DELETE.
    fireEvent.click(within(first).getByRole('button', { name: 'Huỷ' }));
    expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(false);
    fireEvent.click(within(first).getByRole('button', { name: 'Xoá bình luận' }));
    fireEvent.click(within(first).getByRole('button', { name: 'Xoá' }));
    await waitFor(() => expect(screen.getByText('Bình luận (2)')).toBeTruthy());
    const del = calls.find((c) => c.init?.method === 'DELETE')!;
    expect(del.url).toBe('/api/projects/p/docs-review/comments/dr-mockup/c1');
    expect(screen.queryByText('Màn này thiếu nút quay lại')).toBeNull();
  });

  it('gập/mở: collapsedByDefault → chỉ còn tab "💬 n", bấm mở lại; đổi target → quay về lọc theo mục mới', async () => {
    store = seed();
    const { rerender } = render(
      <StageCommentPanel projectId="p" stageId="dr-mockup" target={{ kind: 'screen', key: 'SCR-001' }} collapsedByDefault />,
    );
    const panel = screen.getByTestId('stage-comment-panel');
    expect(panel.getAttribute('data-collapsed')).toBe('true');
    expect(panel.getAttribute('data-target-key')).toBe('SCR-001');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Hiện bình luận (1)' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Hiện bình luận (1)' }));
    expect(screen.getByText('Bình luận (1)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tất cả bước' }));
    expect(screen.getByText('Bình luận (3)')).toBeTruthy();

    rerender(<StageCommentPanel projectId="p" stageId="dr-mockup" target={{ kind: 'screen', key: 'SCR-002' }} collapsedByDefault />);
    await waitFor(() => expect(screen.getByText('Bình luận (1)')).toBeTruthy());
    expect(screen.getByText('Màn 2 cần thêm CTA')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ẩn bình luận' }));
    expect(screen.getByTestId('stage-comment-panel').getAttribute('data-collapsed')).toBe('true');
  });

  it('GET lỗi → báo lỗi, không nổ; POST lỗi → giữ chữ trong ô nhập', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => jsonResponse(init?.method === 'POST' ? 500 : 503, { error: 'daemon bận' })));
    render(<StageCommentPanel projectId="p" stageId="dr-docs" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('503'));
    const input = screen.getByRole('textbox', { name: 'Bình luận mới cho bước' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await waitFor(() => expect(screen.getAllByRole('alert').some((el) => el.textContent?.includes('daemon bận'))).toBe(true));
    expect(input.value).toBe('x');
  });
});
