import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIGMA_TOOLS_USAGE, runFigmaToolCli } from '../src/tools-figma-cli.js';

const ORIGINAL_ENV = { ...process.env };

describe('figma tool CLI', () => {
  let stdoutWrite: { mockRestore: () => void };
  let stderrWrite: { mockRestore: () => void };
  let stdoutOutput: string[];
  let stderrOutput: string[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    stdoutOutput = [];
    stderrOutput = [];
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput.push(String(chunk));
      return true;
    });
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput.push(String(chunk));
      return true;
    });
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        ok: true,
        tool: 'design-context',
        fileKey: 'kvQYEli6ij2mZ65mSywnFp',
        nodeId: '10:1',
        switched: 'already',
        cached: false,
        text: '<div>design context</div>',
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    process.env = ORIGINAL_ENV;
  });

  it('POSTs to the right endpoint with a Bearer token and JSON body', async () => {
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456/base/';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';

    const result = await runFigmaToolCli([
      'design-context',
      '--file', 'kvQYEli6ij2mZ65mSywnFp',
      '--node', '10:1',
      '--languages', 'typescript',
      '--frameworks', 'react',
    ]);

    expect(result.exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7456/base/api/tools/figma/design-context',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer agent-run-token',
          Accept: 'application/json',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          fileKey: 'kvQYEli6ij2mZ65mSywnFp',
          nodeId: '10:1',
          clientLanguages: 'typescript',
          clientFrameworks: 'react',
        }),
      }),
    );
  });

  it('without --json prints the raw text so an agent can read it directly', async () => {
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';

    const result = await runFigmaToolCli(['design-context', '--file', 'ABC123', '--node', '10:1']);

    expect(result.exitCode).toBe(0);
    expect(stdoutOutput.join('')).toBe('<div>design context</div>\n');
    expect(stderrOutput.join('')).toBe('');
  });

  it('without --json prints the screenshot path', async () => {
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      tool: 'screenshot',
      fileKey: 'ABC123',
      nodeId: '10:1',
      switched: 'switched',
      cached: false,
      path: '.figma-catalog/shots/ABC123/10-1.png',
      mimeType: 'image/png',
    }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));

    const result = await runFigmaToolCli(['screenshot', '--file', 'ABC123', '--node', '10:1']);

    expect(result.exitCode).toBe(0);
    expect(stdoutOutput.join('')).toBe('.figma-catalog/shots/ABC123/10-1.png\n');
  });

  it('--json prints the whole response body as JSON', async () => {
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';

    const result = await runFigmaToolCli(['design-context', '--file', 'ABC123', '--node', '10:1', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join(''))).toEqual({
      ok: true,
      tool: 'design-context',
      fileKey: 'kvQYEli6ij2mZ65mSywnFp',
      nodeId: '10:1',
      switched: 'already',
      cached: false,
      text: '<div>design context</div>',
    });
  });

  it('missing --file exits 1 with a stderr JSON error and does not call fetch', async () => {
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';

    const result = await runFigmaToolCli(['design-context', '--node', '10:1']);

    expect(result.exitCode).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    const stderrBody = JSON.parse(stderrOutput.join(''));
    expect(stderrBody.ok).toBe(false);
    expect(stderrBody.error.message).toContain('--file');
  });

  it('bare --help (no subcommand) prints usage without calling fetch', async () => {
    // Mirrors tools-design-systems-cli.ts: a subcommand-less invocation is
    // still a usage error (exit 1), even though it prints the same usage
    // text `--help` would. `<command> --help` (tested below) exits 0.
    const result = await runFigmaToolCli(['--help']);

    expect(result.exitCode).toBe(1);
    expect(stdoutOutput.join('')).toBe(FIGMA_TOOLS_USAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('"<command> --help" prints usage and exits 0 without calling fetch', async () => {
    const result = await runFigmaToolCli(['design-context', '--help']);

    expect(result.exitCode).toBe(0);
    expect(stdoutOutput.join('')).toBe(FIGMA_TOOLS_USAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces daemon error responses on stderr with exit 1', async () => {
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: 'FIGMA_FILE_DENIED', message: 'File ABC123 không nằm trong danh sách link Figma của App.' },
    }), { headers: { 'Content-Type': 'application/json' }, status: 403 }));

    const result = await runFigmaToolCli(['design-context', '--file', 'ABC123', '--node', '10:1']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(stderrOutput.join(''))).toEqual({
      ok: false,
      status: 403,
      error: { code: 'FIGMA_FILE_DENIED', message: 'File ABC123 không nằm trong danh sách link Figma của App.' },
    });
  });
});
