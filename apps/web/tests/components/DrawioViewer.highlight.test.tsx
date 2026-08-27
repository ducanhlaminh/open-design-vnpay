// @vitest-environment jsdom
//
// DrawioViewer (WP dr-flow-edit-highlight): bảng viền theo loại thay đổi —
// HIGHLIGHT_KIND_STYLE khớp CHANGE_STYLE daemon (stroke #1B7F3B / #B7791F /
// #C0392B, removed nét đứt, width 5) và khác hẳn palette template dr-flow;
// id trần / thiếu kind → viền accent #0066b3 width 4. Không cần mxGraph thật.
import { describe, expect, it } from 'vitest';

import { HIGHLIGHT_DEFAULT_STYLE, HIGHLIGHT_KIND_STYLE, highlightStyleOf } from '../../src/components/DrawioViewer';

const TEMPLATE_PALETTE = ['#82b366', '#6c8ebf', '#666666', '#b85450', '#9e9e9e', '#d5e8d4', '#fff2cc', '#f8cecc'];

describe('DrawioViewer — HIGHLIGHT_KIND_STYLE / highlightStyleOf', () => {
  it('kind → (color, width, dashed) đúng bảng; khác palette template', () => {
    expect(HIGHLIGHT_KIND_STYLE).toEqual({
      added: { color: '#1B7F3B', width: 5, dashed: false },
      modified: { color: '#B7791F', width: 5, dashed: false },
      removed: { color: '#C0392B', width: 5, dashed: true },
    });
    for (const k of Object.values(HIGHLIGHT_KIND_STYLE)) expect(TEMPLATE_PALETTE).not.toContain(k.color.toLowerCase());
    expect(HIGHLIGHT_DEFAULT_STYLE).toEqual({ color: '#0066b3', width: 4, dashed: false });
  });

  it('highlightStyleOf: string / {id} → accent; {id, kind} → theo loại', () => {
    expect(highlightStyleOf('s1')).toEqual({ id: 's1', style: HIGHLIGHT_DEFAULT_STYLE });
    expect(highlightStyleOf({ id: 's2' })).toEqual({ id: 's2', style: HIGHLIGHT_DEFAULT_STYLE });
    expect(highlightStyleOf({ id: 'n1', kind: 'added' })).toEqual({ id: 'n1', style: HIGHLIGHT_KIND_STYLE.added });
    expect(highlightStyleOf({ id: 'n2', kind: 'modified' }).style.color).toBe('#B7791F');
    expect(highlightStyleOf({ id: 'n3', kind: 'removed' }).style).toEqual({ color: '#C0392B', width: 5, dashed: true });
  });
});
