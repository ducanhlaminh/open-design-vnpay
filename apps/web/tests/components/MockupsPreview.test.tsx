// @vitest-environment jsdom
//
// MockupsPreview (WP dr-mockup, 2026-08-27) — khung nhìn `mockups/index.json`
// của bước "Mockup màn": rail màn + iframe sandbox srcdoc nạp HTML màn đang
// chọn; điều hướng bằng postMessage `od-mockup-nav` từ iframe (script chèn
// vào srcdoc) → host đổi màn + lịch sử "Quay lại"; badge "đề xuất" cho màn
// provenance=proposed; thiếu file màn → thông báo thay vì iframe rỗng.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const FILES: Record<string, string | null> = {};
vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: async (_projectId: string, name: string) => FILES[name] ?? null,
  projectRawUrl: (projectId: string, name: string) => `/api/projects/${projectId}/raw/${name}`,
}));

const { MockupsPreview, isMockupsIndexDoc, isMockupsIndexFile, withNavScript, NAV_SCRIPT, mockupLayoutOf, mockupScreenPath } =
  await import('../../src/components/MockupsPreview');

afterEach(() => {
  cleanup();
  for (const k of Object.keys(FILES)) delete FILES[k];
});

const file = (name: string, mtime = 1) => ({ name, size: 1, mtime, kind: 'code' as const, mime: 'application/json' });

const INDEX = {
  schema_version: 1,
  generatedAt: '2026-08-27T00:00:00Z',
  variant: 'improved',
  screens: [
    { key: 'SCR-001', name: 'Trang chủ', file: 'SCR-001.html', platform: 'mobile', navOut: ['SCR-002'] },
    { key: 'SCR-002', name: 'Chọn gói cước', file: 'SCR-002.html', platform: 'mobile', provenance: 'proposed', navOut: [] },
    { key: 'SCR-003', name: 'Quản trị', file: 'mockups/SCR-003.html', platform: 'web', navOut: [] },
    { key: 'SCR-404', name: 'Mất file', file: 'SCR-404.html', platform: 'mobile', navOut: [] },
  ],
};
const HTML_1 = '<!doctype html><html><head><style>.mk-region{border:1px dashed #999}</style></head><body data-screen="SCR-001" data-layout="mobile"><section class="mk-region" data-region="cta" data-nav="SCR-002"><p>Tiếp tục</p></section></body></html>';
const HTML_2 = '<!doctype html><html><body data-screen="SCR-002" data-layout="mobile"><section class="mk-region" data-region="content"><p>Gói 5G</p></section></body></html>';
const HTML_3 = '<!doctype html><html><body data-screen="SCR-003" data-layout="web"><section class="mk-region" data-region="content"><p>Bảng</p></section></body></html>';

function seed() {
  FILES['docs-review/mockups/index.json'] = JSON.stringify(INDEX);
  FILES['docs-review/mockups/SCR-001.html'] = HTML_1;
  FILES['docs-review/mockups/SCR-002.html'] = HTML_2;
  FILES['docs-review/mockups/SCR-003.html'] = HTML_3;
}

async function renderPreview() {
  seed();
  render(<MockupsPreview projectId="p" file={file('docs-review/mockups/index.json')} />);
  return await screen.findByTestId('mockup-frame');
}

describe('guards / helpers', () => {
  it('isMockupsIndexFile nhận đúng <wf>/mockups/index.json, không nhận HTML màn hay index khác', () => {
    expect(isMockupsIndexFile(file('docs-review/mockups/index.json'))).toBe(true);
    expect(isMockupsIndexFile(file('mockups/index.json'))).toBe(true);
    expect(isMockupsIndexFile(file('docs-review/mockups/SCR-001.html'))).toBe(false);
    expect(isMockupsIndexFile(file('docs-review/comp/index.json'))).toBe(false);
    expect(isMockupsIndexFile(file('docs-review/flows/index.json'))).toBe(false);
  });

  it('isMockupsIndexDoc: schema_version 1 + screens[{key,file}]', () => {
    expect(isMockupsIndexDoc(INDEX)).toBe(true);
    expect(isMockupsIndexDoc({ schema_version: 1, screens: [] })).toBe(true);
    expect(isMockupsIndexDoc({ schema_version: 2, screens: [] })).toBe(false);
    expect(isMockupsIndexDoc({ schema_version: 1, screens: [{ key: 'A' }] })).toBe(false);
    expect(isMockupsIndexDoc([])).toBe(false);
    expect(isMockupsIndexDoc(null)).toBe(false);
  });

  it('withNavScript chèn script trước </body>, không có </body> thì nối đuôi; mockupLayoutOf ưu tiên data-layout', () => {
    expect(withNavScript('<body><p>a</p></body>')).toBe(`<body><p>a</p>${NAV_SCRIPT}</body>`);
    expect(withNavScript('<p>a</p>')).toBe(`<p>a</p>${NAV_SCRIPT}`);
    expect(mockupLayoutOf('<body data-layout="web">', { platform: 'mobile' })).toBe('web');
    expect(mockupLayoutOf(null, { platform: 'web' })).toBe('web');
    expect(mockupLayoutOf(null, {})).toBe('mobile');
    expect(mockupScreenPath('docs-review/mockups/', { file: 'mockups/SCR-003.html' })).toBe('docs-review/mockups/SCR-003.html');
    expect(mockupScreenPath('docs-review/mockups/', { file: 'SCR-001.html' })).toBe('docs-review/mockups/SCR-001.html');
  });
});

describe('MockupsPreview', () => {
  it('render rail đủ màn + iframe srcdoc màn đầu (có script điều hướng, sandbox allow-scripts, khung mobile) + link Mở HTML', async () => {
    const frame = (await renderPreview()) as HTMLIFrameElement;
    expect(screen.getByTestId('mockup-rail-SCR-001')).toBeTruthy();
    expect(screen.getByTestId('mockup-rail-SCR-002')).toBeTruthy();
    // Index có cả mobile lẫn web → rail chia tab; tab App mở trước (màn đầu là mobile), màn web nằm ở tab Web.
    expect(screen.queryByTestId('mockup-rail-SCR-003')).toBeNull();
    expect(screen.getByTestId('mockup-tab-App').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('mockup-tab-Web').textContent).toContain('1');
    expect(screen.getByTestId('mockup-title').textContent).toBe('Trang chủ');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('srcdoc')).toContain('data-screen="SCR-001"');
    expect(frame.getAttribute('srcdoc')).toContain('od-mockup-nav');
    expect(frame.getAttribute('data-layout')).toBe('mobile');
    expect((screen.getByTestId('mockup-open-html') as HTMLAnchorElement).getAttribute('href')).toBe('/api/projects/p/raw/docs-review/mockups/SCR-001.html');
    expect((screen.getByTestId('mockup-back') as HTMLButtonElement).disabled).toBe(true);
    // Badge đề xuất trên rail của màn proposed, không có ở màn thường.
    expect(screen.getByTestId('mockup-rail-SCR-002').textContent).toContain('đề xuất');
    expect(screen.getByTestId('mockup-rail-SCR-001').textContent).not.toContain('đề xuất');
  });

  it('postMessage od-mockup-nav đổi màn (badge đề xuất ở tiêu đề) và Quay lại trở về màn trước; key lạ bị bỏ qua', async () => {
    await renderPreview();
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'od-mockup-nav', key: 'SCR-002' } }));
    });
    const frame2 = await screen.findByTestId('mockup-frame');
    expect(screen.getByTestId('mockup-title').textContent).toBe('Chọn gói cước');
    expect(frame2.getAttribute('srcdoc')).toContain('data-screen="SCR-002"');
    expect(screen.getByTestId('mockup-title').parentElement?.textContent).toContain('đề xuất');
    expect((screen.getByTestId('mockup-back') as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'od-mockup-nav', key: 'SCR-999' } }));
    });
    expect(screen.getByTestId('mockup-title').textContent).toBe('Chọn gói cước');

    fireEvent.click(screen.getByTestId('mockup-back'));
    expect(screen.getByTestId('mockup-title').textContent).toBe('Trang chủ');
    expect((await screen.findByTestId('mockup-frame')).getAttribute('srcdoc')).toContain('data-screen="SCR-001"');
    expect((screen.getByTestId('mockup-back') as HTMLButtonElement).disabled).toBe(true);
  });

  it('chọn màn web trên rail → khung 100% (data-layout web); file ghi kèm tiền tố mockups/ vẫn tải đúng', async () => {
    await renderPreview();
    fireEvent.click(screen.getByTestId('mockup-tab-Web'));
    // Bấm tab → mở màn đầu của tab, rail chỉ còn màn web, Quay lại về màn cũ được.
    expect(screen.getByTestId('mockup-tab-Web').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId('mockup-rail-SCR-001')).toBeNull();
    fireEvent.click(screen.getByTestId('mockup-rail-SCR-003'));
    const frame = await screen.findByTestId('mockup-frame');
    expect(frame.getAttribute('srcdoc')).toContain('data-screen="SCR-003"');
    expect(frame.getAttribute('data-layout')).toBe('web');
    expect((screen.getByTestId('mockup-back') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('mockup-open-html') as HTMLAnchorElement).getAttribute('href')).toBe('/api/projects/p/raw/docs-review/mockups/SCR-003.html');
  });

  it('thiếu file màn → thông báo kèm đường dẫn, không dựng iframe', async () => {
    await renderPreview();
    fireEvent.click(screen.getByTestId('mockup-rail-SCR-404'));
    const msg = await screen.findByTestId('mockup-missing');
    expect(msg.textContent).toContain('docs-review/mockups/SCR-404.html');
    expect(screen.queryByTestId('mockup-frame')).toBeNull();
  });

  it('index hỏng / rỗng → thông báo thay vì crash', async () => {
    FILES['docs-review/mockups/index.json'] = '{không phải json';
    render(<MockupsPreview projectId="p" file={file('docs-review/mockups/index.json')} />);
    expect((await screen.findByText(/không phải JSON hợp lệ/)).textContent).toBeTruthy();
    cleanup();
    FILES['docs-review/mockups/index.json'] = JSON.stringify({ schema_version: 1, screens: [] });
    render(<MockupsPreview projectId="p" file={file('docs-review/mockups/index.json', 2)} />);
    expect(await screen.findByText(/Chưa có màn nào/)).toBeTruthy();
  });

  it('Toàn màn hình mở overlay portal, Esc đóng', async () => {
    await renderPreview();
    fireEvent.click(screen.getByTestId('mockup-fullscreen'));
    expect(screen.getByTestId('fs-overlay')).toBeTruthy();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('fs-overlay')).toBeNull();
  });
});

describe('MockupsPreview — tab App | Web', () => {
  it('điều hướng (postMessage) sang màn nền tảng kia tự chuyển tab; index một nền tảng → không có tab', async () => {
    const frame = (await renderPreview()) as HTMLIFrameElement;
    expect(screen.getByTestId('mockup-tab-App').getAttribute('aria-selected')).toBe('true');
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'od-mockup-nav', key: 'SCR-003' }, source: frame.contentWindow }));
    });
    const next = await screen.findByTestId('mockup-frame');
    expect(next.getAttribute('srcdoc')).toContain('data-screen="SCR-003"');
    expect(screen.getByTestId('mockup-tab-Web').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('mockup-rail-SCR-003')).toBeTruthy();
    expect(screen.queryByTestId('mockup-rail-SCR-001')).toBeNull();
    cleanup();

    FILES['docs-review/mockups/index.json'] = JSON.stringify({ ...INDEX, screens: INDEX.screens.filter((s) => s.platform === 'mobile') });
    render(<MockupsPreview projectId="p" file={file('docs-review/mockups/index.json', 2)} />);
    await screen.findByTestId('mockup-frame');
    expect(screen.queryByTestId('mockup-tab-App')).toBeNull();
    expect(screen.getByTestId('mockup-rail-SCR-001')).toBeTruthy();
    expect(screen.getByTestId('mockup-rail-SCR-002')).toBeTruthy();
  });
});
