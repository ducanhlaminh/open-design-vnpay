import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getWindowsFirmwareStatus,
  mapWindowsFirmwareGuidance,
  parseWindowsFirmwareDetection,
  restartWindowsToFirmware,
  writeWindowsFirmwarePendingState,
} from '../src/windows-system-setup.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('Windows firmware detection', () => {
  it('parses CIM JSON without depending on localized command text', () => {
    expect(parseWindowsFirmwareDetection(JSON.stringify({
      manufacturer: 'Dell Inc.', model: 'Latitude 5440', cpuManufacturer: 'GenuineIntel',
      virtualizationEnabled: false, virtualizationSupported: true, firmwareType: 'Uefi',
    }))).toEqual({
      manufacturer: 'Dell Inc.', model: 'Latitude 5440', cpuManufacturer: 'GenuineIntel',
      virtualizationEnabled: false, virtualizationSupported: true, firmwareType: 'uefi',
    });
  });

  it('returns a non-destructive unsupported response outside Windows', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'od-win-fw-')); dirs.push(dir);
    const runner = vi.fn();
    await expect(getWindowsFirmwareStatus(dir, { platform: 'darwin', runner })).resolves.toMatchObject({ supportedPlatform: false, detection: null, canRestartToFirmware: false });
    expect(runner).not.toHaveBeenCalled();
  });

  it('clears the persisted resume marker after virtualization is enabled', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'od-win-fw-')); dirs.push(dir);
    await writeWindowsFirmwarePendingState(dir, {
      phase: 'awaiting-bios-virtualization', manufacturer: 'Dell Inc.', model: 'Latitude', requestedAt: new Date().toISOString(),
    });
    const runner = vi.fn(async () => ({ stdout: JSON.stringify({
      manufacturer: 'Dell Inc.', model: 'Latitude', cpuManufacturer: 'GenuineIntel',
      virtualizationEnabled: true, virtualizationSupported: true, firmwareType: 'UEFI',
    }) }));
    const result = await getWindowsFirmwareStatus(dir, { platform: 'win32', runner });
    expect(result.pending).toBeNull();
    await expect(readFile(path.join(dir, 'system-setup', 'windows-firmware.json'), 'utf8')).rejects.toThrow();
  });
});

describe('vendor guidance', () => {
  it('distinguishes ThinkPad from consumer Lenovo models', () => {
    expect(mapWindowsFirmwareGuidance('LENOVO', 'ThinkPad T14').vendor).toBe('lenovo-think');
    expect(mapWindowsFirmwareGuidance('LENOVO', 'Yoga Slim 7').vendor).toBe('lenovo-consumer');
  });

  it('provides safe generic guidance for unknown manufacturers', () => {
    const result = mapWindowsFirmwareGuidance('Example Computer Corp');
    expect(result.vendor).toBe('generic');
    expect(result.settingNames.join(' ')).toContain('SVM');
  });
});

describe('restart-to-firmware safety', () => {
  it('persists resume state before invoking the injected shutdown runner', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'od-win-fw-')); dirs.push(dir);
    const runner = vi.fn(async () => {
      const stored = await readFile(path.join(dir, 'system-setup', 'windows-firmware.json'), 'utf8');
      expect(JSON.parse(stored).phase).toBe('awaiting-bios-virtualization');
      return { stdout: '' };
    });
    const detection = parseWindowsFirmwareDetection('{"manufacturer":"Dell Inc.","model":"Latitude","cpuManufacturer":"GenuineIntel","virtualizationEnabled":false,"virtualizationSupported":true,"firmwareType":"UEFI"}');
    const result = await restartWindowsToFirmware(dir, detection, { platform: 'win32', runner, now: () => new Date('2026-08-11T00:00:00Z') });
    expect(result.requestedAt).toBe('2026-08-11T00:00:00.000Z');
    expect(runner).toHaveBeenCalledWith('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      "Start-Process -FilePath 'shutdown.exe' -Verb RunAs -ArgumentList '/r','/fw','/t','5','/d','p:0:0'",
    ]);
  });

  it('never invokes a runner on non-Windows or legacy BIOS', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'od-win-fw-')); dirs.push(dir);
    const runner = vi.fn(async () => ({ stdout: '' }));
    const base = { manufacturer: 'PC', model: 'Model', cpuManufacturer: 'CPU', virtualizationEnabled: false, virtualizationSupported: true } as const;
    await expect(restartWindowsToFirmware(dir, { ...base, firmwareType: 'uefi' }, { platform: 'darwin', runner })).rejects.toThrow('WINDOWS_ONLY');
    await expect(restartWindowsToFirmware(dir, { ...base, firmwareType: 'bios' }, { platform: 'win32', runner })).rejects.toThrow('UEFI_REQUIRED');
    expect(runner).not.toHaveBeenCalled();
  });
});
