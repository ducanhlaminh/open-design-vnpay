// ds-lab / lab-shell (WP-lab-shell, 2026-08-23 — .tmp/pipeline/wp-lab-shell.yaml)
// red-spec: module THUẦN — bảng SHELL_RULES cố định, detectShellBindings
// (kit thắng DS, tên bắt đầu thắng tên chứa, role không khớp bị bỏ, catalog
// null → chỉ kit), detectShellRolesInSubtree (dò app-bar/tabbar theo tên, bỏ
// nhánh ẩn, không dò role khác).

import { describe, expect, it } from 'vitest';

import {
  detectShellBindings,
  detectShellRolesInSubtree,
  AUDITABLE_SHELL_ROLES,
  SHELL_KIND_NAME_PATTERNS,
  SHELL_KINDS,
  SHELL_ROLE_CATALOG_PATTERNS,
  SHELL_ROLE_NODE_PATTERNS,
  SHELL_ROLES,
  SHELL_RULES,
} from '../src/lab-shell.js';

// ── SHELL_KINDS / SHELL_ROLES / SHELL_RULES ─────────────────────────────────

describe('SHELL_KINDS / SHELL_ROLES', () => {
  it('has exactly the 6 kinds and 6 roles the spec fixes', () => {
    expect(SHELL_KINDS).toEqual(['root', 'child', 'sheet', 'modal', 'result', 'fullscreen']);
    expect(SHELL_ROLES).toEqual(['app-bar', 'tabbar', 'back', 'close', 'primary-cta', 'search']);
  });
});

describe('SHELL_RULES', () => {
  it('matches the fixed must/should/avoid table for all 6 kinds', () => {
    expect(SHELL_RULES.root).toEqual({ must: ['tabbar'], should: ['search'], avoid: ['back'] });
    expect(SHELL_RULES.child).toEqual({ must: ['app-bar', 'back'], should: [], avoid: ['tabbar'] });
    expect(SHELL_RULES.sheet).toEqual({ must: [], should: ['close'], avoid: ['app-bar', 'tabbar'] });
    expect(SHELL_RULES.modal).toEqual({ must: ['close'], should: [], avoid: ['app-bar', 'tabbar'] });
    expect(SHELL_RULES.result).toEqual({ must: ['primary-cta'], should: [], avoid: ['back', 'tabbar'] });
    expect(SHELL_RULES.fullscreen).toEqual({ must: ['close'], should: [], avoid: ['tabbar'] });
  });

  it('every kind in SHELL_KINDS has a rule entry, and only those kinds', () => {
    expect(Object.keys(SHELL_RULES).sort()).toEqual([...SHELL_KINDS].sort());
  });
});

describe('SHELL_KIND_NAME_PATTERNS', () => {
  it('does not include root/child (those are derived from the flow graph, not text)', () => {
    const kinds = SHELL_KIND_NAME_PATTERNS.map((p) => p.kind);
    expect(kinds).not.toContain('root');
    expect(kinds).not.toContain('child');
    expect(kinds.sort()).toEqual(['fullscreen', 'modal', 'result', 'sheet'].sort());
  });

  it('matches representative names for each of the 4 derivable kinds', () => {
    const find = (name: string) => SHELL_KIND_NAME_PATTERNS.find((p) => p.re.test(name))?.kind;
    expect(find('Bottom sheet chọn gói')).toBe('sheet');
    expect(find('Xác nhận xoá tài khoản')).toBe('modal');
    expect(find('Kết quả thanh toán')).toBe('result');
    expect(find('Quét mã QR')).toBe('fullscreen');
    expect(find('Trang chủ')).toBeUndefined();
  });
});

describe('SHELL_ROLE_NODE_PATTERNS / AUDITABLE_SHELL_ROLES', () => {
  it('only has app-bar and tabbar (the two deterministically detectable roles)', () => {
    expect(Object.keys(SHELL_ROLE_NODE_PATTERNS).sort()).toEqual(['app-bar', 'tabbar'].sort());
    expect(AUDITABLE_SHELL_ROLES.slice().sort()).toEqual(['app-bar', 'tabbar'].sort());
  });
});

describe('SHELL_ROLE_CATALOG_PATTERNS', () => {
  it('has all 6 roles (broader than the node-detection patterns)', () => {
    expect(Object.keys(SHELL_ROLE_CATALOG_PATTERNS).sort()).toEqual([...SHELL_ROLES].sort());
  });
});

// ── detectShellBindings ──────────────────────────────────────────────────────

describe('detectShellBindings', () => {
  it('kit wins over DS when both have a matching component name', () => {
    const catalog = {
      files: [{ components: [{ name: 'App Bar / Default', key: 'ds-key-1', nodeId: '1:1' }] }],
    };
    const kit = [{ name: 'App Bar (Kit)', componentNodeId: '9:9' }];
    const bindings = detectShellBindings(catalog, kit);
    const appBar = bindings.find((b) => b.role === 'app-bar');
    expect(appBar).toMatchObject({ role: 'app-bar', from: 'kit', nodeId: '9:9', name: 'App Bar (Kit)' });
  });

  it('falls back to DS catalog when kit has no match for the role', () => {
    const catalog = {
      files: [{ components: [{ name: 'App Bar / Default', key: 'ds-key-1', nodeId: '1:1' }] }],
    };
    const bindings = detectShellBindings(catalog, []);
    const appBar = bindings.find((b) => b.role === 'app-bar');
    expect(appBar).toMatchObject({ role: 'app-bar', from: 'ds', key: 'ds-key-1', nodeId: '1:1' });
  });

  it('prefers a component name that STARTS WITH the matched cluster over one that only CONTAINS it', () => {
    const catalog = {
      files: [
        {
          components: [
            { name: 'Custom App Bar Wrapper', key: 'contains', nodeId: '2:2' },
            { name: 'App Bar / Default', key: 'starts-with', nodeId: '1:1' },
          ],
        },
      ],
    };
    const bindings = detectShellBindings(catalog, []);
    const appBar = bindings.find((b) => b.role === 'app-bar');
    expect(appBar?.key).toBe('starts-with');
  });

  it('a role with no match in kit nor DS catalog is dropped (no entry)', () => {
    const catalog = { files: [{ components: [{ name: 'Radio Button', key: 'radio', nodeId: '1:1' }] }] };
    const bindings = detectShellBindings(catalog, []);
    expect(bindings.find((b) => b.role === 'tabbar')).toBeUndefined();
    expect(bindings.find((b) => b.role === 'search')).toBeUndefined();
  });

  it('catalog null → only kit bindings are considered', () => {
    const kit = [{ name: 'Tab Bar', componentNodeId: '3:3' }];
    const bindings = detectShellBindings(null, kit);
    expect(bindings).toEqual([{ role: 'tabbar', name: 'Tab Bar', nodeId: '3:3', from: 'kit' }]);
  });

  it('detects all 6 roles from a rich catalog', () => {
    const catalog = {
      files: [
        {
          components: [
            { name: 'App Bar', key: 'k1', nodeId: '1:1' },
            { name: 'Tab Bar', key: 'k2', nodeId: '1:2' },
            { name: 'Back Button', key: 'k3', nodeId: '1:3' },
            { name: 'Close Button', key: 'k4', nodeId: '1:4' },
            { name: 'Button / Primary', key: 'k5', nodeId: '1:5' },
            { name: 'Search Bar', key: 'k6', nodeId: '1:6' },
          ],
        },
      ],
    };
    const bindings = detectShellBindings(catalog, []);
    expect(bindings.map((b) => b.role).sort()).toEqual([...SHELL_ROLES].sort());
  });
});

// ── detectShellRolesInSubtree ────────────────────────────────────────────────

describe('detectShellRolesInSubtree', () => {
  it('detects app-bar and tabbar by node name', () => {
    const node = {
      id: '1:1',
      type: 'FRAME',
      name: 'SCR-01',
      visible: true,
      children: [
        { id: '1:2', type: 'INSTANCE', name: 'App Bar', visible: true },
        { id: '1:3', type: 'INSTANCE', name: 'Tab Bar', visible: true },
      ],
    };
    const roles = detectShellRolesInSubtree(node);
    expect(roles.has('app-bar')).toBe(true);
    expect(roles.has('tabbar')).toBe(true);
    expect(roles.size).toBe(2);
  });

  it('ignores a hidden branch (node itself hidden, or an ancestor hidden)', () => {
    const selfHidden = {
      id: '1:1',
      type: 'FRAME',
      name: 'SCR-01',
      visible: true,
      children: [{ id: '1:2', type: 'INSTANCE', name: 'App Bar', visible: false }],
    };
    expect(detectShellRolesInSubtree(selfHidden).size).toBe(0);

    const ancestorHidden = {
      id: '1:1',
      type: 'FRAME',
      name: 'SCR-01',
      visible: true,
      children: [
        {
          id: '1:2',
          type: 'GROUP',
          name: 'Hidden group',
          visible: false,
          children: [{ id: '1:3', type: 'INSTANCE', name: 'Tab Bar', visible: true }],
        },
      ],
    };
    expect(detectShellRolesInSubtree(ancestorHidden).size).toBe(0);
  });

  it('does not detect any role other than app-bar/tabbar (e.g. a "Back Button" node)', () => {
    const node = {
      id: '1:1',
      type: 'FRAME',
      name: 'SCR-01',
      visible: true,
      children: [{ id: '1:2', type: 'INSTANCE', name: 'Back Button', visible: true }],
    };
    expect(detectShellRolesInSubtree(node).size).toBe(0);
  });

  it('non-record input returns an empty set without throwing', () => {
    expect(() => detectShellRolesInSubtree(null)).not.toThrow();
    expect(detectShellRolesInSubtree(null).size).toBe(0);
  });
});

// Review WP-lab-shell: "kết quả"/"result" trần KHÔNG được suy thành `result`
// — "Kết quả tìm kiếm"/"Search results" là màn danh sách (child), nếu suy
// thành result sẽ bắt màn đó tránh back + phải primary-cta (sai hoàn toàn).
describe('SHELL_KIND_NAME_PATTERNS: "kết quả tìm kiếm" không phải result', () => {
  it('không khớp kind nào cho "Kết quả tìm kiếm" / "Search results"', () => {
    const find = (name: string) => SHELL_KIND_NAME_PATTERNS.find((p) => p.re.test(name))?.kind ?? null;
    expect(find('Kết quả tìm kiếm')).toBeNull();
    expect(find('Search results')).toBeNull();
    expect(find('Kết quả giao dịch')).toBe('result');
    expect(find('Thanh toán thành công')).toBe('result');
  });
});
