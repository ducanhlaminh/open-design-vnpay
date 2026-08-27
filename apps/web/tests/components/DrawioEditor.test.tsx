// @vitest-environment jsdom
//
// DrawioEditor (WP dr-flow-edit-highlight): prop `page` → URL param `page=N`
// của embed.diagrams.net (PoC: có hiệu lực với {action:'load'}), mặc định 0;
// `pageName` → chip trạng thái có tiền tố "Đang sửa: <trang> · …".
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { DrawioEditor, EMBED_URL } from '../../src/components/DrawioEditor';

afterEach(() => cleanup());

const XML = '<mxfile><diagram id="a" name="Nguyên bản"><mxGraphModel/></diagram><diagram id="b" name="Cải thiện"><mxGraphModel/></diagram></mxfile>';
const iframeOf = () => screen.getByTestId('drawio-editor').querySelector('iframe') as HTMLIFrameElement;

describe('DrawioEditor — page / pageName', () => {
  it('page={1} → iframe src = EMBED_URL + &page=1; chip "Đang sửa: Cải thiện · …" trước và sau init', () => {
    render(<DrawioEditor xml={XML} title="t" page={1} pageName="Cải thiện" onSave={async () => {}} />);
    const iframe = iframeOf();
    expect(iframe.src).toBe(`${EMBED_URL}&page=1`);
    expect(iframe.src).toContain('&page=1');
    expect(screen.getByRole('status').textContent).toBe('Đang sửa: Cải thiện · Đang mở editor…');
    const win = iframe.contentWindow as Window;
    const posted: string[] = [];
    win.postMessage = ((d: string) => {
      posted.push(d);
    }) as typeof win.postMessage;
    fireEvent(window, new MessageEvent('message', { data: JSON.stringify({ event: 'init' }), source: win }));
    // load nguyên mxfile — không sắp lại trang (daemon map theo index).
    expect(JSON.parse(posted[0]!)).toEqual({ action: 'load', xml: XML, autosave: 1 });
    expect(screen.getByRole('status').textContent).toBe('Đang sửa: Cải thiện · tự lưu');
  });

  it('mặc định page=0; không pageName → chip như cũ (không tiền tố)', () => {
    render(<DrawioEditor xml={XML} title="t" onSave={async () => {}} />);
    expect(iframeOf().src).toBe(`${EMBED_URL}&page=0`);
    expect(screen.getByTestId('drawio-editor').getAttribute('data-page')).toBe('0');
    expect(screen.getByRole('status').textContent).toBe('Đang mở editor…');
  });

  it('Ctrl+S (event save) → onSave; chip "Đang sửa: Cải thiện · Đã lưu ✓"', async () => {
    const onSave = vi.fn(async () => {});
    render(<DrawioEditor xml={XML} title="t" page={1} pageName="Cải thiện" onSave={onSave} />);
    const win = iframeOf().contentWindow as Window;
    win.postMessage = (() => {}) as typeof win.postMessage;
    fireEvent(window, new MessageEvent('message', { data: JSON.stringify({ event: 'save', xml: XML }), source: win }));
    expect(onSave).toHaveBeenCalledWith(XML);
    await screen.findByText('Đang sửa: Cải thiện · Đã lưu ✓');
  });
});
