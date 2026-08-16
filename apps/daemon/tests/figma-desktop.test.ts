import { describe, expect, it, vi } from 'vitest';

import {
  FigmaDesktopClient,
  FigmaDesktopError,
  describeFigmaDesktopError,
  windowTitleMatchesFile,
} from '../src/figma-desktop.js';

type RpcBody = { jsonrpc: string; id?: number; method: string; params?: unknown };

/** Fakes the Streamable HTTP transport: every POST body is a JSON-RPC
 *  request/notification, `handler` decides the Response (JSON or SSE). */
function fakeFetch(handler: (body: RpcBody, callIndex: number) => Response) {
  let callIndex = 0;
  const calls: RpcBody[] = [];
  const headersSeen: Array<Record<string, string>> = [];
  const impl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RpcBody;
    calls.push(body);
    headersSeen.push((init?.headers as Record<string, string>) ?? {});
    const res = handler(body, callIndex);
    callIndex++;
    return res;
  });
  return { fetch: impl as unknown as typeof fetch, calls, headersSeen };
}

function jsonResponse(body: unknown, opts: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: opts.status ?? 200,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
  });
}

function sseResponse(body: unknown, opts: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
    status: opts.status ?? 200,
    headers: { 'content-type': 'text/event-stream', ...(opts.headers ?? {}) },
  });
}

function fakeExec(script: (file: string, args: string[]) => { stdout: string; stderr: string } | Promise<{ stdout: string; stderr: string }>) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const exec = vi.fn(async (file: string, args: string[]) => {
    calls.push({ file, args });
    return script(file, args);
  });
  return { exec, calls };
}

describe('FigmaDesktopClient.probe', () => {
  it('returns ok:true with tool names on a healthy handshake', async () => {
    const { fetch } = fakeFetch((body) => {
      if (body.method === 'initialize') {
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {} }, { headers: { 'mcp-session-id': 'sess-1' } });
      }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (body.method === 'tools/list') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: [{ name: 'get_design_context' }, { name: 'get_metadata' }] },
        });
      }
      throw new Error(`unexpected method ${body.method}`);
    });
    const client = new FigmaDesktopClient({ fetch });
    await expect(client.probe()).resolves.toEqual({ ok: true, tools: ['get_design_context', 'get_metadata'] });
  });

  it('maps ECONNREFUSED to ok:false with Vietnamese "chưa chạy" guidance', async () => {
    const refused = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:3845');
    });
    const client = new FigmaDesktopClient({ fetch: refused as unknown as typeof fetch });
    const result = await client.probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Figma Desktop chưa chạy/);
  });
});

describe('FigmaDesktopClient.callTool', () => {
  it('sends the mcp-session-id header, parses SSE content into text+images, and maps isError to tool_error', async () => {
    const { fetch, calls, headersSeen } = fakeFetch((body) => {
      if (body.method === 'initialize') {
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {} }, { headers: { 'mcp-session-id': 'sess-42' } });
      }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (body.method === 'tools/call') {
        const params = body.params as { name: string };
        if (params.name === 'get_design_context') {
          return sseResponse({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [
                { type: 'text', text: 'layout: flex' },
                { type: 'image', mimeType: 'image/png', data: 'AAA=' },
                { type: 'text', text: 'color: #fff' },
              ],
            },
          });
        }
        if (params.name === 'broken_tool') {
          return jsonResponse({
            jsonrpc: '2.0',
            id: body.id,
            result: { isError: true, content: [{ type: 'text', text: 'Node not found' }] },
          });
        }
      }
      throw new Error(`unexpected call ${body.method}`);
    });
    const client = new FigmaDesktopClient({ fetch });

    const result = await client.callTool('get_design_context', { nodeId: '1:2' });
    expect(result).toEqual({ text: 'layout: flex\ncolor: #fff', images: [{ mimeType: 'image/png', data: 'AAA=' }] });

    const toolCallIndex = calls.findIndex((c) => c.method === 'tools/call');
    expect(headersSeen[toolCallIndex]?.['mcp-session-id']).toBe('sess-42');

    let thrown: unknown;
    try {
      await client.callTool('broken_tool', {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FigmaDesktopError);
    expect((thrown as FigmaDesktopError).kind).toBe('tool_error');
    expect((thrown as FigmaDesktopError).message).toBe('Node not found');
  });

  it('re-initializes exactly once when the server reports an unknown/expired session', async () => {
    let sessionCounter = 0;
    let toolCallAttempts = 0;
    const { fetch, calls } = fakeFetch((body) => {
      if (body.method === 'initialize') {
        sessionCounter++;
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {} }, { headers: { 'mcp-session-id': `sess-${sessionCounter}` } });
      }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (body.method === 'tools/call') {
        toolCallAttempts++;
        if (toolCallAttempts === 1) {
          return new Response('Session not found', { status: 404, headers: { 'content-type': 'text/plain' } });
        }
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } });
      }
      throw new Error(`unexpected call ${body.method}`);
    });
    const client = new FigmaDesktopClient({ fetch });

    const result = await client.callTool('get_metadata', { nodeId: '1:1' });
    expect(result.text).toBe('ok');
    expect(toolCallAttempts).toBe(2);
    expect(sessionCounter).toBe(2);
    expect(calls.filter((c) => c.method === 'initialize')).toHaveLength(2);
  });
});

describe('FigmaDesktopClient.ensureActiveFile', () => {
  it('returns "already" without opening figma:// when the window title already matches', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: '[Lib v1.0 - MB Component] NAB OMNI SME – Figma', stderr: '' }));
    const client = new FigmaDesktopClient({ platform: 'darwin', exec });
    const result = await client.ensureActiveFile({ fileKey: 'ABC123', name: '[Lib v1.0 - MB Component] NAB OMNI SME' });
    expect(result).toBe('already');
    expect(calls.some((c) => c.file === 'open')).toBe(false);
  });

  it('opens figma://file/<key> and polls (1000ms each) until the window title matches', async () => {
    const titles = ['Other File – Figma', 'Other File – Figma', 'Target File – Figma'];
    let titleIdx = 0;
    const openCalls: string[][] = [];
    const exec = vi.fn(async (file: string, args: string[]) => {
      if (file === 'osascript') {
        const stdout = titles[Math.min(titleIdx, titles.length - 1)] ?? '';
        titleIdx++;
        return { stdout, stderr: '' };
      }
      if (file === 'open') openCalls.push(args);
      return { stdout: '', stderr: '' };
    });
    const sleeps: number[] = [];
    const client = new FigmaDesktopClient({
      platform: 'darwin',
      exec: exec as unknown as (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    const result = await client.ensureActiveFile({ fileKey: 'ABC123', name: 'Target File' });
    expect(result).toBe('switched');
    expect(openCalls).toEqual([['figma://file/ABC123']]);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it('throws switch_timeout, driven by an injected now(), when the title never matches', async () => {
    const exec = vi.fn(async (file: string) => {
      if (file === 'osascript') return { stdout: 'Wrong File – Figma', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    let currentTime = 0;
    const sleeps: number[] = [];
    const client = new FigmaDesktopClient({
      platform: 'darwin',
      exec: exec as unknown as (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      now: () => {
        currentTime += 6_000;
        return currentTime;
      },
    });

    let thrown: unknown;
    try {
      await client.ensureActiveFile({ fileKey: 'ABC123', name: 'Target File' }, 15_000);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FigmaDesktopError);
    expect((thrown as FigmaDesktopError).kind).toBe('switch_timeout');
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it('falls back to nodeId probing when the window title cannot be read (no Automation permission)', async () => {
    const exec = vi.fn(async (file: string) => {
      if (file === 'osascript') throw new Error('not authorized to send Apple events');
      if (file === 'open') return { stdout: '', stderr: '' };
      throw new Error(`unexpected exec ${file}`);
    });
    let getMetadataCalls = 0;
    const { fetch } = fakeFetch((body) => {
      if (body.method === 'initialize') {
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {} }, { headers: { 'mcp-session-id': 'sess-9' } });
      }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (body.method === 'tools/call') {
        getMetadataCalls++;
        if (getMetadataCalls === 1) {
          return jsonResponse({
            jsonrpc: '2.0',
            id: body.id,
            result: { isError: true, content: [{ type: 'text', text: 'Node not found in current file' }] },
          });
        }
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: '<component id="10:1" name="Button" description=""/>' }] },
        });
      }
      throw new Error(`unexpected call ${body.method}`);
    });
    const client = new FigmaDesktopClient({
      platform: 'darwin',
      exec: exec as unknown as (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
      fetch,
      sleep: async () => {},
    });

    const result = await client.ensureActiveFile({
      fileKey: 'XYZ999',
      name: '[Lib] Some File',
      probeNodeId: '10:1',
      probeName: 'Button',
    });
    expect(result).toBe('switched');
    expect(getMetadataCalls).toBe(2);
  });

  it('throws switch_unsupported on a platform without a figma:// opener', async () => {
    const client = new FigmaDesktopClient({ platform: 'linux' });
    let thrown: unknown;
    try {
      await client.ensureActiveFile({ fileKey: 'ABC', name: 'Some File' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FigmaDesktopError);
    expect((thrown as FigmaDesktopError).kind).toBe('switch_unsupported');
  });
});

describe('windowTitleMatchesFile', () => {
  it('matches case-insensitively across a leading/trailing " – Figma" suffix', () => {
    expect(
      windowTitleMatchesFile(
        '[Lib v1.0 - MB Component] NAB OMNI SME – Figma',
        '[Lib v1.0 - MB Component] NAB OMNI SME',
      ),
    ).toBe(true);
    expect(windowTitleMatchesFile('SOME FILE – Figma', 'some file')).toBe(true);
    expect(windowTitleMatchesFile('Completely Different', 'Some File')).toBe(false);
  });

  it('treats null/undefined/empty as never matching', () => {
    expect(windowTitleMatchesFile(null, 'some file')).toBe(false);
    expect(windowTitleMatchesFile(undefined, 'some file')).toBe(false);
    expect(windowTitleMatchesFile('Some Title', undefined)).toBe(false);
    expect(windowTitleMatchesFile('', '')).toBe(false);
  });
});

describe('describeFigmaDesktopError', () => {
  it('renders the fixed Vietnamese copy for unavailable/switch_unsupported and passes through message otherwise', () => {
    expect(describeFigmaDesktopError(new FigmaDesktopError('unavailable', 'x'))).toMatch(/chưa chạy hoặc chưa bật Dev Mode MCP/);
    expect(describeFigmaDesktopError(new FigmaDesktopError('switch_timeout', 'Hết giờ ABC'))).toBe('Hết giờ ABC');
    expect(describeFigmaDesktopError(new FigmaDesktopError('switch_unsupported', 'x'))).toMatch(/Không tự chuyển file Figma/);
    expect(describeFigmaDesktopError(new FigmaDesktopError('tool_error', 'Node missing'))).toBe('Node missing');
    expect(describeFigmaDesktopError(new FigmaDesktopError('protocol', 'Bad response'))).toBe('Bad response');
    expect(describeFigmaDesktopError(new Error('plain'))).toBe('plain');
    expect(describeFigmaDesktopError('raw string')).toBe('raw string');
  });
});
