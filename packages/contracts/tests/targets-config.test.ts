import { describe, expect, it } from 'vitest';

import { UI_TARGETS, buildTargetsConfig } from '../src/api/pipelines.js';

describe('multi-target contracts', () => {
  it('every target ships web tech — responsive splits the websites from the fixed-viewport app', () => {
    // The locked product decision (2026-07-28): NO native/RN track. The mobile
    // app renders in a fixed phone viewport; both websites must be responsive.
    expect(UI_TARGETS.mobile.responsive).toBe(false);
    expect(UI_TARGETS['web-user'].responsive).toBe(true);
    expect(UI_TARGETS['web-backoffice'].responsive).toBe(true);
  });

  it('buildTargetsConfig emits v2 with responsive + per-target design systems', () => {
    const cfg = buildTargetsConfig(['mobile', 'web-user'], {
      mobile: 'ds-ipay-mobile',
      'web-user': 'ds-web-lib',
      // An entry for a target NOT picked must not leak into the file.
      'web-backoffice': 'ds-bo-lib',
    });
    expect(cfg.kind).toBe('od-targets');
    expect(cfg.version).toBe(2);
    expect(cfg.targets).toEqual(['mobile', 'web-user']);
    expect(cfg.platformByTarget).toEqual({ mobile: 'mobile', 'web-user': 'web' });
    expect(cfg.audienceByTarget).toEqual({ mobile: 'user', 'web-user': 'user' });
    expect(cfg.responsiveByTarget).toEqual({ mobile: false, 'web-user': true });
    expect(cfg.designSystemByTarget).toEqual({
      mobile: 'ds-ipay-mobile',
      'web-user': 'ds-web-lib',
    });
  });

  it('omits designSystemByTarget entirely when no per-target DS was picked', () => {
    const cfg = buildTargetsConfig(['mobile']);
    expect(cfg.designSystemByTarget).toBeUndefined();
    expect(cfg.responsiveByTarget).toEqual({ mobile: false });
  });
});
