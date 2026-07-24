// The system-map shape sniff. SpecFileViewer runs EVERY json file through a
// chain of recognizers, so a sniff that is too loose steals another stage's
// document and renders it as the wrong thing.
import { describe, expect, it } from 'vitest';

import { isSystemMapDoc } from '../../src/components/SystemMapPreview';

const MAP = {
  system: { name: 'PMKT', summary: 'Cổng khuyến mãi' },
  apps: [
    { id: 'web-user', name: 'PMKT Portal', audience: 'user', responsibility: 'Khách đăng ký ưu đãi' },
    { id: 'sso', name: 'Identity', external: true, responsibility: 'Xác thực' },
  ],
  documents: [
    { file: 'docs/confluence/2.-Dang-nhap.md', apps: ['web-user'], why: 'mô tả màn đăng nhập', confidence: 'high' },
  ],
  handoffs: [
    { from: 'web-user', to: 'sso', trigger: 'Bấm đăng nhập', data: 'redirect + client_id' },
  ],
};

describe('isSystemMapDoc', () => {
  it('accepts a full map', () => {
    expect(isSystemMapDoc(MAP)).toBe(true);
  });

  it('accepts a map with hand-offs but no documents yet, and vice versa', () => {
    expect(isSystemMapDoc({ ...MAP, documents: [] })).toBe(true);
    expect(isSystemMapDoc({ ...MAP, handoffs: [] })).toBe(true);
  });

  it('rejects a map with apps only — that alone is not enough to claim the file', () => {
    expect(isSystemMapDoc({ apps: MAP.apps })).toBe(false);
    expect(isSystemMapDoc({ apps: MAP.apps, documents: [], handoffs: [] })).toBe(false);
  });

  it('does not steal a ux-spec, a customer journey or a research report', () => {
    expect(isSystemMapDoc({ screens: [{ id: 'SCR-1', name: 'Đăng nhập', components: [] }] })).toBe(false);
    expect(isSystemMapDoc({ journeys: [{ id: 'CJ-1', stages: [] }] })).toBe(false);
    expect(isSystemMapDoc({ criteria: [{ statement: 'x', sources: [] }] })).toBe(false);
  });

  it('rejects non-objects and arrays', () => {
    for (const v of [null, undefined, 'x', 7, [MAP]]) expect(isSystemMapDoc(v)).toBe(false);
  });
});
