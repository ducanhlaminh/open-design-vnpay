import { describe, expect, it } from 'vitest';

import {
  deriveCaptureScreens,
  resolveCaptureViewports,
  slugifyCaptureName,
} from '../src/figma-capture.js';

describe('deriveCaptureScreens', () => {
  it('falls back to one stateless capture per built screen page', () => {
    const screens = deriveCaptureScreens(['home', 'tim-chuyen-bay'], {});
    expect(screens).toEqual([
      { path: '/screens/home.html', name: '01 home' },
      { path: '/screens/tim-chuyen-bay.html', name: '02 tim chuyen bay' },
    ]);
  });

  it('declared capture.config.json screens win over the fallback', () => {
    const screens = deriveCaptureScreens(['home'], {
      screens: [
        {
          path: '/',
          name: '1 Tìm chuyến bay',
          states: [{ name: 'Khứ hồi', clicks: ['text=Khứ hồi'] }],
        },
      ],
    });
    expect(screens).toHaveLength(1);
    expect(screens[0]!.path).toBe('/');
    expect(screens[0]!.states?.[0]?.clicks).toEqual(['text=Khứ hồi']);
  });

  it('filters malformed entries instead of crashing the run', () => {
    const screens = deriveCaptureScreens(['home'], {
      screens: [{ path: '', name: '' } as never, { path: '/', name: 'OK' }],
    });
    expect(screens).toEqual([{ path: '/', name: 'OK' }]);
  });
});

describe('slugifyCaptureName', () => {
  it('slugs Vietnamese labels the same way the upstream capture CLI does', () => {
    expect(slugifyCaptureName('1 Tìm chuyến bay — Khứ hồi')).toBe('1-tim-chuyen-bay-khu-hoi');
    expect(slugifyCaptureName('Đặt vé')).toBe('dat-ve');
    expect(slugifyCaptureName('   ')).toBe('screens');
  });
});

describe('resolveCaptureViewports', () => {
  const base = { width: 390, height: 844 };

  it('responsive targets capture desktop + mobile by default', () => {
    expect(resolveCaptureViewports(undefined, true, base)).toEqual([
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]);
  });

  it('fixed-viewport targets capture only the base width', () => {
    expect(resolveCaptureViewports(undefined, false, base)).toEqual([{ width: 390, height: 844 }]);
  });

  it('an explicit capture.config.json viewports list overrides the target default', () => {
    expect(resolveCaptureViewports([1280], true, base)).toEqual([{ width: 1280, height: 900 }]);
    // invalid entries drop; an all-invalid list falls back to the target rule
    expect(resolveCaptureViewports(['x', -1], false, base)).toEqual([{ width: 390, height: 844 }]);
  });

  it('desktop-ish widths get the taller default height, keeping a taller base', () => {
    expect(resolveCaptureViewports(undefined, true, { width: 390, height: 1200 })).toEqual([
      { width: 1440, height: 1200 },
      { width: 390, height: 1200 },
    ]);
  });
});

describe('realIconNameForSlug', () => {
  it('exact slug → real Figma name; variant-suffixed slug → longest set-name prefix', async () => {
    const { realIconNameForSlug, compileCoreSlug } = await import('../src/figma-capture.js');
    const map = new Map([
      [compileCoreSlug('iPay / Divider'), 'iPay / Divider'],
      [compileCoreSlug('ic_lock'), 'ic_lock'],
      [compileCoreSlug('iPay / Illustration / Transaction Result Icon'), 'iPay / Illustration / Transaction Result Icon'],
      [compileCoreSlug('iPay / Illustration / Transaction Result Icon Special'), 'iPay / Illustration / Transaction Result Icon Special'],
    ]);
    expect(realIconNameForSlug('ipay-divider', map)).toBe('iPay / Divider');
    expect(realIconNameForSlug('ic-lock', map)).toBe('ic_lock');
    expect(realIconNameForSlug('ipay-illustration-transaction-result-icon-success', map)).toBe(
      'iPay / Illustration / Transaction Result Icon',
    );
    expect(realIconNameForSlug('ipay-illustration-transaction-result-icon-special-success', map)).toBe(
      'iPay / Illustration / Transaction Result Icon Special',
    );
    expect(realIconNameForSlug('khong-ton-tai', map)).toBeNull();
  });
});
