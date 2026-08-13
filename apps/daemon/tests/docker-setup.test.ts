import { describe, expect, it } from 'vitest';
import {
  MAC_DOCKER_INSTALLER_APPLESCRIPT,
  dockerDesktopMacDownload,
  dockerDesktopWindowsDownload,
  dockerDesktopWindowsDownloadCommand,
  dockerDesktopWindowsInstallArgs,
  dockerDesktopWindowsPaths,
} from '../src/docker-setup.js';

describe('Docker Desktop setup on macOS', () => {
  it('downloads the official image matching the Mac architecture', () => {
    expect(dockerDesktopMacDownload('arm64')).toEqual({
      arch: 'arm64',
      url: 'https://desktop.docker.com/mac/main/arm64/Docker.dmg',
    });
    expect(dockerDesktopMacDownload('x64')).toEqual({
      arch: 'amd64',
      url: 'https://desktop.docker.com/mac/main/amd64/Docker.dmg',
    });
  });

  it('uses the native macOS administrator dialog instead of background Homebrew', () => {
    expect(MAC_DOCKER_INSTALLER_APPLESCRIPT).toContain('with administrator privileges');
    expect(MAC_DOCKER_INSTALLER_APPLESCRIPT).toContain('quoted form of installerPath');
    expect(MAC_DOCKER_INSTALLER_APPLESCRIPT).not.toContain('brew');
    expect(MAC_DOCKER_INSTALLER_APPLESCRIPT).not.toContain('sudo');
  });
});

describe('Docker Desktop setup on Windows', () => {
  it('downloads the official installer matching the Windows architecture', () => {
    expect(dockerDesktopWindowsDownload('x64')).toEqual({
      arch: 'amd64',
      url: 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe',
    });
    expect(dockerDesktopWindowsDownload('arm64')).toEqual({
      arch: 'arm64',
      url: 'https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe',
    });
  });

  it('uses the recommended per-user WSL 2 installation without requiring WinGet', () => {
    expect(dockerDesktopWindowsInstallArgs()).toEqual([
      'install',
      '--user',
      '--accept-license',
      '--backend=wsl-2',
    ]);
  });

  it('embeds escaped download values in the PowerShell command instead of relying on empty positional args', () => {
    const command = dockerDesktopWindowsDownloadCommand(
      'https://desktop.docker.com/Docker Installer.exe',
      "C:\\Users\\O'Brien\\Docker Desktop Installer.exe",
    );
    expect(command).toContain("-Uri 'https://desktop.docker.com/Docker Installer.exe'");
    expect(command).toContain("-OutFile 'C:\\Users\\O''Brien\\Docker Desktop Installer.exe'");
    expect(command).not.toContain('$args');
  });

  it('finds both per-user and all-users Docker Desktop installations', () => {
    expect(dockerDesktopWindowsPaths({
      LOCALAPPDATA: 'C:\\Users\\designer\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
    })).toEqual([
      'C:\\Users\\designer\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe',
      'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
      'C:\\Users\\designer\\AppData\\Local\\Docker\\Docker Desktop.exe',
    ]);
  });
});
