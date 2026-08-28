// @vitest-environment jsdom
//
// wp-doc-redline-nondestructive: tài liệu hiển thị = bản GỐC, không bao giờ bị
// ghi lại (`fetchProjectFileText` cho `file.name` luôn trả TEXT dưới đây
// nguyên vẹn). Mark của agent-1 (phép SỬA — có cả `before`/`quote`) neo trên
// `before`, không phải `quote` — TEXT phải chứa đúng câu `before`, và một câu
// KHÁC (không trùng agent-1) để các test "tạo annotation người dùng" bôi đen.
//
// Rail đã bỏ hẳn: mọi hành động (Bỏ/Hoàn tác, Sửa nội dung đề xuất) giờ nằm
// trong `AnnotationDetailPanel` mở ra khi bấm mark, không còn trong thẻ
// `[data-change-item]`. Tính năng "sửa TRỰC TIẾP nội dung quote của một chỗ
// sửa agent, giữ initialQuote làm baseline" từng mất đường tới nó khi rail bị
// bỏ, nay QUAY LẠI dưới dạng non-destructive trong panel (nút "Sửa" →
// textarea → `editChangeQuote`): chỉ ghi changes.json (status 'edited' +
// event 'edit'), tài liệu .md không bao giờ bị đụng.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

const TEXT = ['# Tài liệu', '', 'Người dùng nhập mã xác thực.', '', 'Người dùng nhập OTP.', ''].join('\n');
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
// wp-docs-review-confirm-v2: panel bình luận cấp bước cắm vào viewer này —
// stub ghi props (panel thật tự GET comments lúc mount, làm lệch các đếm
// fetchMock ở dưới; hợp đồng panel test riêng ở
// tests/components/docs-review/stage-comment-panel.test.tsx).
type StagePanelProps = { projectId: string; stageId: string; target?: { kind: string; key: string; label?: string }; collapsedByDefault?: boolean };
let stagePanelCalls: StagePanelProps[] = [];
vi.mock('../../src/components/docs-review/StageCommentPanel', () => ({
  StageCommentPanel: (props: StagePanelProps) => {
    stagePanelCalls.push(props);
    return <aside data-testid="stage-comment-panel" data-stage-id={props.stageId} data-target-kind={props.target?.kind ?? ''} data-target-key={props.target?.key ?? ''} data-target-label={props.target?.label ?? ''} />;
  },
}));

const { DocRedlinePreview, parseDocChangesFile, narrowEditedLines } = await import('../../src/components/DocRedlinePreview');
const { resetCurrentUserCache } = await import('../../src/components/docs-review/current-user');

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
  // `by` của bình luận annotation đọc /api/auth/me một lần rồi nhớ — xoá cache
  // để mỗi test tự quyết có user hay không.
  resetCurrentUserCache();
  stagePanelCalls = [];
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

function latestNotesWrite(): Array<Record<string, unknown>> {
  const call = [...fetchMock.mock.calls].reverse().find((args) => {
    const init = args[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string };
    return body.name?.endsWith('.notes.json');
  });
  if (!call) throw new Error('missing notes write');
  const request = JSON.parse(String((call[1] as RequestInit).body)) as { content: string };
  return JSON.parse(request.content);
}

/** wp-doc-redline-nondestructive: khẳng định KHÔNG có lệnh ghi nào nhắm vào
 *  `file.name` (đuôi `.md`) — tài liệu không bao giờ bị ghi lại. */
function expectNoMdWrite() {
  const call = fetchMock.mock.calls.find((args) => {
    const init = args[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string };
    return body.name?.endsWith('.md');
  });
  expect(call, 'không được có lệnh ghi .md nào').toBeUndefined();
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

  it('creates a user edit from selected document text and writes an append-only create event (no .md write)', async () => {
    const { container, getByRole } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="agent-1"]')).not.toBeNull());

    // Toolbar tự chỉnh mặc định ẨN — phải bật chế độ "Tự chỉnh" trước.
    fireEvent.click(getByRole('button', { name: 'Tự chỉnh' }));
    selectText(container, 'Người dùng nhập OTP.');
    fireEvent.click(getByRole('button', { name: 'Sửa đoạn chọn' }));
    fireEvent.change(getByRole('textbox', { name: 'Nội dung mới' }), {
      target: { value: 'Người dùng nhập OTP gồm 6 chữ số.' },
    });
    fireEvent.click(getByRole('button', { name: 'Lưu thay đổi' }));

    // Non-destructive: saveAction chỉ ghi .changes.json — MỘT lệnh gọi fetch,
    // không còn lệnh ghi .md song song như kiến trúc cũ.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expectNoMdWrite();
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
  ])('creates a user $operation annotation with a stable anchor (no .md write)', async ({ button, operation, replacement }) => {
    const { container, getByRole } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="agent-1"]')).not.toBeNull());

    fireEvent.click(getByRole('button', { name: 'Tự chỉnh' }));
    selectText(container, 'Người dùng nhập OTP.');
    fireEvent.click(getByRole('button', { name: button }));
    if (replacement) {
      fireEvent.change(getByRole('textbox', { name: 'Nội dung mới' }), { target: { value: replacement } });
    }
    fireEvent.click(getByRole('button', { name: 'Lưu thay đổi' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expectNoMdWrite();
    const annotation = latestSidecarWrite().annotations.at(-1);
    expect(annotation).toMatchObject({ origin: 'user', operation });
    expect(annotation?.anchor ?? annotation?.before).toBeTruthy();
  });

  it('records dismiss and restore events via the detail modal, without touching the document (.md)', async () => {
    const { container, baseElement } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="agent-1"]')).not.toBeNull());
    fireEvent.click(container.querySelector('mark[data-change-id="agent-1"]')!);

    const dialog = await waitFor(() => {
      const el = baseElement.querySelector('[role="dialog"]');
      expect(el, 'phải mở modal chi tiết của agent-1').not.toBeNull();
      return el as HTMLElement;
    });
    const dismissBtn = () =>
      Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Bỏ' || b.textContent === 'Hoàn tác')!;
    // wp-redline-card-polish.yaml mục 3: nhãn "Bỏ chỗ sửa" rút gọn còn "Bỏ" —
    // hành vi/nội dung nút không đổi qua đợt bỏ rail, chỉ đổi CHỖ hiện (modal).
    expect(dismissBtn().textContent).toBe('Bỏ');
    fireEvent.click(dismissBtn());

    await waitFor(() => expect(latestSidecarWrite().events.at(-1)).toMatchObject({ type: 'dismiss', actor: 'user' }));
    expect(latestSidecarWrite().annotations[0]).toMatchObject({ status: 'dismissed' });
    await waitFor(() => expect(dismissBtn().textContent).toBe('Hoàn tác'));

    fireEvent.click(dismissBtn());
    await waitFor(() => expect(latestSidecarWrite().events.at(-1)).toMatchObject({ type: 'restore', actor: 'user' }));
    expect(latestSidecarWrite().annotations[0]).toMatchObject({ status: 'active' });
    expectNoMdWrite();
  });

  it('sửa nội dung đề xuất của agent qua panel: status edited + event edit, giữ initialQuote, không đụng .md', async () => {
    const { container, baseElement } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="agent-1"]')).not.toBeNull());
    fireEvent.click(container.querySelector('mark[data-change-id="agent-1"]')!);

    const dialog = await waitFor(() => {
      const el = baseElement.querySelector('[role="dialog"]');
      expect(el, 'phải mở panel chi tiết của agent-1').not.toBeNull();
      return el as HTMLElement;
    });
    // Nguồn gốc phải đọc ra được ngay ở đầu panel: đề xuất agent chưa ai đụng.
    expect(dialog.textContent).toContain('Agent đề xuất');
    expect(dialog.textContent).not.toContain('bạn đã chỉnh');
    const btn = (label: string) =>
      Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent?.includes(label))!;
    fireEvent.click(btn('Chỉnh đề xuất'));

    const textarea = dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="Nội dung sửa"]');
    expect(textarea, 'bấm Sửa phải mở textarea nội dung đề xuất').not.toBeNull();
    // Prefill = quote HIỆN TẠI (nguyên văn, không normalize <br>) — người dùng
    // chỉnh tiếp từ đề xuất của agent chứ không gõ lại từ đầu.
    expect(textarea!.value).toBe('Người dùng nhập OTP.');
    fireEvent.change(textarea!, { target: { value: 'Người dùng nhập mã OTP 6 số.' } });
    fireEvent.click(btn('Lưu'));

    await waitFor(() => expect(latestSidecarWrite().events.at(-1)).toMatchObject({ type: 'edit', actor: 'user' }));
    expect(latestSidecarWrite().annotations[0]).toMatchObject({
      status: 'edited',
      quote: 'Người dùng nhập mã OTP 6 số.',
      // Baseline agent giữ nguyên để feedback so bản agent ↔ bản người dùng;
      // `before` không đổi nên vùng bôi không đổi chỗ.
      initialQuote: 'Người dùng nhập OTP.',
      before: 'Người dùng nhập mã xác thực.',
    });
    expectNoMdWrite();
    // Lưu thành công thì thoát chế độ sửa — panel quay về diff với nội dung
    // mới (chỉ còn ô "Bình luận mới" luôn hiện, không còn textarea sửa), và
    // badge nguồn gốc chuyển sang "Agent đề xuất · bạn đã chỉnh".
    await waitFor(() => expect(dialog.querySelector('textarea[aria-label="Nội dung sửa"]')).toBeNull());
    expect(dialog.textContent).toContain('Agent đề xuất · bạn đã chỉnh');
  });

  // Regression: listener uỷ quyền của cột chỉ gắn lại theo `loading`, nên nếu
  // nó gọi thẳng openAnnotationDetail (closure đóng băng) thì change vừa tạo
  // trong phiên tra vào mảng `changes` cũ → click mark mới không mở panel.
  // Fix = openAnnotationDetailRef luôn trỏ bản mới nhất.
  it('click mark của change NGƯỜI DÙNG vừa tạo trong phiên mở được panel chi tiết', async () => {
    const { container, baseElement, getByRole } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="agent-1"]')).not.toBeNull());

    fireEvent.click(getByRole('button', { name: 'Tự chỉnh' }));
    selectText(container, 'Người dùng nhập OTP.');
    fireEvent.click(getByRole('button', { name: 'Sửa đoạn chọn' }));
    fireEvent.change(getByRole('textbox', { name: 'Nội dung mới' }), {
      target: { value: 'Người dùng nhập OTP gồm 6 chữ số.' },
    });
    fireEvent.click(getByRole('button', { name: 'Lưu thay đổi' }));

    const newMark = await waitFor(() => {
      const m = Array.from(container.querySelectorAll<HTMLElement>('mark[data-change-id]')).find(
        (el) => el.dataset.changeId !== 'agent-1' && !el.dataset.changeId?.startsWith('ref:'),
      );
      expect(m, 'phải có mark của change user mới tạo').toBeTruthy();
      return m!;
    });
    fireEvent.click(newMark);
    // Nội dung MỚI hiện qua EditDiffBlock (diff mức TỪ — câu bị tách thành
    // run same/del/add), nên chỉ khẳng định phần chữ ĐƯỢC THÊM, không phải
    // nguyên câu liền mạch. Badge nguồn gốc = "Bạn tự chỉnh" (origin user).
    await waitFor(() => {
      expect(baseElement.querySelector('[role="dialog"]')?.textContent).toContain('gồm 6 chữ số');
    });
    expect(baseElement.querySelector('[role="dialog"]')?.textContent).toContain('Bạn tự chỉnh');
  });

  // Composer "Sửa đoạn chọn" prefill nội dung thay thế = đoạn đã chọn (chỉnh
  // tại chỗ), và narrowEditedLines thu hẹp change về đúng DÒNG thật sự đổi —
  // vùng bôi trong preview và nội dung panel phải kể cùng một chuyện.
  it('prefill "Sửa đoạn chọn" bằng chính đoạn đã chọn + chặn lưu khi chưa đổi gì', async () => {
    const { container, getByRole } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="agent-1"]')).not.toBeNull());
    fireEvent.click(getByRole('button', { name: 'Tự chỉnh' }));
    selectText(container, 'Người dùng nhập OTP.');
    fireEvent.click(getByRole('button', { name: 'Sửa đoạn chọn' }));
    const textarea = getByRole('textbox', { name: 'Nội dung mới' }) as HTMLTextAreaElement;
    expect(textarea.value).toBe('Người dùng nhập OTP.');
    fireEvent.click(getByRole('button', { name: 'Lưu thay đổi' }));
    await waitFor(() => expect(container.textContent).toContain('Nội dung mới chưa thay đổi'));
    expect(() => latestSidecarWrite()).toThrow();
  });

  it('narrowEditedLines thu hẹp về đúng dòng đổi, giữ nguyên khi thuần thêm/xoá dòng', () => {
    expect(narrowEditedLines('dòng một\ndòng hai\ndòng ba', 'dòng một\ndòng hai SỬA\ndòng ba')).toEqual({
      before: 'dòng hai',
      quote: 'dòng hai SỬA',
    });
    // Đổi nhiều dòng liền nhau: giữ trọn cụm đổi.
    expect(narrowEditedLines('a\nb\nc\nd', 'a\nB\nC\nd')).toEqual({ before: 'b\nc', quote: 'B\nC' });
    // Thuần xoá một dòng (vế quote rỗng sau khi cắt) → giữ nguyên vùng chọn.
    expect(narrowEditedLines('a\nb\nc', 'a\nc')).toEqual({ before: 'a\nb\nc', quote: 'a\nc' });
    // Một dòng đơn đổi chữ: không có gì để cắt.
    expect(narrowEditedLines('câu cũ', 'câu mới')).toEqual({ before: 'câu cũ', quote: 'câu mới' });
  });

  // Bình luận: hội thoại bên lề trên MỘT change/note — ghi field `comments`
  // vào sidecar qua đúng đường saveAction, KHÔNG sinh event (events là lịch
  // sử nội dung đề xuất), và .md không bao giờ bị đụng.
  it('thêm rồi xoá bình luận trên một chỗ sửa: ghi comments vào sidecar, không event, không .md', async () => {
    const { container, baseElement } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="agent-1"]')).not.toBeNull());
    fireEvent.click(container.querySelector('mark[data-change-id="agent-1"]')!);
    const dialog = await waitFor(() => {
      const el = baseElement.querySelector('[role="dialog"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });

    const input = () => dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="Bình luận mới"]')!;
    expect(input(), 'panel phải có ô nhập bình luận').not.toBeNull();
    fireEvent.change(input(), { target: { value: 'Cần đối chiếu lại với BA.' } });
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Gửi')!);

    await waitFor(() => expect(latestSidecarWrite().annotations[0]?.comments).toMatchObject([
      { text: 'Cần đối chiếu lại với BA.' },
    ]));
    expect(latestSidecarWrite().events).toEqual([]);
    expectNoMdWrite();
    // Panel hiện bình luận + đếm, và ô nhập được xoá trắng sau khi gửi.
    await waitFor(() => expect(dialog.textContent).toContain('Bình luận (1)'));
    expect(dialog.textContent).toContain('Cần đối chiếu lại với BA.');
    expect(input().value).toBe('');

    fireEvent.click(dialog.querySelector('button[aria-label="Xoá bình luận"]')!);
    // Xoá bình luận cuối cùng: field `comments` biến mất khỏi sidecar (không
    // giữ mảng rỗng), panel quay về "Bình luận" không số đếm.
    await waitFor(() => expect(latestSidecarWrite().annotations[0]?.comments).toBeUndefined());
    await waitFor(() => expect(dialog.textContent).not.toContain('Bình luận (1)'));
  });

  // Tự chỉnh THUỘC hệ loại Thay đổi/Nhận xét: "Tô đoạn chọn" tạo một NHẬN XÉT
  // và preview tự chuyển sang tab Nhận xét để mục vừa tạo hiện ra ngay.
  it('"Tô đoạn chọn" ghi vào notes.json và tự chuyển sang tab Nhận xét', async () => {
    const { container, getByRole, getAllByRole } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="agent-1"]')).not.toBeNull());
    fireEvent.click(getByRole('button', { name: 'Tự chỉnh' }));
    // Toolbar nhóm nút theo đúng hai loại của hệ tab.
    expect(getByRole('group', { name: 'Tạo thay đổi' }).textContent).toContain('Sửa đoạn chọn');
    expect(getByRole('group', { name: 'Tạo nhận xét' }).textContent).toContain('Tô đoạn chọn');

    selectText(container, 'Người dùng nhập OTP.');
    // jsdom không tự bắn selectionchange khi addRange — bắn tay để nút
    // "Tô đoạn chọn" (gate theo selection) bật lên như trên trình duyệt thật.
    fireEvent(document, new Event('selectionchange'));
    const highlightBtn = getByRole('button', { name: 'Tô đoạn chọn' }) as HTMLButtonElement;
    await waitFor(() => expect(highlightBtn.disabled).toBe(false));
    fireEvent.click(highlightBtn);
    fireEvent.click(getByRole('button', { name: 'Lưu thay đổi' }));

    await waitFor(() => expect(latestNotesWrite().at(-1)).toMatchObject({
      origin: 'user',
      anchor: 'Người dùng nhập OTP.',
    }));
    expectNoMdWrite();
    // Đang đứng ở tab "Thay đổi" lúc tạo — sau khi lưu phải TỰ chuyển sang
    // "Nhận xét" và mark của note vừa tạo hiện ra không cần bấm tab.
    await waitFor(() => {
      const selected = getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true');
      expect(selected?.textContent).toContain('Nhận xét');
    });
    await waitFor(() => expect(container.querySelector('mark[data-change-id^="note:"]')).not.toBeNull());
  });

  it('tạo user edit khi đang ở tab Nhận xét thì tự quay về tab Thay đổi', async () => {
    const { container, getByRole, getAllByRole } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="agent-1"]')).not.toBeNull());
    fireEvent.click(getAllByRole('tab').find((tab) => tab.textContent?.includes('Nhận xét'))!);

    fireEvent.click(getByRole('button', { name: 'Tự chỉnh' }));
    selectText(container, 'Người dùng nhập OTP.');
    fireEvent.click(getByRole('button', { name: 'Sửa đoạn chọn' }));
    fireEvent.change(getByRole('textbox', { name: 'Nội dung mới' }), {
      target: { value: 'Người dùng nhập OTP gồm 6 chữ số.' },
    });
    fireEvent.click(getByRole('button', { name: 'Lưu thay đổi' }));

    await waitFor(() => expect(latestSidecarWrite().annotations.at(-1)).toMatchObject({ origin: 'user' }));
    await waitFor(() => {
      const selected = getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true');
      expect(selected?.textContent).toContain('Thay đổi');
    });
  });

  it('does not expose workflow completion inside an individual document preview', async () => {
    const { getByRole, queryByRole } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    // Mặc định chỉ có nút vào chế độ "Tự chỉnh"; bật lên mới thấy dàn nút.
    await waitFor(() => expect(queryByRole('button', { name: 'Tự chỉnh' })).toBeTruthy());
    expect(queryByRole('button', { name: 'Sửa đoạn chọn' })).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Tự chỉnh' }));
    await waitFor(() => expect(queryByRole('button', { name: 'Sửa đoạn chọn' })).toBeTruthy());
    expect(queryByRole('button', { name: 'Xác nhận hoàn tất' })).toBeNull();
  });
});

// wp-docs-review-confirm-v2 (J2): trang redline có thêm panel bình luận CẤP
// TRANG (bước dr-review, target page = đường dẫn tương đối so với review/),
// cạnh panel chi tiết và KHÔNG thay bình luận per-annotation; bình luận
// annotation giờ ghi `by` (tên từ /api/auth/me) khi có user.
describe('DocRedlinePreview — bình luận cấp trang + `by` (wp-docs-review-confirm-v2)', () => {
  it('panel cấp trang: stageId dr-review, target page docs/urd.md, gập sẵn', async () => {
    const { container } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="agent-1"]')).not.toBeNull());
    const panel = container.querySelector('[data-testid="stage-comment-panel"]')!;
    expect(panel).not.toBeNull();
    expect(panel.getAttribute('data-stage-id')).toBe('dr-review');
    expect(panel.getAttribute('data-target-kind')).toBe('page');
    expect(panel.getAttribute('data-target-key')).toBe('docs/urd.md');
    expect(panel.getAttribute('data-target-label')).toBe('urd.md');
    const last = stagePanelCalls[stagePanelCalls.length - 1]!;
    expect(last.projectId).toBe('p1');
    expect(last.collapsedByDefault).toBe(true);
  });

  it('bình luận annotation ghi `by` = user.name từ /api/auth/me; panel chi tiết hiện tên', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      const url = String(input);
      if (url === '/api/auth/me') {
        return new Response(JSON.stringify({ user: { name: 'Anh Nguyen', email: 'anh@vnpay.vn' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ file: FILE }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const { container, baseElement } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="agent-1"]')).not.toBeNull());
    fireEvent.click(container.querySelector('mark[data-change-id="agent-1"]')!);
    const dialog = await waitFor(() => {
      const el = baseElement.querySelector('[role="dialog"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.change(dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="Bình luận mới"]')!, { target: { value: 'Cần BA xác nhận.' } });
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Gửi')!);
    await waitFor(() => expect(latestSidecarWrite().annotations[0]?.comments).toMatchObject([
      { text: 'Cần BA xác nhận.', by: 'Anh Nguyen' },
    ]));
    expect(latestSidecarWrite().events).toEqual([]);
    expectNoMdWrite();
    await waitFor(() => expect(dialog.textContent).toContain('Anh Nguyen · '));
  });

  it('không có user (/api/auth/me không trả user) → bình luận không có `by`', async () => {
    const { container, baseElement } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="agent-1"]')).not.toBeNull());
    fireEvent.click(container.querySelector('mark[data-change-id="agent-1"]')!);
    const dialog = await waitFor(() => {
      const el = baseElement.querySelector('[role="dialog"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.change(dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="Bình luận mới"]')!, { target: { value: 'Ẩn danh.' } });
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Gửi')!);
    await waitFor(() => expect(latestSidecarWrite().annotations[0]?.comments).toHaveLength(1));
    expect(latestSidecarWrite().annotations[0]!.comments as Array<Record<string, unknown>>).toEqual([
      expect.not.objectContaining({ by: expect.anything() }),
    ]);
  });
});
