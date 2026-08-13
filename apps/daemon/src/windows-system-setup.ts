import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  WindowsFirmwareDetection,
  WindowsFirmwareGuidance,
  WindowsFirmwarePendingState,
  WindowsFirmwareStatusResponse,
  WindowsFirmwareVendor,
} from '@open-design/contracts';

const execFileAsync = promisify(execFile);

const DETECTION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$computer = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$firmware = 'unknown'
$computerInfoVirtualization = $null
try {
  $computerInfo = Get-ComputerInfo -Property BiosFirmwareType,HyperVRequirementVirtualizationFirmwareEnabled
  $firmwareValue = $computerInfo.BiosFirmwareType
  if ($null -ne $firmwareValue) { $firmware = $firmwareValue.ToString().ToLowerInvariant() }
  $computerInfoVirtualization = $computerInfo.HyperVRequirementVirtualizationFirmwareEnabled
} catch {}
$virtualizationEnabled = $cpu.VirtualizationFirmwareEnabled
# Win32_Processor can incorrectly stay False on some Windows 11 machines even
# while VT is working. HypervisorPresent is definitive positive evidence; the
# ComputerInfo requirement is a second firmware source when no hypervisor is
# active. Never let either source's stale False override a positive source.
if ($computer.HypervisorPresent -eq $true -or $computerInfoVirtualization -eq $true) {
  $virtualizationEnabled = $true
}
[PSCustomObject]@{
  manufacturer = [string]$computer.Manufacturer
  model = [string]$computer.Model
  cpuManufacturer = [string]$cpu.Manufacturer
  virtualizationEnabled = $virtualizationEnabled
  virtualizationSupported = $cpu.SecondLevelAddressTranslationExtensions
  hypervisorPresent = $computer.HypervisorPresent
  computerInfoVirtualization = $computerInfoVirtualization
  firmwareType = $firmware
} | ConvertTo-Json -Compress
`;

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function parseWindowsFirmwareDetection(output: string): WindowsFirmwareDetection {
  const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
  const firmware = String(parsed.firmwareType ?? '').toLowerCase();
  const virtualizationEnabled =
    parsed.hypervisorPresent === true || parsed.computerInfoVirtualization === true
      ? true
      : nullableBoolean(parsed.virtualizationEnabled);
  return {
    manufacturer: String(parsed.manufacturer ?? '').trim() || 'Unknown',
    model: String(parsed.model ?? '').trim() || 'Unknown',
    cpuManufacturer: String(parsed.cpuManufacturer ?? '').trim() || 'Unknown',
    virtualizationEnabled,
    virtualizationSupported: nullableBoolean(parsed.virtualizationSupported),
    firmwareType: firmware.includes('uefi') ? 'uefi' : firmware.includes('bios') ? 'bios' : 'unknown',
  };
}

const guidance = (
  vendor: WindowsFirmwareVendor,
  displayName: string,
  biosKeys: string[],
  menuPaths: string[],
  settingNames: string[],
  notes: string[] = [],
  supportUrl?: string,
): WindowsFirmwareGuidance => ({ vendor, displayName, biosKeys, menuPaths, settingNames, notes, ...(supportUrl ? { supportUrl } : {}) });

/** Maps CIM manufacturer/model text to conservative, user-facing firmware guidance. */
export function mapWindowsFirmwareGuidance(manufacturer: string, model = ''): WindowsFirmwareGuidance {
  const maker = manufacturer.toLowerCase();
  const machine = model.toLowerCase();
  if (maker.includes('dell') || maker.includes('alienware')) {
    return guidance('dell', 'Dell / Alienware', ['F2'], ['Virtualization Support → Virtualization', 'Advanced → Virtualization'], ['Intel Virtualization Technology', 'SVM Mode'], ['Nhấn F2 liên tục khi logo Dell xuất hiện.'], 'https://www.dell.com/support/kbdoc/000195978');
  }
  if (maker.includes('hewlett') || maker === 'hp' || maker.startsWith('hp ')) {
    return guidance('hp', 'HP', ['F10', 'Esc rồi F10'], ['Advanced → System Options', 'Configuration'], ['Virtualization Technology (VTx)', 'Virtualization Technology'], ['Nhấn Esc hoặc F10 liên tục khi logo HP xuất hiện.'], 'https://support.hp.com/document/ish_5637142-5637191-16');
  }
  if (maker.includes('lenovo')) {
    const think = /thinkpad|thinkcentre|thinkstation/.test(machine);
    return think
      ? guidance('lenovo-think', 'Lenovo ThinkPad / ThinkCentre', ['F1', 'Enter rồi F1'], ['Security → Virtualization'], ['Intel Virtualization Technology', 'AMD V(TM) Technology'], [], 'https://support.lenovo.com/solutions/ht500006')
      : guidance('lenovo-consumer', 'Lenovo IdeaPad / Yoga', ['F2', 'Fn+F2', 'Nút Novo'], ['Configuration'], ['Intel Virtual Technology', 'SVM Mode'], [], 'https://support.lenovo.com/solutions/ht500006');
  }
  if (maker.includes('acer')) return guidance('acer', 'Acer', ['F2'], ['Advanced'], ['Intel VTX', 'SVM Mode'], [], 'https://community.acer.com/en/kb/articles/14750');
  if (maker.includes('asus')) return guidance('asus', 'ASUS', ['F2', 'Del'], ['Advanced → CPU Configuration'], ['Intel (VMX) Virtualization Technology', 'SVM Mode'], [], 'https://www.asus.com/support/faq/1043786/');
  if (maker.includes('micro-star') || maker.includes('msi')) return guidance('msi', 'MSI', ['Del'], ['OC → CPU Features', 'Advanced → CPU Configuration'], ['SVM Mode', 'Intel Virtualization Tech']);
  if (maker.includes('gigabyte')) return guidance('gigabyte', 'Gigabyte', ['Del'], ['Tweaker → Advanced CPU Settings', 'Settings → Miscellaneous'], ['SVM Mode', 'Intel Virtualization Technology']);
  if (maker.includes('microsoft')) return guidance('microsoft', 'Microsoft Surface', ['Giữ Volume Up rồi bấm Power'], ['UEFI → Security', 'UEFI → Devices'], ['Virtualization'], ['Giữ Volume Up cho đến khi màn hình UEFI xuất hiện.']);
  return guidance('generic', manufacturer.trim() || 'Máy Windows', ['F2', 'Del', 'F10', 'Esc'], ['Advanced', 'Security', 'CPU Configuration'], ['Intel Virtualization Technology (VT-x/VMX)', 'AMD SVM/AMD-V'], ['Tên menu thay đổi theo model; hãy tìm mục Virtualization, VT-x, VMX hoặc SVM.']);
}

export type WindowsSystemRunner = (file: string, args: string[]) => Promise<{ stdout: string }>;

const defaultRunner: WindowsSystemRunner = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, { timeout: 30_000, windowsHide: true });
  return { stdout };
};

export async function detectWindowsFirmware(runner: WindowsSystemRunner = defaultRunner): Promise<WindowsFirmwareDetection> {
  const { stdout } = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', DETECTION_SCRIPT]);
  return parseWindowsFirmwareDetection(stdout);
}

const pendingPath = (dataDir: string) => path.join(dataDir, 'system-setup', 'windows-firmware.json');

export async function readWindowsFirmwarePendingState(dataDir: string): Promise<WindowsFirmwarePendingState | null> {
  try {
    const value = JSON.parse(await readFile(pendingPath(dataDir), 'utf8')) as WindowsFirmwarePendingState;
    return value?.phase === 'awaiting-bios-virtualization' ? value : null;
  } catch {
    return null;
  }
}

export async function writeWindowsFirmwarePendingState(dataDir: string, state: WindowsFirmwarePendingState): Promise<void> {
  const target = pendingPath(dataDir);
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}

export async function clearWindowsFirmwarePendingState(dataDir: string): Promise<void> {
  await rm(pendingPath(dataDir), { force: true });
}

export async function getWindowsFirmwareStatus(
  dataDir: string,
  options: { platform?: NodeJS.Platform; runner?: WindowsSystemRunner } = {},
): Promise<WindowsFirmwareStatusResponse> {
  const platform = options.platform ?? process.platform;
  const pending = await readWindowsFirmwarePendingState(dataDir);
  if (platform !== 'win32') return { supportedPlatform: false, detection: null, guidance: null, pending, canRestartToFirmware: false };
  const detection = await detectWindowsFirmware(options.runner);
  if (pending && detection.virtualizationEnabled === true) {
    await clearWindowsFirmwarePendingState(dataDir);
  }
  return {
    supportedPlatform: true,
    detection,
    guidance: mapWindowsFirmwareGuidance(detection.manufacturer, detection.model),
    pending: detection.virtualizationEnabled === true ? null : pending,
    canRestartToFirmware: detection.firmwareType === 'uefi' && detection.virtualizationEnabled !== true,
  };
}

export async function restartWindowsToFirmware(
  dataDir: string,
  detection: WindowsFirmwareDetection,
  options: { platform?: NodeJS.Platform; runner?: WindowsSystemRunner; now?: () => Date } = {},
): Promise<WindowsFirmwarePendingState> {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('WINDOWS_ONLY');
  if (detection.firmwareType !== 'uefi') throw new Error('UEFI_REQUIRED');
  if (detection.virtualizationEnabled === true) throw new Error('VIRTUALIZATION_ALREADY_ENABLED');
  const state: WindowsFirmwarePendingState = {
    phase: 'awaiting-bios-virtualization',
    manufacturer: detection.manufacturer,
    model: detection.model,
    requestedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  await writeWindowsFirmwarePendingState(dataDir, state);
  await (options.runner ?? defaultRunner)('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "Start-Process -FilePath 'shutdown.exe' -Verb RunAs -ArgumentList '/r','/fw','/t','5','/d','p:0:0'",
  ]);
  return state;
}
