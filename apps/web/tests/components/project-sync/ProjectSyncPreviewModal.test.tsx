// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));

const { ProjectSyncPreviewModal } = await import('../../../src/components/project-sync');

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const status = { scope: { kind: 'app', projectId: 'app-a' }, state: 'changed', mappingValid: true, origin: { originId: 'shared-a', name: 'Kho thanh toán', kind: 'app', visibility: 'visible', inKgs: true, inMedia: true }, app: { id: 'app-a', name: 'Thanh toán', kind: 'app', state: 'changed', mappingValid: true, totals: { created: 0, unchanged: 1, changed: 2, deleted: 0 } }, features: [{ id: 'feature-a', name: 'QR', kind: 'feature', state: 'changed', mappingValid: true, totals: { created: 0, unchanged: 1, changed: 2, deleted: 0 } }], summary: { created: 0, unchanged: 1, changed: 2, deleted: 0 }, entries: [] };
const plan = { planId: 'plan-a', createdAt: '2026-08-12T00:00:00Z', direction: 'pull', scope: { kind: 'app', projectId: 'app-a' }, origin: { mode: 'existing', originId: 'shared-a' }, app: status.app, features: status.features, entries: [{ path: 'features/feature-a/output/ui.html', kind: 'output', change: 'changed', local: { checksum: 'l', size: 1 }, origin: { checksum: 'r', size: 1 }, resolution: 'pull' }], summary: status.summary };

function completedOperation(result: unknown) {
  return { operationId: 'op-a', planId: 'plan-a', state: 'succeeded', phase: 'finalizing', progress: { completedItems: 1, totalItems: 1, percent: 100 }, result, createdAt: '', updatedAt: '', expiresAt: '' };
}

const defaultApply = { data: { planId: 'plan-a', applied: 1, skipped: 0, unchanged: 1, softHiddenOriginFeatureIds: [], stale: [] } };

function mockApi(apply: { data: Record<string, unknown> } | { error: unknown } = defaultApply, activePlan: unknown = plan, preflights: unknown[] = []) {
  const queue = [...preflights];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/project-sync/status')) return new Response(JSON.stringify({ data: { results: [status] } }));
    if (url.startsWith('/api/project-sync/origins')) return new Response(JSON.stringify({ data: { origins: [status.origin] } }));
    if (url === '/api/project-sync/plan') return new Response(JSON.stringify({ data: activePlan }));
    if (url === '/api/project-sync/confluence-preflight') {
      return new Response(JSON.stringify({ ok: true, data: queue.length > 1 ? queue.shift() : queue[0] }));
    }
    if (url === '/api/project-sync/operations' && 'data' in apply) return new Response(JSON.stringify({ data: completedOperation(apply.data) }));
    return new Response(JSON.stringify(apply), { status: 'error' in apply ? 409 : 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const preflightCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter((call) => String(call[0]) === '/api/project-sync/confluence-preflight');

const wikiEntry = {
  path: 'features/feature-a/output/a.png', kind: 'output', change: 'new', origin: { checksum: 'abc', size: 1024 }, resolution: 'pull', featureId: 'feature-a',
  confluence: { base: 'https://wiki.example.vn', pageId: '123', spaceKey: 'SMB', attachment: 'a.png', attachmentVersion: 3 },
};
const wikiPlan = { ...plan, planId: 'plan-c', entries: [...plan.entries, wikiEntry], summary: { ...status.summary, created: 1, confluence: { files: 1, bytes: 1024 } } };

function preflightOf(overrides: Record<string, unknown> = {}) {
  return {
    required: true, files: 1, bytes: 1024, base: 'https://wiki.example.vn', credsBase: 'https://wiki.example.vn', baseMatches: true,
    token: 'ok', displayName: 'Nguyễn Văn A', spaces: [{ key: 'SMB', samplePageId: '123', ok: true, status: 200, files: 1 }], ok: true, ...overrides,
  };
}

describe('ProjectSyncPreviewModal', () => {
  it('renders the complete App plan without feature deselection and submits pull choices', async () => {
    const fetchMock = mockApi();
    const onApplied = vi.fn();
    render(<ProjectSyncPreviewModal scope={{ kind: 'app', projectId: 'app-a' }} subjectName="Thanh toán" onClose={() => {}} onApplied={onApplied} />);
    await waitFor(() => expect(screen.queryByText('Thanh toán')).not.toBeNull());
    expect(screen.queryByText('QR')).not.toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('button', { name: /Thanh toán/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByText('Các tính năng')).not.toBeNull();
    expect(screen.queryByText('Kết quả')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Kết quả/ }));
    fireEvent.click(screen.getByLabelText('Tệp có xung đột giữa bản trên máy và kho chung: features/feature-a/output/ui.html', { exact: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Lấy dự án về máy' }));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    // No Confluence-backed entry → the preflight endpoint is never touched.
    expect(preflightCalls(fetchMock)).toHaveLength(0);
    expect(screen.queryByLabelText('Tài liệu Confluence')).toBeNull();
  });

  it('runs the Confluence preflight for a wiki-backed plan and blocks Pull until it passes', async () => {
    const fetchMock = mockApi(defaultApply, wikiPlan, [
      preflightOf({ token: 'missing', displayName: undefined, spaces: [], ok: false }),
      preflightOf(),
    ]);
    render(<ProjectSyncPreviewModal scope={{ kind: 'app', projectId: 'app-a' }} subjectName="Thanh toán" onClose={() => {}} />);
    expect(await screen.findByText('Chưa có PAT Confluence — Settings → Integrations → Confluence')).toBeTruthy();
    expect(preflightCalls(fetchMock)).toHaveLength(1);
    expect(JSON.parse(String(preflightCalls(fetchMock)[0]?.[1]?.body))).toEqual({ planId: 'plan-c' });
    expect(screen.getByText('1 file (1 KB) sẽ tải từ https://wiki.example.vn')).toBeTruthy();
    const pull = screen.getByRole('button', { name: 'Lấy dự án về máy' }) as HTMLButtonElement;
    expect(pull.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Kết quả/ }));
    expect(screen.getByTitle('a.png v3').textContent).toBe('wiki');

    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra lại' }));
    expect(await screen.findByText('PAT hợp lệ · Nguyễn Văn A')).toBeTruthy();
    expect(screen.getByText('Space SMB: có quyền ✓')).toBeTruthy();
    expect(preflightCalls(fetchMock)).toHaveLength(2);
    await waitFor(() => expect(pull.disabled).toBe(false));
  });

  it('explains a missing space right and a mismatched wiki base', async () => {
    mockApi(defaultApply, wikiPlan, [preflightOf({
      credsBase: 'https://wiki.other.vn', baseMatches: false,
      spaces: [{ key: 'SMB', samplePageId: '123', ok: false, status: 404, files: 1 }], ok: false,
    })]);
    render(<ProjectSyncPreviewModal scope={{ kind: 'app', projectId: 'app-a' }} subjectName="Thanh toán" onClose={() => {}} />);
    expect(await screen.findByText('Space SMB: không có quyền (HTTP 404) — cần được cấp quyền space')).toBeTruthy();
    expect(screen.getByText('Máy này trỏ https://wiki.other.vn, dữ liệu cần https://wiki.example.vn')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Lấy dự án về máy' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the dialog open and lists wiki files that drifted or went missing after apply', async () => {
    mockApi({ data: {
      ...defaultApply.data, planId: 'plan-c', applied: 2,
      confluence: {
        fetched: 0,
        drifted: [{ path: 'features/feature-a/output/b.png', reason: 'sha256 lệch bản pin v2' }],
        missing: [{ path: 'features/feature-a/output/a.png', reason: 'HTTP 404' }],
      },
    } }, wikiPlan, [preflightOf()]);
    const onClose = vi.fn();
    const onApplied = vi.fn();
    render(<ProjectSyncPreviewModal scope={{ kind: 'app', projectId: 'app-a' }} subjectName="Thanh toán" onClose={onClose} onApplied={onApplied} />);
    const pull = await screen.findByRole('button', { name: 'Lấy dự án về máy' }) as HTMLButtonElement;
    await waitFor(() => expect(pull.disabled).toBe(false));
    fireEvent.click(pull);
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    const warnings = await screen.findByTestId('project-sync-confluence-warnings');
    expect(warnings.textContent).toContain('1 file Confluence không tải được (không ghi vào máy): features/feature-a/output/a.png (HTTP 404)');
    expect(warnings.textContent).toContain('1 file Confluence đã đổi trên wiki so với bản đã review, đã lấy bản mới nhất: features/feature-a/output/b.png (sha256 lệch bản pin v2)');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Đóng' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the bar indeterminate while validating, then shows wiki file progress and the pull summary', async () => {
    const ledgerEntry = {
      path: 'features/feature-a/attachments/_sources.json', kind: 'output', change: 'changed',
      local: { checksum: 'l', size: 200 }, origin: { checksum: 'l', size: 200 }, resolution: 'pull', featureId: 'feature-a',
      confluenceGroup: { files: 2, bytes: 2048, missing: 1 },
    };
    const groupPlan = { ...plan, planId: 'plan-g', entries: [...plan.entries, ledgerEntry], summary: { ...status.summary, changed: 2, confluence: { files: 2, bytes: 2048 } } };
    const running = (overrides: Record<string, unknown>) => ({
      operationId: 'op-g', planId: 'plan-g', state: 'running', phase: 'validating', progress: { completedItems: 0, totalItems: 3, percent: 0 },
      createdAt: '', updatedAt: '', expiresAt: '', ...overrides,
    });
    const polls = [
      running({ phase: 'transferring', progress: { completedItems: 1, totalItems: 3, percent: 33, currentPath: 'features/feature-a/attachments/bieu-mau.xlsx' } }),
      running({
        state: 'succeeded', phase: 'finalizing', progress: { completedItems: 3, totalItems: 3, percent: 100 },
        result: { planId: 'plan-g', applied: 2, skipped: 0, unchanged: 1, softHiddenOriginFeatureIds: [], stale: [], confluence: { fetched: 1, drifted: [], missing: [{ path: 'features/feature-a/attachments/cu.pdf', reason: 'HTTP 404' }] } },
      }),
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/project-sync/plan') return new Response(JSON.stringify({ data: groupPlan }));
      if (url === '/api/project-sync/confluence-preflight') return new Response(JSON.stringify({ ok: true, data: preflightOf({ files: 2, bytes: 2048 }) }));
      if (url === '/api/project-sync/operations') return new Response(JSON.stringify({ data: running({}) }));
      if (url.startsWith('/api/project-sync/operations/')) return new Response(JSON.stringify({ data: polls.length > 1 ? polls.shift() : polls[0] }));
      return new Response(JSON.stringify({ data: {} }));
    }));
    const onClose = vi.fn();
    render(<ProjectSyncPreviewModal scope={{ kind: 'app', projectId: 'app-a' }} subjectName="Thanh toán" onClose={onClose} />);
    const pull = await screen.findByRole('button', { name: 'Lấy dự án về máy' }) as HTMLButtonElement;
    await waitFor(() => expect(pull.disabled).toBe(false));
    expect(screen.queryByTestId('project-sync-progress')).toBeNull();
    fireEvent.click(pull);

    const panel = await screen.findByTestId('project-sync-progress');
    expect(panel.textContent).toContain('Đang kiểm tra kế hoạch…');
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('data-indeterminate')).toBe('true'));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull();

    // The count is echoed in the footer note as well, hence *All*.
    expect(await screen.findAllByText('1/3 file · 33%', {}, { timeout: 3000 })).toHaveLength(2);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('33');
    expect(screen.getByText('Đang tải tài liệu từ wiki: bieu-mau.xlsx')).toBeTruthy();

    const summary = await screen.findByTestId('project-sync-confluence-summary', {}, { timeout: 3000 });
    expect(summary.textContent).toBe('Đã tải 1 file từ wiki · lệch 0 · thiếu 1');
    expect(screen.getByText('3/3 file · 100%')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    expect(screen.getByTestId('project-sync-confluence-warnings').textContent).toContain('features/feature-a/attachments/cu.pdf (HTTP 404)');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows PLAN_EXPIRED recovery and returns focus to reload', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/project-sync/status') return new Response(JSON.stringify({ data: { results: [status] } }));
      if (url === '/api/project-sync/plan') return new Response(JSON.stringify({ data: plan }));
      if (url === '/api/project-sync/operations') return new Response(JSON.stringify({ error: { code: 'PLAN_EXPIRED' } }), { status: 409 });
      return new Response(JSON.stringify({ data: {} }));
    }));
    render(<ProjectSyncPreviewModal scope={{ kind: 'app', projectId: 'app-a' }} subjectName="Thanh toán" onClose={() => {}} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Lấy dự án về máy' })).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Lấy dự án về máy' }));
    await waitFor(() => expect(screen.queryByText('Kế hoạch đã hết hạn. Tải lại để nhận ảnh chụp mới trước khi áp dụng.')).not.toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Tải lại xem trước' }));
  });
});
