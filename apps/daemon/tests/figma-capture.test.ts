import { describe, expect, it } from 'vitest';

import {
  deriveCaptureScreens,
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
