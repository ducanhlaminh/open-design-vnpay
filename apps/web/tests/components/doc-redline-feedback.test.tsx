// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';

const TEXT = '# Tài liệu\n\nNgười dùng nhập OTP.\n';
const SIDECAR = JSON.stringify({
  schemaVersion: 2,
  annotations: [{
    id: 'agent-1',
    kind: 'ux-writing',
    severity: 'minor',
    origin: 'agent',
    operation: 'edited',
    before: 'Người dùng nhập mã xác thực.',
    quote: 'Người dùng nhập OTP.',
    initialBefore: 'Người dùng nhập mã xác thực.',
    initialQuote: 'Người dùng nhập OTP.',
    reason: 'Dùng thuật ngữ trong tài liệu.',
  }],
  events: [],
});

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: async (_projectId: string, name: string) => {
    if (name.endsWith('.changes.json')) return SIDECAR;
    if (name.endsWith('.notes.json')) return null;
    return TEXT;
  },
  projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
}));
vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

const { DocRedlinePreview, parseDocChangesFile } = await import('../../src/components/DocRedlinePreview');

const FILE = {
  name: 'docs-review/review/docs/urd.md',
  kind: 'text',
  size: TEXT.length,
  mtime: 1,
} as never;

const fetchMock = vi.fn();

beforeAll(() => {
  Element.prototype.scrollIntoView = function noop() {};
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ file: FILE }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => cleanup());

function selectText(container: HTMLElement, text: string) {
  const article = container.querySelector('article');
  if (!article) throw new Error('missing article');
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && node.textContent !== text) node = walker.nextNode();
  if (!node) throw new Error(`missing text node: ${text}`);
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function latestSidecarWrite(): { schemaVersion: number; annotations: Array<Record<string, unknown>>; events: Array<Record<string, unknown>> } {
  const call = [...fetchMock.mock.calls].reverse().find((args) => {
    const init = args[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string };
    return body.name?.endsWith('.changes.json');
  });
  if (!call) throw new Error('missing sidecar write');
  const request = JSON.parse(String((call[1] as RequestInit).body)) as { content: string };
  return JSON.parse(request.content);
}

describe('Docs Review annotations and confirmation', () => {
  it('reads both legacy arrays and the v2 event envelope', () => {
    const legacy = parseDocChangesFile(JSON.stringify([{
      id: 'legacy', before: 'cũ', quote: 'mới', reason: 'Sửa câu.', kind: 'gap', severity: 'minor',
    }]));
    expect(legacy?.changes[0]).toMatchObject({
      id: 'legacy', origin: 'agent', operation: 'edited', initialBefore: 'cũ', initialQuote: 'mới',
    });
    expect(parseDocChangesFile(SIDECAR)?.events).toEqual([]);
  });

  it('creates a user edit from selected document text and writes an append-only create event', async () => {
    const { container, getByRole } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="agent-1"]')).not.toBeNull());

    selectText(container, 'Người dùng nhập OTP.');
    fireEvent.click(getByRole('button', { name: 'Sửa đoạn chọn' }));
    fireEvent.change(getByRole('textbox', { name: 'Nội dung mới' }), {
      target: { value: 'Người dùng nhập OTP gồm 6 chữ số.' },
    });
    fireEvent.click(getByRole('button', { name: 'Lưu thay đổi' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = latestSidecarWrite();
    expect(saved.schemaVersion).toBe(2);
    expect(saved.annotations.at(-1)).toMatchObject({
      origin: 'user',
      operation: 'edited',
      before: 'Người dùng nhập OTP.',
      quote: 'Người dùng nhập OTP gồm 6 chữ số.',
    });
    expect(saved.events.at(-1)).toMatchObject({ actor: 'user', type: 'create' });
  });

  it.each([
    { button: 'Thêm sau đoạn chọn', operation: 'add', replacement: 'Hệ thống kiểm tra OTP.' },
    { button: 'Xoá đoạn chọn', operation: 'delete', replacement: null },
  ])('creates a user $operation annotation with a stable anchor', async ({ button, operation, replacement }) => {
    const { container, getByRole } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="agent-1"]')).not.toBeNull());

    selectText(container, 'Người dùng nhập OTP.');
    fireEvent.click(getByRole('button', { name: button }));
    if (replacement) {
      fireEvent.change(getByRole('textbox', { name: 'Nội dung mới' }), { target: { value: replacement } });
    }
    fireEvent.click(getByRole('button', { name: 'Lưu thay đổi' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const annotation = latestSidecarWrite().annotations.at(-1);
    expect(annotation).toMatchObject({ origin: 'user', operation });
    expect(annotation?.anchor).toBeTruthy();
  });

  it('keeps the agent baseline when a user edits an agent annotation', async () => {
    const { container } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(container.querySelector('[data-change-item="agent-1"]')).not.toBeNull());
    const card = container.querySelector<HTMLElement>('[data-change-item="agent-1"]');
    if (!card) throw new Error('missing agent card');
    fireEvent.click(within(card).getByRole('button', { name: 'Sửa' }));
    fireEvent.change(within(card).getByRole('textbox', { name: 'Nội dung sửa' }), {
      target: { value: 'Người dùng nhập OTP gồm 6 chữ số.' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Lưu' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const saved = latestSidecarWrite();
    expect(saved.annotations[0]).toMatchObject({
      origin: 'agent',
      initialQuote: 'Người dùng nhập OTP.',
      quote: 'Người dùng nhập OTP gồm 6 chữ số.',
      status: 'edited',
    });
    expect(saved.events.at(-1)).toMatchObject({ annotationId: 'agent-1', actor: 'user', type: 'edit' });
  });

  it('records dismiss and restore events while undoing the document change in-session', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(container.querySelector('[data-change-item="agent-1"]')).not.toBeNull());
    const card = container.querySelector<HTMLElement>('[data-change-item="agent-1"]');
    if (!card) throw new Error('missing agent card');

    fireEvent.click(within(card).getByRole('button', { name: 'Bỏ chỗ sửa' }));
    await waitFor(() => expect(latestSidecarWrite().events.at(-1)).toMatchObject({ type: 'dismiss', actor: 'user' }));
    expect(latestSidecarWrite().annotations[0]).toMatchObject({ status: 'dismissed' });

    fireEvent.click(within(card).getByRole('button', { name: 'Hoàn tác' }));
    await waitFor(() => expect(latestSidecarWrite().events.at(-1)).toMatchObject({ type: 'restore', actor: 'user' }));
    expect(latestSidecarWrite().annotations[0]).toMatchObject({ status: 'active' });
  });

  it('retries confirmation with the same id and shows the uploaded receipt', async () => {
    const confirmedAt = 1_786_300_000_000;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!url.endsWith('/docs-review/confirm')) {
        return new Response(JSON.stringify({ file: FILE }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const attempts = fetchMock.mock.calls.filter(([value]) => String(value).endsWith('/docs-review/confirm')).length;
      if (attempts === 1) return new Response(JSON.stringify({ message: 'Media service tạm thời không khả dụng.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      const confirmationId = (JSON.parse(String(init?.body)) as { confirmationId: string }).confirmationId;
      return new Response(JSON.stringify({
        ok: true,
        artifact: {
          schemaVersion: 1, confirmationId, projectId: 'p1', workflowId: 'docs-review', installationId: 'local',
          user: 'tester', channel: 'dev', confirmedAt,
          agent: { add: 0, edited: 1, delete: 0, total: 1, accepted: 1, editedByUser: 0, dismissed: 0 },
          userChanges: { add: 0, edited: 0, delete: 0, total: 0 }, pages: [],
        },
        mediaPath: `docs-review-feedback/local/${confirmationId}.json`,
        localPath: `confirmation/${confirmationId}.json`,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const { container, getByRole, findByText } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    const confirm = await waitFor(() => getByRole('button', { name: 'Xác nhận hoàn tất' }));
    fireEvent.click(confirm);
    expect(await findByText('Media service tạm thời không khả dụng.')).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Thử gửi lại' }));
    expect(await findByText('Đã tổng hợp và gửi số liệu.')).toBeTruthy();

    const requests = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/docs-review/confirm'));
    expect(requests).toHaveLength(2);
    const first = JSON.parse(String((requests[0]?.[1] as RequestInit).body));
    const second = JSON.parse(String((requests[1]?.[1] as RequestInit).body));
    expect(second.confirmationId).toBe(first.confirmationId);

    const card = container.querySelector<HTMLElement>('[data-change-item="agent-1"]');
    if (!card) throw new Error('missing agent card');
    fireEvent.click(within(card).getByRole('button', { name: 'Sửa' }));
    fireEvent.change(within(card).getByRole('textbox', { name: 'Nội dung sửa' }), {
      target: { value: 'Người dùng nhập OTP gồm 6 chữ số.' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Lưu' }));
    expect(await findByText('Tài liệu đã thay đổi sau lần xác nhận.')).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Xác nhận bản mới' }));
    await waitFor(() => {
      const all = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/docs-review/confirm'));
      expect(all).toHaveLength(3);
    });
    const all = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/docs-review/confirm'));
    const third = JSON.parse(String((all[2]?.[1] as RequestInit).body));
    expect(third.confirmationId).not.toBe(first.confirmationId);
  });
});
