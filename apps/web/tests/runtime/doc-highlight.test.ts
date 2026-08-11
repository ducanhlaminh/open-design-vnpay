// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  fuzzyRegex,
  highlightMatch,
  injectDeletedRuns,
  injectHighlights,
  quoteSegments,
} from '../../src/runtime/doc-highlight';

function setBody(html: string): HTMLElement {
  document.body.innerHTML = html;
  const el = document.body.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error('setBody: no root element');
  return el;
}

describe('fuzzyRegex', () => {
  it('matches tolerating whitespace/newline differences between quote and doc', () => {
    const re = fuzzyRegex('nhập  mã\nOTP');
    expect(re).not.toBeNull();
    expect(re!.test('Người dùng nhập mã OTP gồm 6 chữ số.')).toBe(true);
  });

  it('returns null for an empty or whitespace-only string', () => {
    expect(fuzzyRegex('')).toBeNull();
    expect(fuzzyRegex('   \n\t ')).toBeNull();
  });
});

describe('highlightMatch', () => {
  it('wraps the match when it sits inside a single text node', () => {
    const container = setBody('<p>Người dùng nhập OTP để xác thực.</p>');
    const re = fuzzyRegex('nhập OTP')!;
    const mark = highlightMatch(container, re, 'hl-class');
    expect(mark).not.toBeNull();
    expect(mark!.tagName).toBe('MARK');
    expect(mark!.className).toBe('hl-class');
    expect(mark!.textContent).toBe('nhập OTP');
    expect(container.querySelectorAll('mark').length).toBe(1);
  });

  it('wraps the match when it spans several text nodes (e.g. a <strong> in the middle)', () => {
    const container = setBody('<p>Người dùng nhập <strong>mã OTP</strong> gồm 6 chữ số.</p>');
    const re = fuzzyRegex('nhập mã OTP gồm')!;
    const mark = highlightMatch(container, re, 'hl-class');
    // The match straddles the plain text node and the <strong> text node, so
    // it wraps as more than one <mark> — assert the passage's full text is
    // covered instead of asserting a single element boundary.
    expect(mark).not.toBeNull();
    const marks = Array.from(container.querySelectorAll('mark'));
    expect(marks.length).toBeGreaterThan(0);
    const coveredText = marks.map((m) => m.textContent ?? '').join('');
    expect(coveredText.replace(/\s+/g, ' ')).toContain('nhập mã OTP gồm'.replace(/\s+/g, ' '));
  });

  it('returns null and leaves the DOM untouched when there is no match', () => {
    const container = setBody('<p>Không có gì liên quan ở đây.</p>');
    const before = container.innerHTML;
    const re = fuzzyRegex('cụm từ không tồn tại')!;
    const mark = highlightMatch(container, re, 'hl-class');
    expect(mark).toBeNull();
    expect(container.innerHTML).toBe(before);
    expect(container.querySelectorAll('mark').length).toBe(0);
  });

  it('attaches dataAttrs onto the mark element', () => {
    const container = setBody('<p>Đây là đoạn cần đánh dấu để kiểm tra.</p>');
    const re = fuzzyRegex('cần đánh dấu')!;
    const mark = highlightMatch(container, re, 'hl-class', { changeId: 'chg-1' });
    expect(mark).not.toBeNull();
    expect(mark!.getAttribute('data-change-id')).toBe('chg-1');
  });
});

// Real data measured on the URD page of Test_all_tinh_nang (13 changes): whole-
// quote matching against rendered text anchored 4/13; quoteSegments anchors
// 13/13 (15 highlighted regions) — see the docblock in doc-highlight.ts.
describe('quoteSegments', () => {
  it('splits two consecutive list-item lines into one segment each, bullet stripped', () => {
    const quote = '      - SCR-012 — Nhập Excel\n      - SCR-013 — Xuất Excel';
    expect(quoteSegments(quote)).toEqual(['SCR-012 — Nhập Excel', 'SCR-013 — Xuất Excel']);
  });

  it('splits a table row on "|" and "<br>", dropping the images entirely', () => {
    const quote =
      '| SCR-012 — Nhập Excel<br>![](attachments/a.png) | SCR-013 — Xuất Excel<br>![](attachments/b.png) |';
    expect(quoteSegments(quote)).toEqual(['SCR-012 — Nhập Excel', 'SCR-013 — Xuất Excel']);
  });

  it('keeps a table cell\'s trailing text as one segment when the row has a single cell', () => {
    const quote = 'Luồng thay thế AF-18 (Xuất Excel). |';
    expect(quoteSegments(quote)).toEqual(['Luồng thay thế AF-18 (Xuất Excel).']);
  });

  it('drops a fragment shorter than two words', () => {
    expect(quoteSegments('- OK')).toEqual([]);
  });
});

describe('injectHighlights', () => {
  it('chèn mark vào chuỗi HTML, không đụng nội dung bên trong thẻ', () => {
    const html = '<p>Người dùng nhập OTP.</p><img src="Người dùng nhập OTP.png">';
    const out = injectHighlights(html, [{ id: 'c1', text: 'Người dùng nhập OTP.' }], 'hl', 'background:red');
    expect(out.matched.has('c1')).toBe(true);
    // Chỉ bôi ở phần text; thuộc tính src phải nguyên vẹn.
    expect(out.html).toContain('<mark class="hl" data-change-id="c1" style="background:red">');
    expect(out.html).toContain('src="Người dùng nhập OTP.png"');
    expect((out.html.match(/<mark /g) ?? []).length).toBe(1);
  });

  it('khớp được đoạn TRẢI QUA nhiều thẻ và bọc từng phần', () => {
    // "AF-18 (Xuất Excel)" bị <strong> cắt làm đôi trong HTML đã render.
    const html = '<td>Luồng <strong>AF-18</strong> (Xuất Excel).</td>';
    const out = injectHighlights(html, [{ id: 'c2', text: 'Luồng AF-18 (Xuất Excel).' }], 'hl');
    expect(out.matched.has('c2')).toBe(true);
    // Nhiều mark cùng một data-change-id — phía gọi gom lại thành một chỗ sửa.
    expect((out.html.match(/data-change-id="c2"/g) ?? []).length).toBeGreaterThan(1);
    expect((out.html.match(/<mark /g) ?? []).length).toBe(
      (out.html.match(/<\/mark>/g) ?? []).length,
    );
  });

  it('không khớp thì id vắng mặt trong matched và HTML giữ nguyên', () => {
    const html = '<p>Nội dung khác hẳn.</p>';
    const out = injectHighlights(html, [{ id: 'c3', text: 'Chuỗi không tồn tại ở đây' }], 'hl');
    expect(out.matched.size).toBe(0);
    expect(out.html).toBe(html);
  });

  it('không đẻ ra mark rỗng và escape đúng ký tự HTML trong đoạn cần bôi', () => {
    const html = '<p>A &amp; B đã đổi</p>';
    const out = injectHighlights(html, [{ id: 'c4', text: 'A & B đã đổi' }], 'hl');
    expect(out.matched.has('c4')).toBe(true);
    expect(out.html).not.toMatch(/<mark[^>]*>\s*<\/mark>/);
  });

  it('màu đi theo TỪNG request khi request mang className/inlineStyle riêng', () => {
    // Thêm (xanh) và sửa (vàng) phải bôi trong CÙNG một lượt — xem docblock của
    // HighlightRequest.
    const html = '<p>Câu được thêm mới.</p><p>Câu được viết lại.</p>';
    const out = injectHighlights(
      html,
      [
        { id: 'a1', text: 'Câu được thêm mới.', className: 'hl-add', inlineStyle: 'background:green' },
        { id: 'e1', text: 'Câu được viết lại.' },
      ],
      'hl-edit',
      'background:amber',
    );
    expect(out.matched).toEqual(new Set(['a1', 'e1']));
    expect(out.html).toContain('<mark class="hl-add" data-change-id="a1" style="background:green">');
    // Request không mang override thì rơi về tham số thứ 3/4 — tương thích
    // ngược với mọi call site cũ.
    expect(out.html).toContain('<mark class="hl-edit" data-change-id="e1" style="background:amber">');
  });
});

describe('injectDeletedRuns', () => {
  it('chèn đoạn đã xoá NGAY SAU anchor, và KHÔNG bôi chính anchor', () => {
    const html = '<p>Người dùng nhập mã OTP. Hệ thống xác thực.</p>';
    const out = injectDeletedRuns(
      html,
      [{ id: 'd1', anchor: 'Người dùng nhập mã OTP.', text: 'Mật khẩu hết hạn sau 5 phút.' }],
      'hl-del',
      'background:red',
    );
    expect(out.matched.has('d1')).toBe(true);
    expect(out.html).toBe(
      '<p>Người dùng nhập mã OTP.' +
        '<mark class="hl-del" data-change-id="d1" data-op="del" style="background:red">' +
        '<del>Mật khẩu hết hạn sau 5 phút.</del></mark>' +
        ' Hệ thống xác thực.</p>',
    );
    // Anchor là chữ của bản ĐÃ SỬA, nó không bị sửa gì — bôi nó lên là nói sai.
    expect(out.html).not.toMatch(/<mark[^>]*>Người dùng nhập mã OTP\.<\/mark>/);
  });

  it('escape HTML trong đoạn đã xoá — `<` không được thành thẻ', () => {
    const html = '<p>Trạng thái đơn hàng đã cập nhật.</p>';
    const out = injectDeletedRuns(
      html,
      [{ id: 'd2', anchor: 'Trạng thái đơn hàng', text: 'Nếu <b>tổng tiền</b> < 50.000đ thì miễn phí' }],
      'hl-del',
    );
    expect(out.matched.has('d2')).toBe(true);
    expect(out.html).toContain('&lt;b&gt;tổng tiền&lt;/b&gt; &lt; 50.000đ');
    // Đúng một <del> do chúng ta sinh; không có thẻ <b> nào lọt vào DOM.
    expect((out.html.match(/<b>/g) ?? []).length).toBe(0);
    expect((out.html.match(/<del>/g) ?? []).length).toBe(1);
    // Không có inlineStyle thì không sinh thuộc tính style rỗng.
    expect(out.html).not.toContain('style=""');
  });

  it('gộp whitespace và cắt ở 220 ký tự, phần đầy đủ để dành cho thẻ lý do', () => {
    const html = '<p>Đoạn neo còn sống.</p>';
    const long = `${'a'.repeat(100)}\n\n  ${'b'.repeat(300)}`;
    const out = injectDeletedRuns(html, [{ id: 'd3', anchor: 'Đoạn neo', text: long }], 'hl-del');
    const inner = /<del>([^<]*)<\/del>/.exec(out.html)?.[1] ?? '';
    expect(inner.endsWith('…')).toBe(true);
    expect(inner.length).toBe(221); // 220 ký tự + dấu '…'
    // 220 = 100 chữ 'a' + 1 khoảng trắng (gộp từ '\n\n  ') + 119 chữ 'b'.
    expect(inner).toBe(`${'a'.repeat(100)} ${'b'.repeat(119)}…`);
  });

  it('anchor KHÔNG khớp: html nguyên vẹn và matched không chứa id', () => {
    const html = '<p>Nội dung khác hẳn.</p>';
    const out = injectDeletedRuns(
      html,
      [{ id: 'd4', anchor: 'Đoạn neo không tồn tại ở đây', text: 'Chữ cũ nào đó.' }],
      'hl-del',
    );
    expect(out.matched.has('d4')).toBe(false);
    expect(out.matched.size).toBe(0);
    expect(out.html).toBe(html);
  });

  it('anchor trải qua nhiều thẻ vẫn neo được, và chèn vào ĐÚNG khoảng text kết thúc match', () => {
    const html = '<td>Luồng <strong>AF-18</strong> (Xuất Excel).</td>';
    const out = injectDeletedRuns(
      html,
      [{ id: 'd5', anchor: 'Luồng AF-18 (Xuất Excel).', text: 'Luồng AF-19 (Nhập Excel).' }],
      'hl-del',
    );
    expect(out.matched.has('d5')).toBe(true);
    // Node mới nằm TRONG <td> (thừa hưởng ngữ cảnh inline của ô bảng), sau dấu
    // chấm cuối match — không rơi ra ngoài và phá cấu trúc khối.
    expect(out.html).toBe(
      '<td>Luồng <strong>AF-18</strong> (Xuất Excel).' +
        '<mark class="hl-del" data-change-id="d5" data-op="del"><del>Luồng AF-19 (Nhập Excel).</del></mark>' +
        '</td>',
    );
  });
});
