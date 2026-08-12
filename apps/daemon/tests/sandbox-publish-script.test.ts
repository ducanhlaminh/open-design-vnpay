import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('sandbox image publisher', () => {
  it('passes both pinned agent CLI versions into the multi-arch build', () => {
    const script = readFileSync(
      path.resolve(process.cwd(), '../../skills/ui-react/builder/push-ghcr.sh'),
      'utf8',
    );

    expect(script).toContain('sandbox/claude.version');
    expect(script).toContain('sandbox/codex.version');
    expect(script).toContain('--build-arg CLAUDE_CODE_VERSION="$claude_version"');
    expect(script).toContain('--build-arg CODEX_VERSION="$codex_version"');
  });
});
