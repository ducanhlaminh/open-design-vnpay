import { describe, expect, it } from 'vitest';

import { readRuntimeVersion } from '../src/components/EntryHelpMenu';

describe('readRuntimeVersion', () => {
  it('reads the host-runtime version response', () => {
    expect(readRuntimeVersion({ version: { version: '0.8.21', platform: 'win32' } })).toBe('0.8.21');
  });

  it('supports a legacy flat version response', () => {
    expect(readRuntimeVersion({ version: '0.8.21' })).toBe('0.8.21');
  });

  it('rejects missing or malformed versions', () => {
    expect(readRuntimeVersion(null)).toBeNull();
    expect(readRuntimeVersion({ version: {} })).toBeNull();
  });
});
