// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installMockOpenDesignHost } from '@open-design/host/testing';
import { detectInitialLocale } from '../../src/i18n';

const LS_KEY = 'open-design:locale';
const LS_SOURCE_KEY = 'open-design:locale-source';

function setStoredLocale(locale: string, source: 'manual' | 'untagged' = 'manual'): void {
  window.localStorage.setItem(LS_KEY, locale);
  if (source === 'manual') {
    window.localStorage.setItem(LS_SOURCE_KEY, 'manual');
  } else {
    window.localStorage.removeItem(LS_SOURCE_KEY);
  }
}

function setNavigatorLanguages(languages: readonly string[]): void {
  Object.defineProperty(window.navigator, 'languages', {
    configurable: true,
    get: () => languages,
  });
  Object.defineProperty(window.navigator, 'language', {
    configurable: true,
    get: () => languages[0] ?? 'en',
  });
}

// Track the installed mock so each test can swap it out without leaking
// state into the next case (installMockOpenDesignHost returns an
// uninstall callback that restores the previous value).
let uninstallHost: (() => void) | null = null;

function installHostWithOsLocale(value: unknown): void {
  uninstallHost?.();
  uninstallHost = installMockOpenDesignHost({
    host: {
      // The mock host's defaultHost() already sets client.type to
      // 'desktop'; we only override the field exercised here.
      client: { osLocale: value as string | undefined },
    },
  });
}

function clearHost(): void {
  uninstallHost?.();
  uninstallHost = null;
}

describe('detectInitialLocale priority chain', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearHost();
    setNavigatorLanguages(['en-US']);
  });

  afterEach(() => {
    window.localStorage.clear();
    clearHost();
  });

  it('prefers a manually-tagged localStorage pick over host and navigator', () => {
    setStoredLocale('ja', 'manual');
    installHostWithOsLocale('zh-CN');
    setNavigatorLanguages(['fr-FR']);

    expect(detectInitialLocale()).toBe('ja');
  });

  it('ignores an untagged localStorage value and keeps Vietnamese as the default', () => {
    setStoredLocale('ja', 'untagged');
    installHostWithOsLocale('zh-CN');

    expect(detectInitialLocale()).toBe('vi');
  });

  it('keeps Vietnamese when a stored manual locale is unsupported', () => {
    setStoredLocale('xx-YY', 'manual');
    setNavigatorLanguages(['de-DE']);

    expect(detectInitialLocale()).toBe('vi');
  });

  it('does not use the desktop host OS locale without a manual pick', () => {
    installHostWithOsLocale('zh-CN');
    setNavigatorLanguages(['en-US']);

    expect(detectInitialLocale()).toBe('vi');
  });

  it('does not use packaged OS locale strings without a manual pick', () => {
    installHostWithOsLocale('zh-Hant-TW');
    setNavigatorLanguages(['en-US']);

    expect(detectInitialLocale()).toBe('vi');
  });

  it('does not use browser languages when host osLocale is missing or invalid', () => {
    installHostWithOsLocale(undefined);
    setNavigatorLanguages(['ko-KR']);
    expect(detectInitialLocale()).toBe('vi');

    installHostWithOsLocale(42);
    setNavigatorLanguages(['fr-FR']);
    expect(detectInitialLocale()).toBe('vi');
  });

  it('keeps Vietnamese when host osLocale is outside the supported set', () => {
    installHostWithOsLocale('nl-NL');
    setNavigatorLanguages(['pt-PT']);

    expect(detectInitialLocale()).toBe('vi');
  });

  it('falls back to vi (this fork is Vietnamese-first) when nothing else is available', () => {
    clearHost();
    // An unsupported locale, not an empty array: setNavigatorLanguages([])
    // makes the test helper's navigator.language default to 'en', which is
    // itself a supported locale and would short-circuit resolveSystemLocale
    // before ever reaching the final fallback this test means to exercise.
    setNavigatorLanguages(['xx-YY']);

    expect(detectInitialLocale()).toBe('vi');
  });
});
