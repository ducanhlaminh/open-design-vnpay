import { describe, expect, it } from 'vitest';
import {
  MAC_DOCKER_INSTALLER_APPLESCRIPT,
  dockerDesktopMacDownload,
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
