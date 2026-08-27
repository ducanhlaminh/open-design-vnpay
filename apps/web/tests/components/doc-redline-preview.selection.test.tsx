// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SelectionSafeHtmlChunk } from '../../src/components/DocRedlinePreview';

describe('DocRedlinePreview text selection DOM', () => {
  it('parses sanitized HTML off-DOM instead of assigning innerHTML to the live React wrapper', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    if (!descriptor?.get || !descriptor.set) throw new Error('jsdom innerHTML descriptor missing');
    const liveDivWrites: Element[] = [];
    const setter = vi.spyOn(Element.prototype, 'innerHTML', 'set').mockImplementation(function (this: Element, value: string) {
      if (this instanceof HTMLDivElement && this.isConnected) liveDivWrites.push(this);
      descriptor.set!.call(this, value);
    });

    try {
      const view = render(<SelectionSafeHtmlChunk className="chunk" html="<p>Đoạn đầu</p><table><tbody><tr><td>Đoạn cần chọn</td></tr></tbody></table>" />);
      const host = view.container.querySelector('.chunk');
      expect(host?.querySelector('td')?.textContent).toBe('Đoạn cần chọn');
      expect(liveDivWrites).toEqual([]);

      view.rerender(<SelectionSafeHtmlChunk className="chunk" html="<p>Đoạn đã cập nhật</p>" />);
      expect(host?.textContent).toBe('Đoạn đã cập nhật');
      expect(liveDivWrites).toEqual([]);
    } finally {
      setter.mockRestore();
    }
  });
});
