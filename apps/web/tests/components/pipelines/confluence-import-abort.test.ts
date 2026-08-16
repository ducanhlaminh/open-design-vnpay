// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONFLUENCE_IMPORT_BATCH_SIZE, ConfluenceImportBatchError, importConfluenceInBatches } from '../../../src/components/pipelines/ConfluenceTreeImport';

afterEach(() => vi.unstubAllGlobals());

const refs = Array.from({ length: CONFLUENCE_IMPORT_BATCH_SIZE * 3 }, (_, i) => `page-${i}`);
const okBody = (n: number) => new Response(JSON.stringify({ imported: n, updated: 0, pages: [] }), { status: 200 });

describe('importConfluenceInBatches + AbortSignal', () => {
  it('bấm Dừng giữa chừng: lô đang bay bị huỷ, lô sau KHÔNG gửi, ném aborted=true với succeededRefs của các lô đã xong', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/cancel')) return Promise.resolve(new Response(JSON.stringify({ ok: true, cancelled: true }), { status: 200 }));
      const call = calls.filter((value) => !value.endsWith('/cancel')).length;
      if (call === 1) return Promise.resolve(okBody(CONFLUENCE_IMPORT_BATCH_SIZE));
      // Lô 2: treo cho tới khi bị abort → reject như fetch thật.
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }));
    const progress: number[] = [];
    const run = importConfluenceInBatches('app', refs, (done) => progress.push(done), [], controller.signal);
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfluenceImportBatchError);
    expect((err as ConfluenceImportBatchError).aborted).toBe(true);
    expect((err as ConfluenceImportBatchError).succeededRefs).toEqual(refs.slice(0, CONFLUENCE_IMPORT_BATCH_SIZE));
    expect(calls.filter((url) => !url.endsWith('/cancel'))).toHaveLength(2);
    expect(calls.some((url) => url.endsWith('/cancel'))).toBe(true);
    expect(progress).toEqual([0, CONFLUENCE_IMPORT_BATCH_SIZE]);
  });

  it('không có signal → chạy hết như cũ; lỗi HTTP thường KHÔNG mang aborted', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/cancel')) return Promise.resolve(new Response('{}', { status: 200 }));
      call++;
      return Promise.resolve(call === 3 ? new Response(JSON.stringify({ error: 'boom' }), { status: 502 }) : okBody(1));
    }));
    const err = await importConfluenceInBatches('app', refs).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfluenceImportBatchError);
    expect((err as ConfluenceImportBatchError).aborted).toBe(false);
    expect((err as ConfluenceImportBatchError).succeededRefs).toHaveLength(CONFLUENCE_IMPORT_BATCH_SIZE * 2);
  });

  it('cancel tới sau commit boundary: daemon trả cancelled=false nên client chờ và nhận batch thành công', async () => {
    const controller = new AbortController();
    let releaseImport!: () => void;
    const importGate = new Promise<void>((resolve) => { releaseImport = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/cancel')) {
        return new Response(JSON.stringify({ ok: true, cancelled: false, phase: 'committing' }), { status: 200 });
      }
      await importGate;
      return okBody(1);
    }));
    const run = importConfluenceInBatches('app', ['page-1'], undefined, [], controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseImport();
    await expect(run).resolves.toMatchObject({ imported: 1 });
  });
});
